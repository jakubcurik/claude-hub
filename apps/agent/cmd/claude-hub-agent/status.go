// SPDX-License-Identifier: Apache-2.0
package main

import "github.com/spf13/cobra"

func newStatusCmd() *cobra.Command {
	return &cobra.Command{Use: "status", Short: "Show agent status"}
}
