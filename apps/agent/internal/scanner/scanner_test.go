// SPDX-License-Identifier: Apache-2.0
package scanner

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestNoopScannerReturnsEmpty(t *testing.T) {
	s := NewNoop()
	items, err := s.Scan(t.TempDir())
	require.NoError(t, err)
	require.Empty(t, items)
}
