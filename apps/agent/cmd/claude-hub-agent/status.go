// SPDX-License-Identifier: Apache-2.0
package main

import (
	"fmt"
	"io"
	"net/http"
	"os"

	"github.com/spf13/cobra"

	"github.com/animato/claude-hub/agent/internal/config"
)

func newStatusCmd() *cobra.Command {
	cfg, _ := config.Load()
	addr := "http://" + cfg.LocalBindAddr
	return newStatusCmdWithDeps(addr, cfg.TokenFile)
}

func newStatusCmdWithDeps(baseURL, tokenPath string) *cobra.Command {
	return &cobra.Command{
		Use:   "status",
		Short: "Print agent status as JSON",
		RunE: func(cmd *cobra.Command, _ []string) error {
			tok, err := os.ReadFile(tokenPath)
			if err != nil {
				return fmt.Errorf("read agent token: %w", err)
			}
			req, err := http.NewRequestWithContext(cmd.Context(), http.MethodGet, baseURL+"/v1/status", nil)
			if err != nil {
				return err
			}
			req.Header.Set("Authorization", "Bearer "+string(tok))
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				return err
			}
			defer resp.Body.Close()
			b, err := io.ReadAll(resp.Body)
			if err != nil {
				return err
			}
			_, _ = cmd.OutOrStdout().Write(b)
			return nil
		},
	}
}
