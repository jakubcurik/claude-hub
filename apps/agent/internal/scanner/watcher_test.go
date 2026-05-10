// SPDX-License-Identifier: Apache-2.0
package scanner

import (
	"context"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

func TestWatcher_DebouncesRapidChanges(t *testing.T) {
	root := t.TempDir()
	var calls int32
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	w := NewWatcher(root, 200*time.Millisecond, func() {
		atomic.AddInt32(&calls, 1)
	})
	errCh := make(chan error, 1)
	go func() { errCh <- w.Run(ctx) }()
	time.Sleep(50 * time.Millisecond)

	for i := 0; i < 5; i++ {
		if err := os.WriteFile(filepath.Join(root, "x.txt"), []byte{byte(i)}, 0o644); err != nil {
			t.Fatal(err)
		}
		time.Sleep(20 * time.Millisecond)
	}
	time.Sleep(400 * time.Millisecond)

	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Fatalf("expected exactly 1 debounced call, got %d", got)
	}
	cancel()
	<-errCh
}

func TestWatcher_StopsCleanly(t *testing.T) {
	root := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	w := NewWatcher(root, 100*time.Millisecond, func() {})
	done := make(chan error, 1)
	go func() { done <- w.Run(ctx) }()
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("watcher did not stop")
	}
}
