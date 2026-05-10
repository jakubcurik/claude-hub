// SPDX-License-Identifier: Apache-2.0
package runtime

import (
	"context"
	"io"
	"testing"
	"time"

	"github.com/rs/zerolog"
	"github.com/stretchr/testify/require"

	"github.com/animato/claude-hub/agent/internal/config"
	"github.com/animato/claude-hub/agent/internal/storage/keychain"
)

type memStore struct{ kv map[string]string }

func (m *memStore) Set(k, v string) error { m.kv[k] = v; return nil }
func (m *memStore) Get(k string) (string, error) {
	v, ok := m.kv[k]
	if !ok {
		return "", keychain.ErrNotFound
	}
	return v, nil
}
func (m *memStore) Delete(k string) error { delete(m.kv, k); return nil }

func TestStartReturnsCleanlyOnContextCancel(t *testing.T) {
	cfg := &config.Config{
		LocalBindAddr: "127.0.0.1:0",
		HubDataDir:    t.TempDir(),
		TokenFile:     t.TempDir() + "/agent.token",
	}
	log := zerolog.New(io.Discard)
	store := &memStore{kv: map[string]string{}}
	rt := New(cfg, store, log)
	ctx, cancel := context.WithCancel(context.Background())
	errCh := make(chan error, 1)
	go func() { errCh <- rt.Start(ctx) }()
	time.Sleep(100 * time.Millisecond)
	cancel()
	select {
	case err := <-errCh:
		require.True(t, err == nil || err == context.Canceled)
	case <-time.After(2 * time.Second):
		t.Fatal("Start did not return after cancel")
	}
}
