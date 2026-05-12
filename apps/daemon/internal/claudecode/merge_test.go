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

	state, err := manager.Install(asset, InstallOptions{})
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
	if _, err := manager.Uninstall(asset, InstallOptions{}); err != nil {
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

	if _, err := manager.Install(asset, InstallOptions{}); err != nil {
		t.Fatalf("install: %v", err)
	}
	if _, err := manager.SetEnabled(asset, false, InstallOptions{}); err != nil {
		t.Fatalf("disable: %v", err)
	}

	contentBytes, _ := os.ReadFile(filepath.Join(manager.ClaudeHome, ".mcp.json"))
	doc := map[string]map[string]json.RawMessage{}
	_ = json.Unmarshal(contentBytes, &doc)
	if _, ok := doc["mcpServers"]["weather"]; ok {
		t.Fatalf("po disable má být klíč pryč z aktivního souboru")
	}

	if _, err := manager.SetEnabled(asset, true, InstallOptions{}); err != nil {
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

	if _, err := manager.Install(asset, InstallOptions{}); err != nil {
		t.Fatalf("install: %v", err)
	}

	contentBytes, _ := os.ReadFile(settingsPath)
	doc := map[string]map[string][]map[string]any{}
	_ = json.Unmarshal(contentBytes, &doc)
	if len(doc["hooks"]["PreToolUse"]) != 2 {
		t.Fatalf("expected 2 hooks after install, got %d", len(doc["hooks"]["PreToolUse"]))
	}

	if _, err := manager.Uninstall(asset, InstallOptions{}); err != nil {
		t.Fatalf("uninstall: %v", err)
	}
	contentBytes, _ = os.ReadFile(settingsPath)
	_ = json.Unmarshal(contentBytes, &doc)
	if len(doc["hooks"]["PreToolUse"]) != 1 {
		t.Fatalf("expected 1 hook after uninstall, got %d", len(doc["hooks"]["PreToolUse"]))
	}
}

func TestUserMcpAssetsDetectsServersFromClaudeJson(t *testing.T) {
	t.Setenv("CLAUDE_HUB_WORKSPACE_ROOTS", "")
	t.Setenv("CLAUDE_HUB_WORKSPACE_ROOT", "")

	home := t.TempDir()
	claudeHome := filepath.Join(home, ".claude")
	if err := os.MkdirAll(claudeHome, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	claudeJson := filepath.Join(home, ".claude.json")
	content := `{
  "userID": "abc",
  "mcpServers": {
    "notion": {"command": "npx", "args": ["notion"]},
    "codegraph": {"command": "npx", "args": ["cg"]}
  },
  "projects": {}
}`
	if err := os.WriteFile(claudeJson, []byte(content), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	manager := NewManager(claudeHome)
	if err := manager.EnsureBaseDirs(); err != nil {
		t.Fatalf("ensure: %v", err)
	}

	assets, err := manager.LocalAssets()
	if err != nil {
		t.Fatalf("local assets: %v", err)
	}

	mcps := map[string]LocalAsset{}
	for _, a := range assets {
		if a.Type == AssetTypeMCP {
			mcps[a.Slug] = a
		}
	}

	if len(mcps) != 2 {
		t.Fatalf("expected 2 MCP assets, got %d (%v)", len(mcps), mcps)
	}
	if mcps["notion"].Name != "MCP: notion" {
		t.Fatalf("unexpected notion name: %q", mcps["notion"].Name)
	}
	if _, ok := mcps["codegraph"]; !ok {
		t.Fatalf("codegraph not detected")
	}
}

func TestInstallMCPPreservesOtherClaudeJsonKeys(t *testing.T) {
	t.Setenv("CLAUDE_HUB_WORKSPACE_ROOTS", "")
	t.Setenv("CLAUDE_HUB_WORKSPACE_ROOT", "")

	home := t.TempDir()
	claudeHome := filepath.Join(home, ".claude")
	if err := os.MkdirAll(claudeHome, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	claudeJson := filepath.Join(home, ".claude.json")
	existing := `{
  "userID": "abc-123",
  "mcpServers": {
    "old-server": {"command": "echo", "args": ["old"]}
  },
  "projects": {"a": {}}
}`
	if err := os.WriteFile(claudeJson, []byte(existing), 0o644); err != nil {
		t.Fatalf("write existing: %v", err)
	}

	manager := NewManager(claudeHome)
	if err := manager.EnsureBaseDirs(); err != nil {
		t.Fatalf("ensure: %v", err)
	}

	asset := CatalogAsset{
		ID:      "mcp:weather",
		Type:    AssetTypeMCP,
		Slug:    "weather",
		Name:    "Weather",
		Version: "1.0.0",
		Risk:    RiskMedium,
		Files: []AssetFile{{
			Path:    "mcp.json",
			Content: `{"mcpServers":{"weather":{"command":"node","args":["weather.js"]}}}`,
		}},
	}

	if _, err := manager.Install(asset, InstallOptions{}); err != nil {
		t.Fatalf("install: %v", err)
	}

	bytes, _ := os.ReadFile(claudeJson)
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(bytes, &doc); err != nil {
		t.Fatalf("parse: %v", err)
	}

	if _, ok := doc["userID"]; !ok {
		t.Fatalf("userID byl ztracen při merge")
	}
	if _, ok := doc["projects"]; !ok {
		t.Fatalf("projects sekce byla ztracena při merge")
	}

	servers := map[string]json.RawMessage{}
	_ = json.Unmarshal(doc["mcpServers"], &servers)
	if _, ok := servers["old-server"]; !ok {
		t.Fatalf("old-server byl ztracen")
	}
	if _, ok := servers["weather"]; !ok {
		t.Fatalf("nový server weather se nepřidal")
	}
}

func TestSplitMcpServerPath(t *testing.T) {
	cases := []struct {
		in         string
		wantFile   string
		wantKey    string
		wantSplit  bool
	}{
		{"/home/user/.claude.json :: mcpServers.notion", "/home/user/.claude.json", "notion", true},
		{"/home/user/.claude.json", "/home/user/.claude.json", "", false},
		{" :: mcpServers.notion", "", "", false},
	}
	for _, c := range cases {
		f, k, ok := splitMcpServerPath(c.in)
		if ok != c.wantSplit || (ok && (f != c.wantFile || k != c.wantKey)) {
			t.Errorf("splitMcpServerPath(%q) = (%q, %q, %v), chtěli jsme (%q, %q, %v)",
				c.in, f, k, ok, c.wantFile, c.wantKey, c.wantSplit)
		}
	}
}

func TestSettingsConfigAssetsDetectsWhitelistedSections(t *testing.T) {
	t.Setenv("CLAUDE_HUB_WORKSPACE_ROOTS", "")
	t.Setenv("CLAUDE_HUB_WORKSPACE_ROOT", "")

	manager := NewManager(t.TempDir())
	if err := manager.EnsureBaseDirs(); err != nil {
		t.Fatalf("ensure: %v", err)
	}

	settingsPath := filepath.Join(manager.ClaudeHome, "settings.json")
	content := `{
  "env": {"FOO": "bar"},
  "model": "claude-opus-4-7",
  "permissions": {"allow": []},
  "apiKeyHelper": "/personal/path",
  "hooks": {"PreToolUse": []}
}`
	if err := os.WriteFile(settingsPath, []byte(content), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	assets, err := manager.LocalAssets()
	if err != nil {
		t.Fatalf("local: %v", err)
	}

	configBySlug := map[string]LocalAsset{}
	for _, a := range assets {
		if a.Type == AssetTypeConfig {
			configBySlug[a.Slug] = a
		}
	}

	if _, ok := configBySlug["env"]; !ok {
		t.Fatalf("env nebylo detekováno")
	}
	if _, ok := configBySlug["model"]; !ok {
		t.Fatalf("model nebyl detekován")
	}
	if _, ok := configBySlug["permissions"]; ok {
		t.Fatalf("permissions nemělo být na whitelistu")
	}
	if _, ok := configBySlug["apiKeyHelper"]; ok {
		t.Fatalf("apiKeyHelper nemělo být na whitelistu")
	}
}

func TestInstallConfigMergesSectionAndPreservesOthers(t *testing.T) {
	t.Setenv("CLAUDE_HUB_WORKSPACE_ROOTS", "")
	t.Setenv("CLAUDE_HUB_WORKSPACE_ROOT", "")

	manager := NewManager(t.TempDir())
	if err := manager.EnsureBaseDirs(); err != nil {
		t.Fatalf("ensure: %v", err)
	}

	settingsPath := filepath.Join(manager.ClaudeHome, "settings.json")
	existing := `{
  "env": {"USER_VAR": "keep-me"},
  "permissions": {"allow": ["personal"]},
  "model": "old-model"
}`
	if err := os.WriteFile(settingsPath, []byte(existing), 0o644); err != nil {
		t.Fatalf("write existing: %v", err)
	}

	asset := CatalogAsset{
		ID:      "config:model",
		Type:    AssetTypeConfig,
		Slug:    "model",
		Name:    "Doporučený model",
		Version: "1.0.0",
		Risk:    RiskMedium,
		Files: []AssetFile{{
			Path:    "settings.model.json",
			Content: `{"model": "claude-opus-4-7"}`,
		}},
	}

	if _, err := manager.Install(asset, InstallOptions{}); err != nil {
		t.Fatalf("install: %v", err)
	}

	bytes, _ := os.ReadFile(settingsPath)
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(bytes, &doc); err != nil {
		t.Fatalf("parse: %v", err)
	}
	if string(doc["model"]) != `"claude-opus-4-7"` {
		t.Fatalf("model se nepřepsal: %s", doc["model"])
	}
	if _, ok := doc["env"]; !ok {
		t.Fatalf("env byl ztracen")
	}
	if _, ok := doc["permissions"]; !ok {
		t.Fatalf("permissions byly ztraceny")
	}

	// Uninstall vrátí původní model
	if _, err := manager.Uninstall(asset, InstallOptions{}); err != nil {
		t.Fatalf("uninstall: %v", err)
	}
	bytes, _ = os.ReadFile(settingsPath)
	_ = json.Unmarshal(bytes, &doc)
	if string(doc["model"]) != `"old-model"` {
		t.Fatalf("model se nevrátil na původní hodnotu: %s", doc["model"])
	}
}

func TestToggleConfigDisableEnableRoundtrip(t *testing.T) {
	t.Setenv("CLAUDE_HUB_WORKSPACE_ROOTS", "")
	t.Setenv("CLAUDE_HUB_WORKSPACE_ROOT", "")

	manager := NewManager(t.TempDir())
	if err := manager.EnsureBaseDirs(); err != nil {
		t.Fatalf("ensure: %v", err)
	}

	asset := CatalogAsset{
		ID:      "config:env",
		Type:    AssetTypeConfig,
		Slug:    "env",
		Name:    "Env preset",
		Version: "1.0.0",
		Risk:    RiskMedium,
		Files: []AssetFile{{
			Path:    "settings.env.json",
			Content: `{"env": {"ANIMATO_KEY": "ok"}}`,
		}},
	}

	if _, err := manager.Install(asset, InstallOptions{}); err != nil {
		t.Fatalf("install: %v", err)
	}
	settingsPath := filepath.Join(manager.ClaudeHome, "settings.json")
	readSections := func() map[string]json.RawMessage {
		bytes, _ := os.ReadFile(settingsPath)
		doc := map[string]json.RawMessage{}
		_ = json.Unmarshal(bytes, &doc)
		return doc
	}

	if _, ok := readSections()["env"]; !ok {
		t.Fatalf("env sekce po install chybí")
	}

	if _, err := manager.SetEnabled(asset, false, InstallOptions{}); err != nil {
		t.Fatalf("disable: %v", err)
	}
	if _, ok := readSections()["env"]; ok {
		t.Fatalf("env sekce by po disable měla zmizet z aktivního souboru")
	}

	if _, err := manager.SetEnabled(asset, true, InstallOptions{}); err != nil {
		t.Fatalf("enable: %v", err)
	}
	if _, ok := readSections()["env"]; !ok {
		t.Fatalf("po enable se env sekce nevrátila")
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
	if _, err := manager.Install(asset, InstallOptions{}); err != nil {
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

	if _, err := manager.Uninstall(asset, InstallOptions{}); err != nil {
		t.Fatalf("uninstall: %v", err)
	}
	if exists(pluginRoot) {
		t.Fatalf("po uninstall měla složka být odstraněná")
	}
}
