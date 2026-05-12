package claudecode

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestInstallMCPMergesIntoExistingFile(t *testing.T) {
	t.Setenv("CLAUDE_HUB_WORKSPACE_ROOTS", "")
	t.Setenv("CLAUDE_HUB_WORKSPACE_ROOT", "")

	claudeHome := t.TempDir()
	manager := NewManager(claudeHome)
	if err := manager.EnsureBaseDirs(); err != nil {
		t.Fatalf("ensure: %v", err)
	}

	// existující .mcp.json s jiným serverem
	existing := `{
  "mcpServers": {
    "existing-server": { "command": "echo", "args": ["hi"] }
  }
}`
	if err := os.WriteFile(filepath.Join(claudeHome, ".mcp.json"), []byte(existing), 0o644); err != nil {
		t.Fatalf("write existing: %v", err)
	}

	asset := CatalogAsset{
		ID:      "mcp:filesystem",
		Type:    AssetTypeMCP,
		Slug:    "filesystem",
		Name:    "Filesystem MCP",
		Version: "1.0.0",
		Risk:    RiskMedium,
		Files: []AssetFile{{
			Path: ".mcp.json",
			Content: `{
  "mcpServers": {
    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem"] }
  }
}`,
		}},
	}

	state, err := manager.Install(asset)
	if err != nil {
		t.Fatalf("install: %v", err)
	}
	if !state.Installed || !state.Enabled {
		t.Fatalf("expected installed+enabled, got %+v", state)
	}

	// Po instalaci musí .mcp.json obsahovat oba klíče
	contentBytes, _ := os.ReadFile(filepath.Join(claudeHome, ".mcp.json"))
	doc := map[string]map[string]json.RawMessage{}
	if err := json.Unmarshal(contentBytes, &doc); err != nil {
		t.Fatalf("parse merged: %v", err)
	}
	servers := doc["mcpServers"]
	if _, ok := servers["existing-server"]; !ok {
		t.Fatalf("existing-server byl ztracen")
	}
	if _, ok := servers["filesystem"]; !ok {
		t.Fatalf("nový server filesystem se nepřidal")
	}

	// Uninstall musí vrátit `existing-server`, ale smazat `filesystem`
	if _, err := manager.Uninstall(asset); err != nil {
		t.Fatalf("uninstall: %v", err)
	}
	contentBytes, _ = os.ReadFile(filepath.Join(claudeHome, ".mcp.json"))
	if err := json.Unmarshal(contentBytes, &doc); err != nil {
		t.Fatalf("parse post-uninstall: %v", err)
	}
	servers = doc["mcpServers"]
	if _, ok := servers["filesystem"]; ok {
		t.Fatalf("filesystem nebyl smazán")
	}
	if _, ok := servers["existing-server"]; !ok {
		t.Fatalf("existing-server byl smazán omylem")
	}
}

func TestToggleMCPDisableEnableRoundtrip(t *testing.T) {
	t.Setenv("CLAUDE_HUB_WORKSPACE_ROOTS", "")
	t.Setenv("CLAUDE_HUB_WORKSPACE_ROOT", "")

	manager := NewManager(t.TempDir())
	_ = manager.EnsureBaseDirs()

	asset := CatalogAsset{
		ID:      "mcp:weather",
		Type:    AssetTypeMCP,
		Slug:    "weather",
		Name:    "Weather",
		Version: "1.0.0",
		Risk:    RiskMedium,
		Files: []AssetFile{{
			Path:    ".mcp.json",
			Content: `{"mcpServers":{"weather":{"command":"node","args":["weather.js"]}}}`,
		}},
	}

	if _, err := manager.Install(asset); err != nil {
		t.Fatalf("install: %v", err)
	}
	if _, err := manager.SetEnabled(asset, false); err != nil {
		t.Fatalf("disable: %v", err)
	}

	contentBytes, _ := os.ReadFile(filepath.Join(manager.ClaudeHome, ".mcp.json"))
	doc := map[string]map[string]json.RawMessage{}
	_ = json.Unmarshal(contentBytes, &doc)
	if _, ok := doc["mcpServers"]["weather"]; ok {
		t.Fatalf("po disable má být klíč pryč z aktivního souboru")
	}

	if _, err := manager.SetEnabled(asset, true); err != nil {
		t.Fatalf("enable: %v", err)
	}
	contentBytes, _ = os.ReadFile(filepath.Join(manager.ClaudeHome, ".mcp.json"))
	_ = json.Unmarshal(contentBytes, &doc)
	if _, ok := doc["mcpServers"]["weather"]; !ok {
		t.Fatalf("po enable se klíč nevrátil")
	}
}

