// SPDX-License-Identifier: Apache-2.0
package agenttoken

import (
	"os"
	"runtime"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestEnsureCreatesTokenWithMode0600(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/agent.token"
	tok, err := Ensure(path)
	require.NoError(t, err)
	require.Len(t, tok, 64)

	info, err := os.Stat(path)
	require.NoError(t, err)
	if runtime.GOOS != "windows" {
		require.Equal(t, os.FileMode(0o600), info.Mode().Perm())
	}
}

func TestEnsureReadsExistingToken(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/agent.token"
	a, err := Ensure(path)
	require.NoError(t, err)
	b, err := Ensure(path)
	require.NoError(t, err)
	require.Equal(t, a, b)
}
