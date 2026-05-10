// SPDX-License-Identifier: Apache-2.0
package main

import (
	"fmt"
	"os"
)

var version = "0.0.0-dev"

func main() {
	if err := newRootCmd().Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
