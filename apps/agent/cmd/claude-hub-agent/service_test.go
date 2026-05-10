// SPDX-License-Identifier: Apache-2.0
package main

import (
	"bytes"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestServiceHelpListsActions(t *testing.T) {
	cmd := newServiceCmd()
	var out bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetArgs([]string{"--help"})
	require.NoError(t, cmd.Execute())
	s := out.String()
	for _, w := range []string{"install", "uninstall", "start", "stop"} {
		require.Contains(t, s, w)
	}
}
