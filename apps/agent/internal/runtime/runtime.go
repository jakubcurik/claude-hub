// SPDX-License-Identifier: Apache-2.0
package runtime

import (
	"context"
	"errors"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/rs/zerolog"

	"github.com/animato/claude-hub/agent/internal/api/local"
	"github.com/animato/claude-hub/agent/internal/config"
	"github.com/animato/claude-hub/agent/internal/storage/agenttoken"
	"github.com/animato/claude-hub/agent/internal/storage/keychain"
	"github.com/animato/claude-hub/agent/internal/wss"
)

type Runtime struct {
	cfg   *config.Config
	store keychain.Store
	log   zerolog.Logger

	mu     sync.Mutex
	online bool
}

func New(cfg *config.Config, store keychain.Store, log zerolog.Logger) *Runtime {
	return &Runtime{cfg: cfg, store: store, log: log}
}

func (r *Runtime) Status() local.StatusResponse {
	hub, _ := r.store.Get("hub_url")
	_, errTok := r.store.Get("device_token")
	r.mu.Lock()
	online := r.online
	r.mu.Unlock()
	return local.StatusResponse{
		Paired:       errTok == nil,
		HubURL:       hub,
		AgentVersion: r.cfg.AgentVersion(),
		Online:       online,
	}
}

func (r *Runtime) Pair(_, _ string) error {
	return errors.New("Pair is invoked through the CLI subcommand, not the local API in MVP")
}

func (r *Runtime) Start(ctx context.Context) error {
	tok, err := agenttoken.Ensure(r.cfg.TokenFile)
	if err != nil {
		return err
	}
	apiSrv := local.NewServer(tok, r)
	ln, err := net.Listen("tcp", r.cfg.LocalBindAddr)
	if err != nil {
		return err
	}
	httpSrv := &http.Server{
		Handler:           apiSrv.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() { _ = httpSrv.Serve(ln) }()
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = httpSrv.Shutdown(shutdownCtx)
	}()

	go r.runWSS(ctx)

	<-ctx.Done()
	return nil
}

func (r *Runtime) runWSS(ctx context.Context) {
	for {
		if ctx.Err() != nil {
			return
		}
		token, err := r.store.Get("device_token")
		if err != nil || token == "" {
			select {
			case <-time.After(5 * time.Second):
			case <-ctx.Done():
				return
			}
			continue
		}
		hub, _ := r.store.Get("hub_url")
		wsURL := strings.Replace(hub, "http", "ws", 1) + "/ws"
		client := wss.NewClient(wsURL, token, wss.NewRouter(), r.log)
		r.setOnline(true)
		if err := client.RunOnce(ctx); err != nil {
			r.log.Warn().Err(err).Msg("wss disconnected")
		}
		r.setOnline(false)
		select {
		case <-time.After(2 * time.Second):
		case <-ctx.Done():
			return
		}
	}
}

func (r *Runtime) setOnline(v bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.online = v
}
