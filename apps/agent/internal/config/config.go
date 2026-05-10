// SPDX-License-Identifier: Apache-2.0
package config

import (
	"os"
	"path/filepath"
)

type Config struct {
	HubURL        string
	LocalBindAddr string
	ClaudeHome    string
	HubDataDir    string
	LogFile       string
	TokenFile     string
}

func Load() (*Config, error) {
	home, err := userHome()
	if err != nil {
		return nil, err
	}
	cfg := &Config{
		HubURL:        os.Getenv("HUB_URL"),
		LocalBindAddr: envOr("AGENT_BIND_ADDR", "127.0.0.1:7878"),
		ClaudeHome:    envOr("CLAUDE_HOME", filepath.Join(home, ".claude")),
		HubDataDir:    filepath.Join(home, ".claude-hub"),
	}
	cfg.LogFile = filepath.Join(cfg.HubDataDir, "agent.log")
	cfg.TokenFile = filepath.Join(cfg.HubDataDir, "agent.token")
	return cfg, nil
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func userHome() (string, error) {
	if h := os.Getenv("HOME"); h != "" {
		return h, nil
	}
	return os.UserHomeDir()
}
