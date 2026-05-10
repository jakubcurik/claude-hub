// SPDX-License-Identifier: Apache-2.0
package config

import (
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestLoadDefaults(t *testing.T) {
	t.Setenv("HUB_URL", "")
	t.Setenv("AGENT_BIND_ADDR", "")
	t.Setenv("CLAUDE_HOME", "")
	t.Setenv("HOME", "/tmp/fakehome")
	cfg, err := Load()
	require.NoError(t, err)
	require.Equal(t, "127.0.0.1:7878", cfg.LocalBindAddr)
	require.Equal(t, filepath.Join("/tmp/fakehome", ".claude"), cfg.ClaudeHome)
	require.Equal(t, filepath.Join("/tmp/fakehome", ".claude-hub"), cfg.HubDataDir)
}

func TestLoadOverridesFromEnv(t *testing.T) {
	t.Setenv("HUB_URL", "https://hub.example.com")
	t.Setenv("AGENT_BIND_ADDR", "127.0.0.1:9999")
	t.Setenv("CLAUDE_HOME", "/custom/claude")
	t.Setenv("HOME", "/tmp/fakehome")
	cfg, err := Load()
	require.NoError(t, err)
	require.Equal(t, "https://hub.example.com", cfg.HubURL)
	require.Equal(t, "127.0.0.1:9999", cfg.LocalBindAddr)
	require.Equal(t, "/custom/claude", cfg.ClaudeHome)
}
