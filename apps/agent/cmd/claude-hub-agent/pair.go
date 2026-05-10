// SPDX-License-Identifier: Apache-2.0
package main

import (
	"fmt"
	"os"
	"runtime"

	"github.com/spf13/cobra"

	"github.com/animato/claude-hub/agent/internal/pairing"
	"github.com/animato/claude-hub/agent/internal/storage/keychain"
)

func newPairCmd() *cobra.Command {
	var hub, pin string
	cmd := &cobra.Command{
		Use:   "pair",
		Short: "Pair this daemon with a hub using a 6-digit pin",
		RunE: func(cmd *cobra.Command, _ []string) error {
			if hub == "" || pin == "" {
				return fmt.Errorf("--hub and --pin are required")
			}
			host, err := os.Hostname()
			if err != nil {
				host = "unknown"
			}
			osName := goosToDaemonOS(runtime.GOOS)
			store := &keychain.KeyringStore{Service: "claude-hub-agent"}
			if err := pairing.Pair(hub, pin, host, osName, version, store); err != nil {
				return err
			}
			fmt.Fprintln(cmd.OutOrStdout(), "Paired successfully.")
			return nil
		},
	}
	cmd.Flags().StringVar(&hub, "hub", "", "Hub URL (e.g. https://hub.company.tld)")
	cmd.Flags().StringVar(&pin, "pin", "", "6-digit pairing pin")
	return cmd
}

func goosToDaemonOS(g string) string {
	switch g {
	case "darwin":
		return "macos"
	case "windows":
		return "windows"
	default:
		return "linux"
	}
}
