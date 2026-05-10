// SPDX-License-Identifier: Apache-2.0
package main

import "github.com/spf13/cobra"

func newServiceCmd() *cobra.Command {
	return &cobra.Command{Use: "service", Short: "Manage system service install/uninstall"}
}
