package claudecode

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestInstallSkillAndToggleState(t *testing.T) {
	manager := NewManager(t.TempDir())
	asset := CatalogAsset{
		ID:      "review-skill",
		Type:    AssetTypeSkill,
		Slug:    "review-skill",
		Name:    "Review Skill",
		Version: "1.0.0",
		Risk:    RiskLow,
		Files: []AssetFile{{
			Path:    "SKILL.md",
			Content: "# Review Skill\n\nReview code changes.",
		}},
	}

	preview, err := manager.PreviewInstall(asset, InstallOptions{})
	if err != nil {
		t.Fatalf("preview failed: %v", err)
	}
	if len(preview.Operations) != 2 {
		t.Fatalf("expected 2 preview operations, got %d", len(preview.Operations))
	}

	state, err := manager.Install(asset, InstallOptions{})
	if err != nil {
		t.Fatalf("install failed: %v", err)
	}
	if !state.Installed || !state.Enabled {
		t.Fatalf("expected installed enabled state, got %+v", state)
	}

	state, err = manager.SetEnabled(asset, false, InstallOptions{})
	if err != nil {
		t.Fatalf("disable failed: %v", err)
	}
	if !state.Installed || state.Enabled {
		t.Fatalf("expected installed disabled state, got %+v", state)
	}

	state, err = manager.SetEnabled(asset, true, InstallOptions{})
	if err != nil {
		t.Fatalf("enable failed: %v", err)
	}
	if !state.Installed || !state.Enabled {
		t.Fatalf("expected installed enabled state, got %+v", state)
	}
}

func TestCatalogStateUsesRealFilesystemPresence(t *testing.T) {
	t.Setenv("CLAUDE_HUB_WORKSPACE_ROOTS", "")
	t.Setenv("CLAUDE_HUB_WORKSPACE_ROOT", "")

	manager := NewManager(t.TempDir())
	asset := CatalogAsset{
		ID:      "review-skill",
		Type:    AssetTypeSkill,
		Slug:    "review-skill",
		Name:    "Review Skill",
		Version: "1.0.0",
		Risk:    RiskLow,
		Files: []AssetFile{{
			Path:    "SKILL.md",
			Content: "# Review Skill\n\nReview code changes.",
		}},
	}

	if _, err := manager.Install(asset, InstallOptions{}); err != nil {
		t.Fatalf("install failed: %v", err)
	}
	if err := os.RemoveAll(filepath.Join(manager.ClaudeHome, "skills", "review-skill")); err != nil {
		t.Fatalf("remove installed skill failed: %v", err)
	}

	states, err := manager.State([]CatalogAsset{asset})
	if err != nil {
		t.Fatalf("state failed: %v", err)
	}
	if len(states) != 1 || states[0].Installed || states[0].Enabled {
		t.Fatalf("expected removed skill to be reported as not installed, got %+v", states)
	}
	if !strings.Contains(strings.Join(states[0].Warnings, " "), "lokální soubor už neexistuje") {
		t.Fatalf("expected orphan manifest warning, got %+v", states[0].Warnings)
	}
}

func TestExportLocalCommand(t *testing.T) {
	t.Setenv("CLAUDE_HUB_WORKSPACE_ROOTS", "")
	t.Setenv("CLAUDE_HUB_WORKSPACE_ROOT", "")

	claudeHome := t.TempDir()
	commandsDir := filepath.Join(claudeHome, "commands")
	if err := os.MkdirAll(commandsDir, 0o755); err != nil {
		t.Fatalf("mkdir failed: %v", err)
	}
	if err := os.WriteFile(filepath.Join(commandsDir, "release-notes.md"), []byte("# /release-notes\n\nWrite notes."), 0o644); err != nil {
		t.Fatalf("write command failed: %v", err)
	}

	manager := NewManager(claudeHome)
	assets, err := manager.LocalAssets()
	if err != nil {
		t.Fatalf("local assets failed: %v", err)
	}
	if len(assets) != 1 {
		t.Fatalf("expected one local asset, got %d", len(assets))
	}

	exported, err := manager.ExportLocalAsset("command:release-notes")
	if err != nil {
		t.Fatalf("export failed: %v", err)
	}
	if exported.Name != "/release-notes" || len(exported.Files) != 1 {
		t.Fatalf("unexpected export: %+v", exported)
	}
}

