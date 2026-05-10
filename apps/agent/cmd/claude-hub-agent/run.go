// SPDX-License-Identifier: Apache-2.0
package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	"github.com/spf13/cobra"

	"github.com/animato/claude-hub/agent/internal/config"
	"github.com/animato/claude-hub/agent/internal/logging"
	"github.com/animato/claude-hub/agent/internal/runtime"
	"github.com/animato/claude-hub/agent/internal/storage/keychain"
)

func newRunCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "run",
		Short: "Run the agent in the foreground",
		RunE: func(cmd *cobra.Command, _ []string) error {
			cfg, err := config.Load()
			if err != nil {
				return err
			}
			if err := os.MkdirAll(cfg.HubDataDir, 0o700); err != nil {
				return err
			}
			f, err := os.OpenFile(cfg.LogFile, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
			if err != nil {
				return err
			}
			defer f.Close()
			log := logging.New(f, os.Stderr, "info")
			store := &keychain.KeyringStore{Service: "claude-hub-agent"}

			rt := runtime.New(cfg, store, log)
			ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
			defer cancel()
			log.Info().Str("addr", cfg.LocalBindAddr).Msg("agent starting")
			return rt.Start(ctx)
		},
	}
}
