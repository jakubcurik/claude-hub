// SPDX-License-Identifier: Apache-2.0
package main

import (
	"bytes"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestRootHelpListsSubcommands(t *testing.T) {
	cmd := newRootCmd()
	var out bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetArgs([]string{"--help"})
	require.NoError(t, cmd.Execute())
	s := out.String()
	require.Contains(t, s, "run")
	require.Contains(t, s, "pair")
	require.Contains(t, s, "service")
	require.Contains(t, s, "status")
}
