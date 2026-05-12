package telemetry

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	defaultMaxFileBytes  = 5 * 1024 * 1024  // 5 MB per JSONL segment
	defaultMaxTotalBytes = 50 * 1024 * 1024 // 50 MB total ring budget
)

// Buffer je append-only fronta serializovaná do JSONL souborů. Drží řadu
// segmentů `NNNNNNNN.jsonl`; nové položky se zapisují do nejnovějšího segmentu,
// po překročení limitu se rotuje. Forwarder drainuje celé segmenty atomicky:
// při úspěšném odeslání se segment smaže, jinak zůstává a další pokus pošle
// stejná data znovu.
type Buffer struct {
	dir          string
	maxFileBytes int64
	maxTotalBytes int64

	mu     sync.Mutex
	active *segment
}

type segment struct {
	path string
	file *os.File
	size int64
}

func NewBuffer(dir string) (*Buffer, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	return &Buffer{
		dir:           dir,
		maxFileBytes:  defaultMaxFileBytes,
		maxTotalBytes: defaultMaxTotalBytes,
	}, nil
}

// Append serializuje item a zapíše ho do aktuálního segmentu.
func (b *Buffer) Append(item BufferItem) error {
	b.mu.Lock()
	defer b.mu.Unlock()

	payload, err := json.Marshal(item)
	if err != nil {
		return err
	}
	payload = append(payload, '\n')

	if err := b.enforceTotalBudget(int64(len(payload))); err != nil {
		return err
	}

	if b.active == nil || b.active.size+int64(len(payload)) > b.maxFileBytes {
		if err := b.rotate(); err != nil {
			return err
		}
	}

	n, err := b.active.file.Write(payload)
	if err != nil {
		return err
	}
	b.active.size += int64(n)
	return nil
}

// Depth vrátí přibližný počet bajtů ve frontě (suma velikostí segmentů).
func (b *Buffer) Depth() (int64, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	entries, err := b.listSegmentsLocked()
	if err != nil {
		return 0, err
	}
	var total int64
	for _, name := range entries {
		info, err := os.Stat(filepath.Join(b.dir, name))
		if err != nil {
			continue
		}
		total += info.Size()
	}
	return total, nil
}

// DrainBatch načte první nedoručený segment a vrátí jeho položky + commit
// callback, který segment smaže. Pokud commit nezavoláme (forward selhal),
// segment zůstává a příští volání ho vrátí znovu. Aktivní (otevřený) segment
// se před drainem zavře a vystaví jako kandidát.
func (b *Buffer) DrainBatch(maxItems int) ([]BufferItem, func() error, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	if b.active != nil {
		// Zavřeme aktivní segment, ať je drainable. Příští Append otevře nový.
		if err := b.active.file.Close(); err != nil {
			return nil, nil, err
		}
		b.active = nil
	}

	segments, err := b.listSegmentsLocked()
	if err != nil {
		return nil, nil, err
	}
	if len(segments) == 0 {
		return nil, func() error { return nil }, nil
	}

	target := filepath.Join(b.dir, segments[0])
	file, err := os.Open(target)
	if err != nil {
		return nil, nil, err
	}
	defer file.Close()

	items := make([]BufferItem, 0, 128)
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var item BufferItem
		if err := json.Unmarshal(line, &item); err != nil {
			// Korupce na konci segmentu — přeskočíme, zbytek smaže commit.
			continue
		}
		items = append(items, item)
		if maxItems > 0 && len(items) >= maxItems {
			break
		}
	}
	if err := scanner.Err(); err != nil && !errors.Is(err, io.EOF) {
		return nil, nil, err
	}

	commit := func() error {
		return os.Remove(target)
	}
	return items, commit, nil
}

// Close zavře aktivní segment (pokud existuje). Buffer lze po Close znovu
// použít; další Append otevře nový segment.
func (b *Buffer) Close() error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.active != nil {
		err := b.active.file.Close()
		b.active = nil
		return err
	}
	return nil
}

func (b *Buffer) rotate() error {
	if b.active != nil {
		if err := b.active.file.Close(); err != nil {
			return err
		}
		b.active = nil
	}
	name := fmt.Sprintf("%020d.jsonl", time.Now().UnixNano())
	path := filepath.Join(b.dir, name)
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return err
	}
	b.active = &segment{path: path, file: file, size: info.Size()}
	return nil
}

func (b *Buffer) listSegmentsLocked() ([]string, error) {
	entries, err := os.ReadDir(b.dir)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		if !strings.HasSuffix(entry.Name(), ".jsonl") {
			continue
		}
		names = append(names, entry.Name())
	}
	sort.Slice(names, func(i, j int) bool {
		// Numericky podle prefixu — staré segmenty (menší timestamp) dříve.
		a, _ := strconv.ParseInt(strings.TrimSuffix(names[i], ".jsonl"), 10, 64)
		b, _ := strconv.ParseInt(strings.TrimSuffix(names[j], ".jsonl"), 10, 64)
		return a < b
	})
	return names, nil
}

// enforceTotalBudget odstraní nejstarší segmenty, dokud by přidání `incoming`
// bajtů nepřekročilo maxTotalBytes. Aktivní segment nikdy nemažeme.
func (b *Buffer) enforceTotalBudget(incoming int64) error {
	segments, err := b.listSegmentsLocked()
	if err != nil {
		return err
	}
	type seg struct {
		name string
		size int64
	}
	stats := make([]seg, 0, len(segments))
	var total int64
	for _, name := range segments {
		info, err := os.Stat(filepath.Join(b.dir, name))
		if err != nil {
			continue
		}
		stats = append(stats, seg{name: name, size: info.Size()})
		total += info.Size()
	}
	activeName := ""
	if b.active != nil {
		activeName = filepath.Base(b.active.path)
	}
	for total+incoming > b.maxTotalBytes && len(stats) > 0 {
		oldest := stats[0]
		stats = stats[1:]
		if oldest.name == activeName {
			continue
		}
		if err := os.Remove(filepath.Join(b.dir, oldest.name)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		total -= oldest.size
	}
	return nil
}
