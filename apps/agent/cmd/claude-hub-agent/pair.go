// SPDX-License-Identifier: Apache-2.0
package main

import "github.com/spf13/cobra"

func newPairCmd() *cobra.Command {
	return &cobra.Command{Use: "pair", Short: "Pair this agent with a Claude Hub server"}
}
