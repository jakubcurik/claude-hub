package telemetry

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"sync"
	"time"
)

const (
	defaultFlushInterval = 15 * time.Second
	defaultBatchSize     = 500
	defaultHTTPTimeout   = 30 * time.Second
	disableAfterEmptyAcks = 10
)

// Config nese runtime nastavení forwarderu.
type Config struct {
	APIEndpoint  string
	PairingToken string
	// OnPersistentDisable se zavolá, když API opakovaně vrací accepted=0
	// (odpovídá owner-disabled). Daemon na to může reagovat odpojením OTLP
	// receiveru/Claude Code env, aby nešlo plýtvat CPU u klienta.
	OnPersistentDisable func()
}

// Forwarder periodicky drainuje buffer a posílá batche do centrálního API.
type Forwarder struct {
	buffer *Buffer
	cfg    Config
	client *http.Client
	logger *slog.Logger

	mu         sync.Mutex
	lastFlush  time.Time
	lastError  string
	emptyAcks  int
	disabled   bool
}

func NewForwarder(buffer *Buffer, cfg Config, logger *slog.Logger) *Forwarder {
	return &Forwarder{
		buffer: buffer,
		cfg:    cfg,
		client: &http.Client{Timeout: defaultHTTPTimeout},
		logger: logger,
	}
}

// Run blokuje až do zrušení kontextu. Spouštějte v samostatné goroutině.
func (f *Forwarder) Run(ctx context.Context) {
	ticker := time.NewTicker(defaultFlushInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			// Pokus o flush před vypnutím, abychom nezahodili rozdělanou frontu.
			_ = f.flush(ctx)
			return
		case <-ticker.C:
			if err := f.flush(ctx); err != nil {
				f.logger.Warn("telemetry flush failed", "error", err)
			}
		}
	}
}

// LastFlush vrátí čas posledního úspěšného flushe a poslední chybu (pokud byla).
func (f *Forwarder) LastFlush() (time.Time, string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.lastFlush, f.lastError
}

// SetAPIEndpoint změní centrální API URL za běhu. Volá se po pairingu nebo
// po EnableTelemetry — daemon nemusí restartovat. Reset emptyAcks/disabled
// dává smysl, protože owner mohl mezitím re-enable.
func (f *Forwarder) SetAPIEndpoint(endpoint string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.cfg.APIEndpoint = endpoint
	f.emptyAcks = 0
	f.disabled = false
}

// APIEndpoint vrátí aktuální URL (může být prázdná pokud daemon ještě není pair).
func (f *Forwarder) APIEndpoint() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.cfg.APIEndpoint
}

// QueueDepth vrátí počet bajtů ve frontě k odeslání.
func (f *Forwarder) QueueDepth() int64 {
	depth, err := f.buffer.Depth()
	if err != nil {
		return 0
	}
	return depth
}

// Disabled vrátí true, pokud forwarder rozhodl, že telemetrii pro tohoto
// uživatele přestal odesílat (owner disabled).
func (f *Forwarder) Disabled() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.disabled
}

func (f *Forwarder) flush(ctx context.Context) error {
	f.mu.Lock()
	endpoint := f.cfg.APIEndpoint
	token := f.cfg.PairingToken
	f.mu.Unlock()
	if endpoint == "" || token == "" {
		// Daemon ještě není spárovaný — necháme buffer růst, případně ho ring drop ořeže.
		return nil
	}

	items, commit, err := f.buffer.DrainBatch(defaultBatchSize)
	if err != nil {
		return err
	}
	if len(items) == 0 {
		return nil
	}

	body, err := json.Marshal(map[string]any{"items": items})
	if err != nil {
		return err
	}

	url := endpoint + "/v1/telemetry/ingest"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)

	res, err := f.client.Do(req)
	if err != nil {
		f.recordError(err.Error())
		return err
	}
	defer res.Body.Close()

	switch {
	case res.StatusCode >= 200 && res.StatusCode < 300:
		var parsed struct {
			Accepted int `json:"accepted"`
			Dropped  int `json:"dropped"`
		}
		respBody, _ := io.ReadAll(res.Body)
		_ = json.Unmarshal(respBody, &parsed)
		if err := commit(); err != nil {
			return fmt.Errorf("commit batch failed: %w", err)
		}
		f.recordSuccess(parsed.Accepted)
		return nil
	case res.StatusCode >= 400 && res.StatusCode < 500:
		// Permanent error (špatný payload, neplatný token). Smažeme batch a logneme.
		respBody, _ := io.ReadAll(res.Body)
		f.logger.Warn("telemetry batch rejected", "status", res.StatusCode, "body", string(respBody))
		f.recordError(fmt.Sprintf("HTTP %d", res.StatusCode))
		// Pro 401/403 batch nezahazujeme — token se může obnovit příští pairing.
		if res.StatusCode == http.StatusUnauthorized || res.StatusCode == http.StatusForbidden {
			return errors.New("unauthorized")
		}
		_ = commit()
		return fmt.Errorf("api rejected batch: %d", res.StatusCode)
	default:
		// 5xx — necháme batch, příští tick retry-ne.
		f.recordError(fmt.Sprintf("HTTP %d", res.StatusCode))
		return fmt.Errorf("api transient error: %d", res.StatusCode)
	}
}

func (f *Forwarder) recordSuccess(accepted int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.lastFlush = time.Now()
	f.lastError = ""
	if accepted == 0 {
		f.emptyAcks++
		if f.emptyAcks >= disableAfterEmptyAcks && !f.disabled {
			f.disabled = true
			if f.cfg.OnPersistentDisable != nil {
				go f.cfg.OnPersistentDisable()
			}
		}
		return
	}
	f.emptyAcks = 0
	f.disabled = false
}

func (f *Forwarder) recordError(message string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.lastError = message
}