func TestInstallHookAppendsAndRemovesEntries(t *testing.T) {
	t.Setenv("CLAUDE_HUB_WORKSPACE_ROOTS", "")
	t.Setenv("CLAUDE_HUB_WORKSPACE_ROOT", "")

	manager := NewManager(t.TempDir())
	_ = manager.EnsureBaseDirs()

	settingsPath := filepath.Join(manager.ClaudeHome, "settings.json")
	existing := `{
  "hooks": {
    "PreToolUse": [{"matcher":"Bash","hooks":[{"type":"command","command":"echo existing"}]}]
  }
}`
	_ = os.WriteFile(settingsPath, []byte(existing), 0o644)

	asset := CatalogAsset{
		ID:      "hook:guard",
		Type:    AssetTypeHook,
		Slug:    "guard",
		Name:    "Bash guard",
		Version: "1.0.0",
		Risk:    RiskHigh,
		Files: []AssetFile{{
			Path: "settings.hooks.json",
			Content: `{
  "hooks": {
    "PreToolUse": [{"matcher":"Bash","hooks":[{"type":"command","command":"echo guard"}]}]
  }
}`,
		}},
	}

	if _, err := manager.Install(asset); err != nil {
		t.Fatalf("install: %v", err)
	}

	contentBytes, _ := os.ReadFile(settingsPath)
	doc := map[string]map[string][]map[string]any{}
	_ = json.Unmarshal(contentBytes, &doc)
	if len(doc["hooks"]["PreToolUse"]) != 2 {
		t.Fatalf("expected 2 hooks after install, got %d", len(doc["hooks"]["PreToolUse"]))
	}

	if _, err := manager.Uninstall(asset); err != nil {
		t.Fatalf("uninstall: %v", err)
	}
	contentBytes, _ = os.ReadFile(settingsPath)
	_ = json.Unmarshal(contentBytes, &doc)
	if len(doc["hooks"]["PreToolUse"]) != 1 {
		t.Fatalf("expected 1 hook after uninstall, got %d", len(doc["hooks"]["PreToolUse"]))
	}
}

func TestInstallPluginWritesFilesAndUpdatesManifest(t *testing.T) {
	t.Setenv("CLAUDE_HUB_WORKSPACE_ROOTS", "")
	t.Setenv("CLAUDE_HUB_WORKSPACE_ROOT", "")

	manager := NewManager(t.TempDir())
	_ = manager.EnsureBaseDirs()

	asset := CatalogAsset{
		ID:      "plugin:hello",
		Type:    AssetTypePlugin,
		Slug:    "hello-plugin",
		Name:    "Hello plugin",
		Version: "0.1.0",
		Risk:    RiskHigh,
		Files: []AssetFile{
			{Path: "plugin.json", Content: `{"name":"hello"}`},
			{Path: "src/index.js", Content: "console.log('hello');"},
		},
	}
	if _, err := manager.Install(asset); err != nil {
		t.Fatalf("install: %v", err)
	}

	pluginRoot := filepath.Join(manager.ClaudeHome, "plugins", "hello-plugin")
	if !exists(filepath.Join(pluginRoot, "plugin.json")) {
		t.Fatalf("plugin.json nebyl zapsán")
	}
	if !exists(filepath.Join(pluginRoot, "src", "index.js")) {
		t.Fatalf("src/index.js nebyl zapsán")
	}

	manifestPath := filepath.Join(manager.ClaudeHome, "plugins", "installed_plugins.json")
	bytes, _ := os.ReadFile(manifestPath)
	doc := map[string]map[string][]map[string]any{}
	_ = json.Unmarshal(bytes, &doc)
	if len(doc["plugins"]["hello-plugin"]) == 0 {
		t.Fatalf("installed_plugins.json nezmiňuje plugin")
	}

	if _, err := manager.Uninstall(asset); err != nil {
		t.Fatalf("uninstall: %v", err)
	}
	if exists(pluginRoot) {
		t.Fatalf("po uninstall měla složka být odstraněná")
	}
}