func TestListsWorkspaceSkillAssets(t *testing.T) {
	claudeHome := t.TempDir()
	workspaceRoot := filepath.Join(t.TempDir(), "workspaces")
	projectRoot := filepath.Join(workspaceRoot, "creado-web")
	skillDir := filepath.Join(projectRoot, ".claude", "skills", "ui-ux-pro-max")
	if err := os.MkdirAll(skillDir, 0o755); err != nil {
		t.Fatalf("mkdir failed: %v", err)
	}
	if err := os.WriteFile(
		filepath.Join(skillDir, "SKILL.md"),
		[]byte("# UI UX Pro Max\n\nProject-specific design review skill."),
		0o644,
	); err != nil {
		t.Fatalf("write skill failed: %v", err)
	}
	t.Setenv("CLAUDE_HUB_WORKSPACE_ROOTS", workspaceRoot)
	t.Setenv("CLAUDE_HUB_WORKSPACE_ROOT", "")

	manager := NewManager(claudeHome)
	assets, err := manager.LocalAssets()
	if err != nil {
		t.Fatalf("local assets failed: %v", err)
	}
	if len(assets) != 1 {
		t.Fatalf("expected one local asset, got %d", len(assets))
	}
	if assets[0].Type != AssetTypeSkill || assets[0].Scope != "project" || assets[0].ProjectName != "creado-web" {
		t.Fatalf("unexpected project skill asset: %+v", assets[0])
	}
	if assets[0].ProjectPath != projectRoot {
		t.Fatalf("unexpected project path: %s", assets[0].ProjectPath)
	}

	exported, err := manager.ExportLocalAsset(assets[0].LocalAssetID)
	if err != nil {
		t.Fatalf("export failed: %v", err)
	}
	if len(exported.Files) != 1 || exported.Files[0].Path != "SKILL.md" {
		t.Fatalf("unexpected export files: %+v", exported.Files)
	}
}

func TestCatalogStateRecognizesExistingProjectSkill(t *testing.T) {
	claudeHome := t.TempDir()
	workspaceRoot := filepath.Join(t.TempDir(), "workspaces")
	projectRoot := filepath.Join(workspaceRoot, "hub")
	skillDir := filepath.Join(projectRoot, ".claude", "skills", "review-skill")
	if err := os.MkdirAll(skillDir, 0o755); err != nil {
		t.Fatalf("mkdir failed: %v", err)
	}
	if err := os.WriteFile(filepath.Join(skillDir, "SKILL.md"), []byte("# Review Skill\n\nReview code."), 0o644); err != nil {
		t.Fatalf("write skill failed: %v", err)
	}
	t.Setenv("CLAUDE_HUB_WORKSPACE_ROOTS", workspaceRoot)
	t.Setenv("CLAUDE_HUB_WORKSPACE_ROOT", "")

	manager := NewManager(claudeHome)
	states, err := manager.State([]CatalogAsset{{
		ID:      "skill:review-skill",
		Type:    AssetTypeSkill,
		Slug:    "review-skill",
		Name:    "Review Skill",
		Version: "0.1.0",
		Files: []AssetFile{{
			Path:    "SKILL.md",
			Content: "# Review Skill\n\nReview code.",
		}},
	}})
	if err != nil {
		t.Fatalf("state failed: %v", err)
	}
	if len(states) != 1 || !states[0].Installed || !states[0].Enabled || states[0].ManagedByHub {
		t.Fatalf("expected existing project skill to be installed outside Hub management, got %+v", states)
	}
	if !strings.Contains(strings.Join(states[0].Warnings, " "), "nepochází z instalace přes Claude Hub") {
		t.Fatalf("expected unmanaged local warning, got %+v", states[0].Warnings)
	}
}

func TestPluginAssetsAreGroupedByPluginIdentity(t *testing.T) {
	t.Setenv("CLAUDE_HUB_WORKSPACE_ROOTS", "")
	t.Setenv("CLAUDE_HUB_WORKSPACE_ROOT", "")

	claudeHome := t.TempDir()
	pluginRoot := filepath.Join(claudeHome, "plugins", "cache", "claude-plugins-official", "superpowers")
	version510 := filepath.Join(pluginRoot, "5.1.0")
	version507 := filepath.Join(pluginRoot, "5.0.7")
	for _, dir := range []string{version510, version507} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("mkdir failed: %v", err)
		}
		if err := os.WriteFile(filepath.Join(dir, "plugin.json"), []byte(`{"name":"superpowers"}`), 0o644); err != nil {
			t.Fatalf("write plugin metadata failed: %v", err)
		}
	}

	installed := installedPluginsFile{Plugins: map[string][]installedPluginEntry{
		"superpowers@claude-plugins-official": {
			{Scope: "project", ProjectPath: filepath.Join("D:", "Claude", "hub"), InstallPath: version510, Version: "5.1.0"},
			{Scope: "project", ProjectPath: filepath.Join("D:", "Claude", "lifestyle"), InstallPath: version507, Version: "5.0.7"},
			{Scope: "project", ProjectPath: filepath.Join("D:", "Dev", "meta-ads"), InstallPath: version507, Version: "5.0.7"},
		},
	}}
	content, err := json.Marshal(installed)
	if err != nil {
		t.Fatalf("marshal installed plugins failed: %v", err)
	}
	pluginFile := filepath.Join(claudeHome, "plugins", "installed_plugins.json")
	if err := os.MkdirAll(filepath.Dir(pluginFile), 0o755); err != nil {
		t.Fatalf("mkdir failed: %v", err)
	}
	if err := os.WriteFile(pluginFile, content, 0o644); err != nil {
		t.Fatalf("write installed plugins failed: %v", err)
	}

	manager := NewManager(claudeHome)
	assets, err := manager.LocalAssets()
	if err != nil {
		t.Fatalf("local assets failed: %v", err)
	}
	if len(assets) != 1 {
		t.Fatalf("expected one grouped plugin asset, got %+v", assets)
	}
	if assets[0].LocalAssetID != "plugin:superpowers-claude-plugins-official" || assets[0].Path != version510 {
		t.Fatalf("unexpected grouped plugin asset: %+v", assets[0])
	}
	warnings := strings.Join(assets[0].Warnings, " ")
	if !strings.Contains(warnings, "3 kontextech") || !strings.Contains(warnings, "5.1.0") || !strings.Contains(warnings, "5.0.7") {
		t.Fatalf("expected grouped plugin warning with contexts and versions, got %+v", assets[0].Warnings)
	}
}

