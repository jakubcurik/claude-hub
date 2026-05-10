// SPDX-License-Identifier: Apache-2.0
package logging

import (
	"bytes"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestNewWritesJSONToBoth(t *testing.T) {
	var fileBuf, stderrBuf bytes.Buffer
	log := New(&fileBuf, &stderrBuf, "info")
	log.Info().Str("evt", "hello").Msg("test")
	require.Contains(t, fileBuf.String(), `"evt":"hello"`)
	require.Contains(t, stderrBuf.String(), `"evt":"hello"`)
}
