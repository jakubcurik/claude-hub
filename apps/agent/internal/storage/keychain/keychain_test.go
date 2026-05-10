// SPDX-License-Identifier: Apache-2.0
package keychain

import (
	"testing"

	"github.com/stretchr/testify/require"
	"github.com/zalando/go-keyring"
)

func TestKeyringStoreSetGetDelete(t *testing.T) {
	keyring.MockInit()
	s := &KeyringStore{Service: "claude-hub-agent-test"}
	require.NoError(t, s.Set("device_token", "abc123"))
	got, err := s.Get("device_token")
	require.NoError(t, err)
	require.Equal(t, "abc123", got)
	require.NoError(t, s.Delete("device_token"))
	_, err = s.Get("device_token")
	require.ErrorIs(t, err, ErrNotFound)
}

func TestFileStoreSetGetDelete(t *testing.T) {
	dir := t.TempDir()
	s, err := NewFileStore(dir+"/cred.enc", []byte("0123456789abcdef0123456789abcdef"))
	require.NoError(t, err)
	require.NoError(t, s.Set("device_token", "tok-xyz"))

	s2, err := NewFileStore(dir+"/cred.enc", []byte("0123456789abcdef0123456789abcdef"))
	require.NoError(t, err)
	got, err := s2.Get("device_token")
	require.NoError(t, err)
	require.Equal(t, "tok-xyz", got)

	require.NoError(t, s2.Delete("device_token"))
	_, err = s2.Get("device_token")
	require.ErrorIs(t, err, ErrNotFound)
}