func TestListsUserSettingsHooksWithoutSharingFullSettings(t *testing.T) {
	t.Setenv("CLAUDE_HUB_WORKSPACE_ROOTS", "")
	t.Setenv("CLAUDE_HUB_WORKSPACE_ROOT", "")

	claudeHome := t.TempDir()
	if err := os.WriteFile(
		filepath.Join(claudeHome, "settings.json"),
		[]byte(`{"permissions":{"allow":["Bash(*)"]},"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"echo ok"}]}]}}`),
		0o644,
	); err != nil {
		t.Fatalf("write settings failed: %v", err)
	}

	manager := NewManager(claudeHome)
	assets, err := manager.LocalAssets()
	if err != nil {
		t.Fatalf("local assets failed: %v", err)
	}
	if len(assets) != 1 || assets[0].Type != AssetTypeHook {
		t.Fatalf("expected one hook asset, got %+v", assets)
	}

	exported, err := manager.ExportLocalAsset(assets[0].LocalAssetID)
	if err != nil {
		t.Fatalf("export failed: %v", err)
	}
	if len(exported.Files) != 1 || exported.Files[0].Path != "hook.json" {
		t.Fatalf("unexpected export files: %+v", exported.Files)
	}
	if strings.Contains(exported.Files[0].Content, "permissions") {
		t.Fatalf("export leaked non-hook settings: %s", exported.Files[0].Content)
	}
	if !strings.Contains(exported.Files[0].Content, "PreToolUse") || !strings.Contains(exported.Files[0].Content, "echo ok") {
		t.Fatalf("export missing hook entry payload: %s", exported.Files[0].Content)
	}
}

func TestListsEachSettingsHookEntryAsSeparateAsset(t *testing.T) {
	t.Setenv("CLAUDE_HUB_WORKSPACE_ROOTS", "")
	t.Setenv("CLAUDE_HUB_WORKSPACE_ROOT", "")

	claudeHome := t.TempDir()
	settings := `{
  "hooks": {
    "PostToolUse": [
      {"matcher": "Edit|Write", "hooks": [{"type": "command", "command": "echo a"}]}
    ],
    "Stop": [
      {"matcher": ".*", "hooks": [{"type": "command", "command": "echo b"}]},
      {"matcher": ".*", "hooks": [{"type": "command", "command": "echo c"}]}
    ]
  }
}`
	if err := os.WriteFile(filepath.Join(claudeHome, "settings.json"), []byte(settings), 0o644); err != nil {
		t.Fatalf("write settings failed: %v", err)
	}

	manager := NewManager(claudeHome)
	assets, err := manager.LocalAssets()
	if err != nil {
		t.Fatalf("local assets failed: %v", err)
	}

	hookCount := 0
	for _, a := range assets {
		if a.Type == AssetTypeHook {
			hookCount++
		}
	}
	if hookCount != 3 {
		t.Fatalf("expected 3 hook assets (one per matcher block), got %d: %+v", hookCount, assets)
	}
}

func TestRejectsUnsafeAssetPath(t *testing.T) {
	manager := NewManager(t.TempDir())
	_, err := manager.PreviewInstall(CatalogAsset{
		ID:      "bad",
		Type:    AssetTypeSkill,
		Slug:    "bad",
		Name:    "Bad",
		Version: "1.0.0",
		Files: []AssetFile{{
			Path:    "../escape.md",
			Content: "bad",
		}},
	}, InstallOptions{})
	if err == nil {
		t.Fatal("expected unsafe path error")
	}
}
