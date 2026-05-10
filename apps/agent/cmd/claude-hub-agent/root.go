// SPDX-License-Identifier: Apache-2.0
package main

import "github.com/spf13/cobra"

func newRootCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "claude-hub-agent",
		Short:   "Claude Hub local daemon",
		Version: version,
	}
	cmd.AddCommand(newRunCmd(), newPairCmd(), newServiceCmd(), newStatusCmd())
	return cmd
}
