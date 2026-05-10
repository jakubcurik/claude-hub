// SPDX-License-Identifier: Apache-2.0
package main

import "github.com/spf13/cobra"

func newRunCmd() *cobra.Command {
	return &cobra.Command{Use: "run", Short: "Run the agent in the foreground"}
}
