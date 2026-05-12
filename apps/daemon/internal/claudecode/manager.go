package claudecode

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

var (
	secretLikePattern = regexp.MustCompile(`(?i)(api[_-]?key|token|secret|password)\s*[:=]`)
	localPathPattern  = regexp.MustCompile(`(?i)([a-z]:\\users\\|/users/|/home/)`)
)

const maxExportFileSize = 512 * 1024

var skippedWorkspaceDirs = map[string]bool{
	".git":         true,
	".next":        true,
	"dist":         true,
	"build":        true,
	"node_modules": true,
	"vendor":       true,
}

type Manager struct {
	ClaudeHome string
	HubHome    string

	locksMu sync.Mutex
	locks   map[string]*sync.Mutex
}

// assetLock vrátí mutex unikátní pro daný (type, slug) pár.
// Tím serializujeme paralelní install/uninstall/set-enabled na stejné položce.
func (m *Manager) assetLock(assetType AssetType, slug string) *sync.Mutex {
	key := string(assetType) + ":" + Slugify(slug)
	m.locksMu.Lock()
	defer m.locksMu.Unlock()
	if m.locks == nil {
		m.locks = make(map[string]*sync.Mutex)
	}
	if lock, ok := m.locks[key]; ok {
		return lock
	}
	lock := &sync.Mutex{}
	m.locks[key] = lock
	return lock
}

type assetPaths struct {
	TargetRoot   string
	TargetFile   string
	DisabledRoot string
	DisabledFile string
	Manifest     string
}

type installedPluginsFile struct {
	Plugins map[string][]installedPluginEntry `json:"plugins"`
}

type installedPluginEntry struct {
	Scope       string `json:"scope"`
	ProjectPath string `json:"projectPath"`
	InstallPath string `json:"installPath"`
	Version     string `json:"version"`
}

func NewManager(claudeHome string) *Manager {
	return &Manager{
		ClaudeHome: claudeHome,
		HubHome:    HubHome(claudeHome),
		locks:      make(map[string]*sync.Mutex),
	}
}

func (m *Manager) EnsureBaseDirs() error {
	for _, dir := range []string{
		m.ClaudeHome,
		m.HubHome,
		filepath.Join(m.ClaudeHome, "skills"),
		filepath.Join(m.ClaudeHome, "commands"),
		filepath.Join(m.HubHome, "installed"),
	} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	return nil
}

func (m *Manager) Token() (string, string, error) {
	if err := os.MkdirAll(m.HubHome, 0o755); err != nil {
		return "", "", err
	}

	tokenPath := filepath.Join(m.HubHome, "daemon-token")
	if content, err := os.ReadFile(tokenPath); err == nil {
		return strings.TrimSpace(string(content)), tokenPath, nil
	}

	bytes := make([]byte, 24)
	if _, err := rand.Read(bytes); err != nil {
		return "", "", err
	}

	token := base64.RawURLEncoding.EncodeToString(bytes)
	if err := os.WriteFile(tokenPath, []byte(token+"\n"), 0o600); err != nil {
		return "", "", err
	}

	return token, tokenPath, nil
}

func (m *Manager) State(catalog []CatalogAsset) ([]LocalAssetState, error) {
	if err := m.EnsureBaseDirs(); err != nil {
		return nil, err
	}

	localIndex, err := m.localInstalledIndex()
	if err != nil {
		return nil, err
	}

	states := make([]LocalAssetState, 0, len(catalog))
	for _, asset := range catalog {
		state, err := m.assetState(normalizeAsset(asset), localIndex)
		if err != nil {
			return nil, err
		}
		states = append(states, state)
	}
	return states, nil
}

func (m *Manager) PreviewInstall(asset CatalogAsset) (InstallPreview, error) {
	if err := m.EnsureBaseDirs(); err != nil {
		return InstallPreview{}, err
	}

	asset = normalizeAsset(asset)
	if err := validateSupported(asset); err != nil {
		return InstallPreview{}, err
	}

	switch asset.Type {
	case AssetTypeMCP:
		return m.previewMCPInstall(asset)
	case AssetTypeHook:
		return m.previewHookInstall(asset)
	case AssetTypePlugin:
		return m.previewPluginInstall(asset)
	case AssetTypeConfig:
		return m.previewConfigInstall(asset)
	}

	paths := m.paths(asset)
	operations := make([]InstallOperation, 0, 3)
	if exists(paths.TargetFile) || exists(paths.DisabledFile) {
		operations = append(operations, InstallOperation{
			Type:        "backup",
			Path:        firstExisting(paths.TargetRoot, paths.DisabledRoot),
			Description: "Zálohovat aktuální lokální položku.",
			Risk:        RiskLow,
		})
	}

	operationType := "create"
	if exists(paths.TargetFile) || exists(paths.DisabledFile) {
		operationType = "replace"
	}

	operations = append(operations, InstallOperation{
		Type:        operationType,
		Path:        paths.TargetRoot,
		Description: "Zapsat soubory položky do lokální složky Claude Code.",
		Risk:        asset.Risk,
	})
	operations = append(operations, InstallOperation{
		Type:        "manifest",
		Path:        paths.Manifest,
		Description: "Uložit metadata verze a kontrolního otisku z Claude Hubu.",
		Risk:        RiskLow,
	})

	return InstallPreview{
		AssetID:     asset.ID,
		Version:     asset.Version,
		Operations:  operations,
		Warnings:    contentWarnings(asset.Files),
		RequiredEnv: asset.RequiredEnv,
	}, nil
}

func (m *Manager) previewConfigInstall(asset CatalogAsset) (InstallPreview, error) {
	paths := m.paths(asset)
	if _, err := extractConfigSectionFromAsset(asset, asset.Slug); err != nil {
		return InstallPreview{}, err
	}
	doc, err := readSettingsDoc(paths.TargetFile)
	if err != nil {
		return InstallPreview{}, err
	}

	operations := make([]InstallOperation, 0, 3)
	operations = append(operations, InstallOperation{
		Type:        "backup",
		Path:        paths.TargetFile,
		Description: "Zazálohovat settings.json před úpravou.",
		Risk:        RiskLow,
	})
	opType := "create"
	if _, ok := doc.Sections[asset.Slug]; ok {
		opType = "replace"
	}
	operations = append(operations, InstallOperation{
		Type:        opType,
		Path:        paths.TargetFile + " :: " + asset.Slug,
		Description: fmt.Sprintf("Nastavit sekci %q v settings.json.", asset.Slug),
		Risk:        asset.Risk,
	})
	operations = append(operations, InstallOperation{
		Type:        "manifest",
		Path:        paths.Manifest,
		Description: "Uložit zálohu předchozí hodnoty sekce pro pozdější uninstall.",
		Risk:        RiskLow,
	})
	return InstallPreview{
		AssetID:     asset.ID,
		Version:     asset.Version,
		Operations:  operations,
		Warnings:    contentWarnings(asset.Files),
		RequiredEnv: asset.RequiredEnv,
	}, nil
}

func (m *Manager) previewMCPInstall(asset CatalogAsset) (InstallPreview, error) {
	paths := m.paths(asset)
	servers, err := extractMCPServersFromAsset(asset)
	if err != nil {
		return InstallPreview{}, err
	}
	doc, err := readMCPDoc(paths.TargetFile)
	if err != nil {
		return InstallPreview{}, err
	}

	operations := make([]InstallOperation, 0, 4)
	operations = append(operations, InstallOperation{
		Type:        "backup",
		Path:        paths.TargetFile,
		Description: "Zazálohovat .mcp.json před úpravou.",
		Risk:        RiskLow,
	})
	for _, serverKey := range sortedStringKeys(servers) {
		if _, exists := doc.MCPServers[serverKey]; exists {
			operations = append(operations, InstallOperation{
				Type:        "replace",
				Path:        paths.TargetFile + " :: mcpServers." + serverKey,
				Description: fmt.Sprintf("Nahradit existující MCP server %q definicí z katalogu.", serverKey),
				Risk:        asset.Risk,
			})
			continue
		}
		operations = append(operations, InstallOperation{
			Type:        "create",
			Path:        paths.TargetFile + " :: mcpServers." + serverKey,
			Description: fmt.Sprintf("Přidat MCP server %q.", serverKey),
			Risk:        asset.Risk,
		})
	}
	operations = append(operations, InstallOperation{
		Type:        "manifest",
		Path:        paths.Manifest,
		Description: "Uložit seznam přidaných MCP klíčů pro pozdější uninstall.",
		Risk:        RiskLow,
	})

	return InstallPreview{
		AssetID:     asset.ID,
		Version:     asset.Version,
		Operations:  operations,
		Warnings:    contentWarnings(asset.Files),
		RequiredEnv: asset.RequiredEnv,
	}, nil
}

func (m *Manager) previewHookInstall(asset CatalogAsset) (InstallPreview, error) {
	paths := m.paths(asset)
	hookEntries, err := extractHookEntriesFromAsset(asset)
	if err != nil {
		return InstallPreview{}, err
	}
	operations := make([]InstallOperation, 0, 4)
	operations = append(operations, InstallOperation{
		Type:        "backup",
		Path:        paths.TargetFile,
		Description: "Zazálohovat settings.json před úpravou.",
		Risk:        RiskLow,
	})
	for _, event := range sortedHookEventKeys(hookEntries) {
		operations = append(operations, InstallOperation{
			Type:        "create",
			Path:        paths.TargetFile + " :: hooks." + event,
			Description: fmt.Sprintf("Přidat %d hook položek do události %s.", len(hookEntries[event]), event),
			Risk:        asset.Risk,
		})
	}
	operations = append(operations, InstallOperation{
		Type:        "manifest",
		Path:        paths.Manifest,
		Description: "Uložit identifikátory přidaných hook položek.",
		Risk:        RiskLow,
	})

	return InstallPreview{
		AssetID:     asset.ID,
		Version:     asset.Version,
		Operations:  operations,
		Warnings:    contentWarnings(asset.Files),
		RequiredEnv: asset.RequiredEnv,
	}, nil
}

func (m *Manager) previewPluginInstall(asset CatalogAsset) (InstallPreview, error) {
	paths := m.paths(asset)
	pluginManifestPath := filepath.Join(m.ClaudeHome, "plugins", "installed_plugins.json")
	operations := []InstallOperation{
		{
			Type:        "backup",
			Path:        paths.TargetRoot,
			Description: "Zazálohovat plugin složku (pokud existuje).",
			Risk:        RiskLow,
		},
		{
			Type:        "create",
			Path:        paths.TargetRoot,
			Description: "Zapsat soubory pluginu do ~/.claude/plugins/<slug>/.",
			Risk:        asset.Risk,
		},
		{
			Type:        "create",
			Path:        pluginManifestPath,
			Description: "Aktualizovat installed_plugins.json o nový plugin.",
			Risk:        asset.Risk,
		},
		{
			Type:        "manifest",
			Path:        paths.Manifest,
			Description: "Uložit metadata pluginu pro pozdější uninstall.",
			Risk:        RiskLow,
		},
	}
	return InstallPreview{
		AssetID:     asset.ID,
		Version:     asset.Version,
		Operations:  operations,
		Warnings:    contentWarnings(asset.Files),
		RequiredEnv: asset.RequiredEnv,
	}, nil
}

func sortedStringKeys(m map[string]json.RawMessage) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func sortedHookEventKeys(m map[string][]json.RawMessage) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func (m *Manager) Install(asset CatalogAsset) (LocalAssetState, error) {
	if err := m.EnsureBaseDirs(); err != nil {
		return LocalAssetState{}, err
	}

	asset = normalizeAsset(asset)
	if err := validateSupported(asset); err != nil {
		return LocalAssetState{}, err
	}

	lock := m.assetLock(asset.Type, asset.Slug)
	lock.Lock()
	defer lock.Unlock()

	switch asset.Type {
	case AssetTypeMCP:
		return m.installMCP(asset)
	case AssetTypeHook:
		return m.installHook(asset)
	case AssetTypePlugin:
		return m.installPlugin(asset)
	case AssetTypeConfig:
		return m.installConfig(asset)
	}

	paths := m.paths(asset)
	backupPath, err := m.backup(paths, asset)
	if err != nil {
		return LocalAssetState{}, err
	}

	if exists(paths.DisabledRoot) {
		_ = os.RemoveAll(paths.DisabledRoot)
	}

	if asset.Type == AssetTypeSkill && exists(paths.TargetRoot) {
		_ = os.RemoveAll(paths.TargetRoot)
	}

	if err := writeAssetFiles(paths.TargetRoot, asset); err != nil {
		return LocalAssetState{}, err
	}

	content, _ := os.ReadFile(paths.TargetFile)
	now := time.Now().UTC().Format(time.RFC3339)
	record := manifest{
		AssetID:            asset.ID,
		Type:               asset.Type,
		Slug:               asset.Slug,
		Name:               asset.Name,
		Version:            asset.Version,
		Enabled:            true,
		InstalledAt:        now,
		Fingerprint:        fingerprint(asset),
		ContentFingerprint: shaText(string(content)),
		BackupPath:         backupPath,
	}

	if err := writeJSON(paths.Manifest, record); err != nil {
		return LocalAssetState{}, err
	}

	localIndex, _ := m.localInstalledIndex()
	return m.assetState(asset, localIndex)
}

func (m *Manager) installMCP(asset CatalogAsset) (LocalAssetState, error) {
	paths := m.paths(asset)
	servers, err := extractMCPServersFromAsset(asset)
	if err != nil {
		return LocalAssetState{}, err
	}
	doc, err := readMCPDoc(paths.TargetFile)
	if err != nil {
		return LocalAssetState{}, err
	}

	// Záloha původního stavu — pro disable / uninstall potřebujeme původní hodnoty
	// klíčů, abychom mohli korektně vrátit stav.
	previous := make(map[string]json.RawMessage, len(servers))
	for key := range servers {
		if existing, ok := doc.MCPServers[key]; ok {
			previous[key] = existing
		}
	}
	backupPath, err := m.backupMergeArtifact(paths, asset, doc)
	if err != nil {
		return LocalAssetState{}, err
	}

	addedKeys := make([]string, 0, len(servers))
	for key, value := range servers {
		doc.MCPServers[key] = value
		addedKeys = append(addedKeys, key)
	}
	sort.Strings(addedKeys)
	if err := writeMCPDoc(paths.TargetFile, doc); err != nil {
		return LocalAssetState{}, err
	}

	now := time.Now().UTC().Format(time.RFC3339)
	record := manifest{
		AssetID:            asset.ID,
		Type:               asset.Type,
		Slug:               asset.Slug,
		Name:               asset.Name,
		Version:            asset.Version,
		Enabled:            true,
		InstalledAt:        now,
		Fingerprint:        fingerprint(asset),
		ContentFingerprint: shaText(readText(paths.TargetFile)),
		BackupPath:         backupPath,
		MCPServerKeys:      addedKeys,
		ContentSnapshots:   serializeRawMap(previous),
	}
	if err := writeJSON(paths.Manifest, record); err != nil {
		return LocalAssetState{}, err
	}

	localIndex, _ := m.localInstalledIndex()
	return m.assetState(asset, localIndex)
}

func (m *Manager) installHook(asset CatalogAsset) (LocalAssetState, error) {
	paths := m.paths(asset)
	hookEntries, err := extractHookEntriesFromAsset(asset)
	if err != nil {
		return LocalAssetState{}, err
	}
	doc, err := readHookDoc(paths.TargetFile)
	if err != nil {
		return LocalAssetState{}, err
	}

	backupPath, err := m.backupMergeArtifact(paths, asset, doc)
	if err != nil {
		return LocalAssetState{}, err
	}

	// Pro každý event si zapamatujeme indexy položek, které přidáváme — aby
	// disable/uninstall mohlo cíleně vrátit zpět jen tyto položky.
	indexMap := map[string][]int{}
	for event, entries := range hookEntries {
		existing := doc.Hooks[event]
		addedIndices := make([]int, 0, len(entries))
		for _, entry := range entries {
			addedIndices = append(addedIndices, len(existing))
			existing = append(existing, entry)
		}
		doc.Hooks[event] = existing
		indexMap[event] = addedIndices
	}
	if err := writeHookDoc(paths.TargetFile, doc); err != nil {
		return LocalAssetState{}, err
	}

	now := time.Now().UTC().Format(time.RFC3339)
	record := manifest{
		AssetID:            asset.ID,
		Type:               asset.Type,
		Slug:               asset.Slug,
		Name:               asset.Name,
		Version:            asset.Version,
		Enabled:            true,
		InstalledAt:        now,
		Fingerprint:        fingerprint(asset),
		ContentFingerprint: shaText(readText(paths.TargetFile)),
		BackupPath:         backupPath,
		HookEventEntries:   indexMap,
	}
	if err := writeJSON(paths.Manifest, record); err != nil {
		return LocalAssetState{}, err
	}

	localIndex, _ := m.localInstalledIndex()
	return m.assetState(asset, localIndex)
}

func (m *Manager) installConfig(asset CatalogAsset) (LocalAssetState, error) {
	paths := m.paths(asset)
	sectionKey := asset.Slug
	sectionValue, err := extractConfigSectionFromAsset(asset, sectionKey)
	if err != nil {
		return LocalAssetState{}, err
	}
	doc, err := readSettingsDoc(paths.TargetFile)
	if err != nil {
		return LocalAssetState{}, err
	}

	snapshots := map[string]string{}
	if existing, ok := doc.Sections[sectionKey]; ok {
		snapshots["previous"] = string(existing)
	}
	backupPath, err := m.backupMergeArtifact(paths, asset, doc)
	if err != nil {
		return LocalAssetState{}, err
	}

	doc.Sections[sectionKey] = sectionValue
	if err := writeSettingsDoc(paths.TargetFile, doc); err != nil {
		return LocalAssetState{}, err
	}

	now := time.Now().UTC().Format(time.RFC3339)
	record := manifest{
		AssetID:            asset.ID,
		Type:               asset.Type,
		Slug:               asset.Slug,
		Name:               asset.Name,
		Version:            asset.Version,
		Enabled:            true,
		InstalledAt:        now,
		Fingerprint:        fingerprint(asset),
		ContentFingerprint: shaText(readText(paths.TargetFile)),
		BackupPath:         backupPath,
		ContentSnapshots:   snapshots,
	}
	if err := writeJSON(paths.Manifest, record); err != nil {
		return LocalAssetState{}, err
	}
	localIndex, _ := m.localInstalledIndex()
	return m.assetState(asset, localIndex)
}

func (m *Manager) installPlugin(asset CatalogAsset) (LocalAssetState, error) {
	paths := m.paths(asset)
	pluginManifestPath := filepath.Join(m.ClaudeHome, "plugins", "installed_plugins.json")

	backupPath, err := m.backup(paths, asset)
	if err != nil {
		return LocalAssetState{}, err
	}

	if exists(paths.TargetRoot) {
		_ = os.RemoveAll(paths.TargetRoot)
	}
	if err := writeAssetFiles(paths.TargetRoot, asset); err != nil {
		return LocalAssetState{}, err
	}

	// Aktualizace installed_plugins.json
	doc, err := readPluginDoc(pluginManifestPath)
	if err != nil {
		return LocalAssetState{}, err
	}
	pluginKey := asset.Slug
	doc.Plugins[pluginKey] = []installedPluginEntry{
		{
			Scope:       "user",
			ProjectPath: "",
			InstallPath: paths.TargetRoot,
			Version:     asset.Version,
		},
	}
	if err := writePluginDoc(pluginManifestPath, doc); err != nil {
		return LocalAssetState{}, err
	}

	now := time.Now().UTC().Format(time.RFC3339)
	record := manifest{
		AssetID:            asset.ID,
		Type:               asset.Type,
		Slug:               asset.Slug,
		Name:               asset.Name,
		Version:            asset.Version,
		Enabled:            true,
		InstalledAt:        now,
		Fingerprint:        fingerprint(asset),
		ContentFingerprint: shaText(readText(paths.TargetFile)),
		BackupPath:         backupPath,
		PluginEntries:      []string{"user:" + pluginKey},
	}
	if err := writeJSON(paths.Manifest, record); err != nil {
		return LocalAssetState{}, err
	}

	localIndex, _ := m.localInstalledIndex()
	return m.assetState(asset, localIndex)
}

// toggleMergeAsset pro MCP / hook přesune položky mezi aktivním dokumentem a "disabled stash"
// uloženou v `.claude-hub/disabled/<type>/<slug>.json`.
func (m *Manager) toggleMergeAsset(asset CatalogAsset, enabled bool) (LocalAssetState, error) {
	paths := m.paths(asset)
	record, _ := readManifest(paths.Manifest)
	if record == nil {
		return LocalAssetState{}, errors.New("položku nelze přepnout — chybí Hub manifest")
	}

	switch asset.Type {
	case AssetTypeMCP:
		if err := m.toggleMCP(asset, paths, record, enabled); err != nil {
			return LocalAssetState{}, err
		}
	case AssetTypeHook:
		if err := m.toggleHook(asset, paths, record, enabled); err != nil {
			return LocalAssetState{}, err
		}
	case AssetTypeConfig:
		if err := m.toggleConfig(asset, paths, record, enabled); err != nil {
			return LocalAssetState{}, err
		}
	}

	record.Enabled = enabled
	record.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	record.ContentFingerprint = shaText(readText(paths.TargetFile))
	if err := writeJSON(paths.Manifest, record); err != nil {
		return LocalAssetState{}, err
	}
	localIndex, _ := m.localInstalledIndex()
	return m.assetState(asset, localIndex)
}

func (m *Manager) toggleMCP(asset CatalogAsset, paths assetPaths, record *manifest, enabled bool) error {
	doc, err := readMCPDoc(paths.TargetFile)
	if err != nil {
		return err
	}
	stashPath := paths.DisabledFile

	if enabled {
		stash := map[string]json.RawMessage{}
		if exists(stashPath) {
			bytes, err := os.ReadFile(stashPath)
			if err == nil {
				_ = json.Unmarshal(bytes, &stash)
			}
		}
		for _, key := range record.MCPServerKeys {
			if value, ok := stash[key]; ok {
				doc.MCPServers[key] = value
				delete(stash, key)
			}
		}
		if err := writeMCPDoc(paths.TargetFile, doc); err != nil {
			return err
		}
		if len(stash) == 0 {
			_ = os.Remove(stashPath)
		} else {
			bytes, _ := json.MarshalIndent(stash, "", "  ")
			_ = os.MkdirAll(filepath.Dir(stashPath), 0o755)
			_ = os.WriteFile(stashPath, bytes, 0o644)
		}
		return nil
	}

	stash := map[string]json.RawMessage{}
	if exists(stashPath) {
		bytes, err := os.ReadFile(stashPath)
		if err == nil {
			_ = json.Unmarshal(bytes, &stash)
		}
	}
	for _, key := range record.MCPServerKeys {
		if value, ok := doc.MCPServers[key]; ok {
			stash[key] = value
			delete(doc.MCPServers, key)
		}
	}
	if err := writeMCPDoc(paths.TargetFile, doc); err != nil {
		return err
	}
	bytes, _ := json.MarshalIndent(stash, "", "  ")
	if err := os.MkdirAll(filepath.Dir(stashPath), 0o755); err != nil {
		return err
	}
	return os.WriteFile(stashPath, bytes, 0o644)
}

func (m *Manager) toggleConfig(asset CatalogAsset, paths assetPaths, record *manifest, enabled bool) error {
	_ = record
	doc, err := readSettingsDoc(paths.TargetFile)
	if err != nil {
		return err
	}
	sectionKey := asset.Slug
	stashPath := paths.DisabledFile

	if enabled {
		if !exists(stashPath) {
			return nil
		}
		bytes, err := os.ReadFile(stashPath)
		if err != nil {
			return err
		}
		doc.Sections[sectionKey] = json.RawMessage(bytes)
		if err := writeSettingsDoc(paths.TargetFile, doc); err != nil {
			return err
		}
		_ = os.Remove(stashPath)
		return nil
	}

	current, ok := doc.Sections[sectionKey]
	if !ok {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(stashPath), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(stashPath, []byte(current), 0o644); err != nil {
		return err
	}
	delete(doc.Sections, sectionKey)
	return writeSettingsDoc(paths.TargetFile, doc)
}

func (m *Manager) toggleHook(asset CatalogAsset, paths assetPaths, record *manifest, enabled bool) error {
	doc, err := readHookDoc(paths.TargetFile)
	if err != nil {
		return err
	}
	stashPath := paths.DisabledFile

	if enabled {
		stash := map[string][]json.RawMessage{}
		if exists(stashPath) {
			bytes, err := os.ReadFile(stashPath)
			if err == nil {
				_ = json.Unmarshal(bytes, &stash)
			}
		}
		newIndices := map[string][]int{}
		for event, entries := range stash {
			existing := doc.Hooks[event]
			indices := make([]int, 0, len(entries))
			for _, entry := range entries {
				indices = append(indices, len(existing))
				existing = append(existing, entry)
			}
			doc.Hooks[event] = existing
			newIndices[event] = indices
		}
		record.HookEventEntries = newIndices
		if err := writeHookDoc(paths.TargetFile, doc); err != nil {
			return err
		}
		_ = os.Remove(stashPath)
		return nil
	}

	stash := map[string][]json.RawMessage{}
	for event, indices := range record.HookEventEntries {
		entries := doc.Hooks[event]
		stashed := make([]json.RawMessage, 0, len(indices))
		sort.Sort(sort.Reverse(sort.IntSlice(indices)))
		for _, idx := range indices {
			if idx >= 0 && idx < len(entries) {
				stashed = append([]json.RawMessage{entries[idx]}, stashed...)
				entries = append(entries[:idx], entries[idx+1:]...)
			}
		}
		if len(entries) == 0 {
			delete(doc.Hooks, event)
		} else {
			doc.Hooks[event] = entries
		}
		if len(stashed) > 0 {
			stash[event] = stashed
		}
	}
	if err := writeHookDoc(paths.TargetFile, doc); err != nil {
		return err
	}
	bytes, _ := json.MarshalIndent(stash, "", "  ")
	if err := os.MkdirAll(filepath.Dir(stashPath), 0o755); err != nil {
		return err
	}
	return os.WriteFile(stashPath, bytes, 0o644)
}

// backupMergeArtifact uloží snapshot celého merge dokumentu (mcp/settings) před úpravou.
// Slouží pro plnou rollback cestu i pro audit, jak vypadal dokument před zápisem.
func (m *Manager) backupMergeArtifact(paths assetPaths, asset CatalogAsset, doc any) (string, error) {
	if !exists(paths.TargetFile) {
		return "", nil
	}
	stamp := time.Now().UTC().Format("20060102T150405Z")
	dir := filepath.Join(m.HubHome, "backups", stamp+"-"+string(asset.Type)+"-"+asset.Slug)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	bytes, err := os.ReadFile(paths.TargetFile)
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(filepath.Join(dir, filepath.Base(paths.TargetFile)), bytes, 0o644); err != nil {
		return "", err
	}
	if doc != nil {
		marshalled, _ := json.MarshalIndent(doc, "", "  ")
		_ = os.WriteFile(filepath.Join(dir, "parsed.json"), marshalled, 0o644)
	}
	return dir, nil
}

func serializeRawMap(m map[string]json.RawMessage) map[string]string {
	if len(m) == 0 {
		return nil
	}
	result := make(map[string]string, len(m))
	for key, value := range m {
		result[key] = string(value)
	}
	return result
}

func (m *Manager) SetEnabled(asset CatalogAsset, enabled bool) (LocalAssetState, error) {
	if err := m.EnsureBaseDirs(); err != nil {
		return LocalAssetState{}, err
	}

	asset = normalizeAsset(asset)
	if err := validateSupported(asset); err != nil {
		return LocalAssetState{}, err
	}

	lock := m.assetLock(asset.Type, asset.Slug)
	lock.Lock()
	defer lock.Unlock()

	if asset.Type == AssetTypeMCP || asset.Type == AssetTypeHook || asset.Type == AssetTypeConfig {
		return m.toggleMergeAsset(asset, enabled)
	}

	paths := m.paths(asset)
	record, _ := readManifest(paths.Manifest)
	if record == nil && !exists(paths.TargetFile) && !exists(paths.DisabledFile) {
		return LocalAssetState{}, errors.New("položka není nainstalovaná")
	}

	if enabled {
		if err := moveIfExists(paths.DisabledRoot, paths.TargetRoot); err != nil {
			return LocalAssetState{}, err
		}
	} else {
		if err := moveIfExists(paths.TargetRoot, paths.DisabledRoot); err != nil {
			return LocalAssetState{}, err
		}
	}

	now := time.Now().UTC().Format(time.RFC3339)
	if record == nil {
		record = &manifest{
			AssetID:     asset.ID,
			Type:        asset.Type,
			Slug:        asset.Slug,
			Name:        asset.Name,
			Version:     asset.Version,
			InstalledAt: now,
		}
	}
	record.Enabled = enabled
	record.UpdatedAt = now

	// Po přesunu mezi enabled/disabled obnovíme content fingerprint.
	// Bez tohoto kroku by toggle nebo úprava na vypnuté kopii falešně hlásily "local_changes".
	if enabled {
		record.ContentFingerprint = shaText(readText(paths.TargetFile))
	} else {
		record.ContentFingerprint = shaText(readText(paths.DisabledFile))
	}

	if err := writeJSON(paths.Manifest, record); err != nil {
		return LocalAssetState{}, err
	}

	localIndex, _ := m.localInstalledIndex()
	return m.assetState(asset, localIndex)
}

// Uninstall odstraní lokální položku a smaže manifest. Pro merge-style typy
// (MCP, hook) vrátí pouze přidané položky a zachová zbytek dokumentu.
func (m *Manager) Uninstall(asset CatalogAsset) (LocalAssetState, error) {
	if err := m.EnsureBaseDirs(); err != nil {
		return LocalAssetState{}, err
	}

	asset = normalizeAsset(asset)
	if err := validateSupported(asset); err != nil {
		return LocalAssetState{}, err
	}

	lock := m.assetLock(asset.Type, asset.Slug)
	lock.Lock()
	defer lock.Unlock()

	switch asset.Type {
	case AssetTypeMCP:
		return m.uninstallMCP(asset)
	case AssetTypeHook:
		return m.uninstallHook(asset)
	case AssetTypePlugin:
		return m.uninstallPlugin(asset)
	case AssetTypeConfig:
		return m.uninstallConfig(asset)
	}

	paths := m.paths(asset)
	if !exists(paths.TargetFile) && !exists(paths.DisabledFile) && !exists(paths.Manifest) {
		return LocalAssetState{}, errors.New("položka není nainstalovaná")
	}

	if _, err := m.backup(paths, asset); err != nil {
		return LocalAssetState{}, err
	}

	_ = os.RemoveAll(paths.TargetRoot)
	_ = os.RemoveAll(paths.DisabledRoot)
	_ = os.Remove(paths.Manifest)

	localIndex, _ := m.localInstalledIndex()
	return m.assetState(asset, localIndex)
}

func (m *Manager) uninstallMCP(asset CatalogAsset) (LocalAssetState, error) {
	paths := m.paths(asset)
	record, _ := readManifest(paths.Manifest)
	if record == nil {
		return LocalAssetState{}, errors.New("položka MCP není evidovaná v Claude Hubu, neumíme bezpečně odstranit")
	}
	doc, err := readMCPDoc(paths.TargetFile)
	if err != nil {
		return LocalAssetState{}, err
	}
	if _, err := m.backupMergeArtifact(paths, asset, doc); err != nil {
		return LocalAssetState{}, err
	}

	// Vrátíme klíče, které jsme přidali. Pokud existoval předchozí obsah, obnovíme ho;
	// jinak klíč smažeme.
	previous := record.ContentSnapshots
	for _, key := range record.MCPServerKeys {
		if raw, ok := previous[key]; ok {
			doc.MCPServers[key] = json.RawMessage(raw)
		} else {
			delete(doc.MCPServers, key)
		}
	}
	if err := writeMCPDoc(paths.TargetFile, doc); err != nil {
		return LocalAssetState{}, err
	}
	_ = os.Remove(paths.Manifest)

	localIndex, _ := m.localInstalledIndex()
	return m.assetState(asset, localIndex)
}

func (m *Manager) uninstallConfig(asset CatalogAsset) (LocalAssetState, error) {
	paths := m.paths(asset)
	record, _ := readManifest(paths.Manifest)
	if record == nil {
		return LocalAssetState{}, errors.New("config položka není evidovaná v Claude Hubu, neumíme bezpečně odstranit")
	}
	doc, err := readSettingsDoc(paths.TargetFile)
	if err != nil {
		return LocalAssetState{}, err
	}
	if _, err := m.backupMergeArtifact(paths, asset, doc); err != nil {
		return LocalAssetState{}, err
	}

	if previous, ok := record.ContentSnapshots["previous"]; ok && previous != "" {
		doc.Sections[asset.Slug] = json.RawMessage(previous)
	} else {
		delete(doc.Sections, asset.Slug)
	}
	if err := writeSettingsDoc(paths.TargetFile, doc); err != nil {
		return LocalAssetState{}, err
	}
	_ = os.Remove(paths.Manifest)
	_ = os.Remove(paths.DisabledFile)

	localIndex, _ := m.localInstalledIndex()
	return m.assetState(asset, localIndex)
}

func (m *Manager) uninstallHook(asset CatalogAsset) (LocalAssetState, error) {
	paths := m.paths(asset)
	record, _ := readManifest(paths.Manifest)
	if record == nil {
		return LocalAssetState{}, errors.New("hook položka není evidovaná v Claude Hubu, neumíme bezpečně odstranit")
	}
	doc, err := readHookDoc(paths.TargetFile)
	if err != nil {
		return LocalAssetState{}, err
	}
	if _, err := m.backupMergeArtifact(paths, asset, doc); err != nil {
		return LocalAssetState{}, err
	}

	// Pro každý event odstraníme indexy, které jsme přidali. Začínáme od konce,
	// aby předchozí indexy zůstaly platné.
	for event, indices := range record.HookEventEntries {
		entries := doc.Hooks[event]
		sort.Sort(sort.Reverse(sort.IntSlice(indices)))
		for _, idx := range indices {
			if idx >= 0 && idx < len(entries) {
				entries = append(entries[:idx], entries[idx+1:]...)
			}
		}
		if len(entries) == 0 {
			delete(doc.Hooks, event)
		} else {
			doc.Hooks[event] = entries
		}
	}
	if err := writeHookDoc(paths.TargetFile, doc); err != nil {
		return LocalAssetState{}, err
	}
	_ = os.Remove(paths.Manifest)

	localIndex, _ := m.localInstalledIndex()
	return m.assetState(asset, localIndex)
}

func (m *Manager) uninstallPlugin(asset CatalogAsset) (LocalAssetState, error) {
	paths := m.paths(asset)
	pluginManifestPath := filepath.Join(m.ClaudeHome, "plugins", "installed_plugins.json")

	if _, err := m.backup(paths, asset); err != nil {
		return LocalAssetState{}, err
	}

	_ = os.RemoveAll(paths.TargetRoot)

	doc, err := readPluginDoc(pluginManifestPath)
	if err == nil {
		delete(doc.Plugins, asset.Slug)
		_ = writePluginDoc(pluginManifestPath, doc)
	}
	_ = os.Remove(paths.Manifest)

	localIndex, _ := m.localInstalledIndex()
	return m.assetState(asset, localIndex)
}

func (m *Manager) LocalAssets() ([]LocalAsset, error) {
	if err := m.EnsureBaseDirs(); err != nil {
		return nil, err
	}

	assets := make([]LocalAsset, 0)
	assets = append(assets, m.skillAssets(filepath.Join(m.ClaudeHome, "skills"), "user", "", "", "", true)...)
	assets = append(assets, m.commandAssets(filepath.Join(m.ClaudeHome, "commands"), "user", "", "", "", true)...)
	assets = append(assets, m.entryAssets(filepath.Join(m.ClaudeHome, "hooks"), AssetTypeHook, "Hook", "user", "", "")...)
	assets = append(assets, m.settingsHookAsset(filepath.Join(m.ClaudeHome, "settings.json"), "hook:user-settings", "Nastavení uživatelských hooků", "user", "", "")...)
	assets = append(assets, m.pluginAssets()...)
	assets = append(assets, m.userMcpAssets()...)
	assets = append(assets, m.settingsConfigAssets(filepath.Join(m.ClaudeHome, "settings.json"), "user", "", "", "config:user")...)

	workspaceAssets, err := m.workspaceAssets()
	if err != nil {
		return nil, err
	}
	assets = append(assets, workspaceAssets...)
	normalizeLocalAssetSlices(assets)

	sort.Slice(assets, func(i, j int) bool {
		if assets[i].Scope != assets[j].Scope {
			return scopeRank(assets[i].Scope) < scopeRank(assets[j].Scope)
		}
		if assets[i].ProjectName != assets[j].ProjectName {
			return assets[i].ProjectName < assets[j].ProjectName
		}
		return assets[i].Name < assets[j].Name
	})
	return assets, nil
}

func (m *Manager) ExportLocalAsset(localAssetID string) (LocalAssetExport, error) {
	assets, err := m.LocalAssets()
	if err != nil {
		return LocalAssetExport{}, err
	}

	for _, asset := range assets {
		if asset.LocalAssetID != localAssetID {
			continue
		}

		files, err := m.assetExportFiles(asset)
		if err != nil {
			return LocalAssetExport{}, err
		}
		warnings := mergeWarnings(asset.Warnings, contentWarnings(files), m.consumeExportSkipWarning(asset.LocalAssetID))

		export := LocalAssetExport{
			LocalAssetID: asset.LocalAssetID,
			Type:         asset.Type,
			Slug:         asset.Slug,
			Name:         asset.Name,
			Summary:      "Položka nahraná z lokální instalace Claude Code.",
			Description:  exportDescription(asset),
			Version:      "0.1.0",
			Risk:         exportRisk(asset.Type),
			Warnings:     warnings,
			RequiredEnv:  []string{},
			Files:        files,
		}

		return export, nil
	}

	return LocalAssetExport{}, errors.New("lokální položka nebyla nalezena")
}

func exportDescription(asset LocalAsset) string {
	if asset.Scope == "project" && asset.ProjectName != "" {
		return "Položka pochází z projektu " + asset.ProjectName + "."
	}
	return "Položka pochází z uživatelské instalace Claude Code."
}

func exportRisk(assetType AssetType) RiskLevel {
	switch assetType {
	case AssetTypeSkill:
		return RiskLow
	case AssetTypeCommand, AssetTypeConfig:
		return RiskMedium
	default:
		return RiskHigh
	}
}

func (m *Manager) skillAssets(skillsRoot string, scope string, projectName string, projectPath string, projectSlug string, managedByHub bool) []LocalAsset {
	entries, err := os.ReadDir(skillsRoot)
	if err != nil {
		return nil
	}

	assets := make([]LocalAsset, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		slug := Slugify(entry.Name())
		filePath := filepath.Join(skillsRoot, entry.Name(), "SKILL.md")
		content, err := os.ReadFile(filePath)
		if err != nil {
			continue
		}
		assets = append(assets, LocalAsset{
			LocalAssetID: localAssetID(scope, projectSlug, AssetTypeSkill, slug),
			Type:         AssetTypeSkill,
			Slug:         slug,
			Name:         markdownTitle(string(content), entry.Name()),
			Path:         filePath,
			Scope:        scope,
			ProjectName:  projectName,
			ProjectPath:  projectPath,
			ManagedByHub: managedByHub,
			Warnings:     textWarnings(string(content)),
		})
	}
	return assets
}

func (m *Manager) commandAssets(commandsRoot string, scope string, projectName string, projectPath string, projectSlug string, managedByHub bool) []LocalAsset {
	entries, err := os.ReadDir(commandsRoot)
	if err != nil {
		return nil
	}

	assets := make([]LocalAsset, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".md") {
			continue
		}
		slug := Slugify(strings.TrimSuffix(entry.Name(), ".md"))
		filePath := filepath.Join(commandsRoot, entry.Name())
		content, err := os.ReadFile(filePath)
		if err != nil {
			continue
		}
		assets = append(assets, LocalAsset{
			LocalAssetID: localAssetID(scope, projectSlug, AssetTypeCommand, slug),
			Type:         AssetTypeCommand,
			Slug:         slug,
			Name:         markdownTitle(string(content), "/"+slug),
			Path:         filePath,
			Scope:        scope,
			ProjectName:  projectName,
			ProjectPath:  projectPath,
			ManagedByHub: managedByHub,
			Warnings:     textWarnings(string(content)),
		})
	}
	return assets
}

func (m *Manager) entryAssets(root string, assetType AssetType, fallbackName string, scope string, projectName string, projectPath string) []LocalAsset {
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil
	}

	assets := make([]LocalAsset, 0, len(entries))
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		itemPath := filepath.Join(root, entry.Name())
		slug := Slugify(strings.TrimSuffix(entry.Name(), filepath.Ext(entry.Name())))
		name, warnings := m.entryMetadata(itemPath, entry, fallbackName)
		projectSlug := projectSlugFromPath(projectPath)
		assets = append(assets, LocalAsset{
			LocalAssetID: localAssetID(scope, projectSlug, assetType, slug),
			Type:         assetType,
			Slug:         slug,
			Name:         name,
			Path:         itemPath,
			Scope:        scope,
			ProjectName:  projectName,
			ProjectPath:  projectPath,
			ManagedByHub: false,
			Warnings:     warnings,
		})
	}
	return assets
}

func (m *Manager) entryMetadata(path string, entry os.DirEntry, fallbackName string) (string, []string) {
	fallback := strings.TrimSuffix(entry.Name(), filepath.Ext(entry.Name()))
	if fallback == "" {
		fallback = fallbackName
	}

	if !entry.IsDir() {
		content, err := readSmallTextFile(path)
		if err != nil {
			return fallback, nil
		}
		return markdownTitle(content, fallback), textWarnings(content)
	}

	for _, candidate := range []string{
		filepath.Join(path, "README.md"),
		filepath.Join(path, "plugin.json"),
		filepath.Join(path, ".claude-plugin", "plugin.json"),
		filepath.Join(path, "hook.json"),
	} {
		content, err := readSmallTextFile(candidate)
		if err == nil {
			return markdownTitle(content, fallback), textWarnings(content)
		}
	}

	return fallback, nil
}

func (m *Manager) pluginAssets() []LocalAsset {
	pluginFile := filepath.Join(m.ClaudeHome, "plugins", "installed_plugins.json")
	var installed installedPluginsFile
	if err := readJSON(pluginFile, &installed); err != nil {
		return nil
	}

	assets := make([]LocalAsset, 0)
	for pluginKey, entries := range installed.Plugins {
		pluginSlug := Slugify(pluginKey)
		if len(entries) == 0 {
			assets = append(assets, LocalAsset{
				LocalAssetID: "plugin:" + pluginSlug,
				Type:         AssetTypePlugin,
				Slug:         pluginSlug,
				Name:         pluginKey,
				Path:         pluginFile,
				Scope:        "user",
				ManagedByHub: false,
			})
			continue
		}

		asset, ok := m.pluginAsset(pluginKey, pluginSlug, entries, pluginFile)
		if ok {
			assets = append(assets, asset)
		}
	}

	return assets
}

func (m *Manager) pluginAsset(pluginKey string, pluginSlug string, entries []installedPluginEntry, pluginFile string) (LocalAsset, bool) {
	type pluginCandidate struct {
		entry installedPluginEntry
		path  string
	}

	candidates := make([]pluginCandidate, 0, len(entries))
	projects := map[string]bool{}
	versions := map[string]bool{}
	missingPath := false

	for _, entry := range entries {
		scope := strings.TrimSpace(entry.Scope)
		if scope != "project" {
			scope = "user"
		}

		projectPath := strings.TrimSpace(entry.ProjectPath)
		projectName := ""
		if scope == "project" && projectPath != "" {
			projectName = baseName(projectPath)
			projects[projectName] = true
		}
		if strings.TrimSpace(entry.Version) != "" {
			versions[strings.TrimSpace(entry.Version)] = true
		}

		path := m.translateClaudeStoredPath(firstNonEmpty(entry.InstallPath, pluginFile))
		if path != "" && !exists(path) {
			missingPath = true
		}

		candidates = append(candidates, pluginCandidate{
			entry: entry,
			path:  path,
		})
	}

	if len(candidates) == 0 {
		return LocalAsset{}, false
	}

	sort.SliceStable(candidates, func(i, j int) bool {
		left := candidates[i]
		right := candidates[j]
		if exists(left.path) != exists(right.path) {
			return exists(left.path)
		}
		if strings.TrimSpace(left.entry.Version) != strings.TrimSpace(right.entry.Version) {
			return strings.TrimSpace(left.entry.Version) > strings.TrimSpace(right.entry.Version)
		}
		return left.path < right.path
	})

	selected := candidates[0]
	warnings := []string(nil)
	if missingPath {
		warnings = append(warnings, "Cesta k nainstalovanému pluginu nebyla nalezena. Metadata pluginu lze i tak sdílet.")
	}
	if len(entries) > 1 {
		warnings = append(warnings, pluginUsageSummary(len(entries), projects, versions))
	}

	return LocalAsset{
		LocalAssetID: "plugin:" + pluginSlug,
		Type:         AssetTypePlugin,
		Slug:         pluginSlug,
		Name:         pluginKey,
		Path:         selected.path,
		Scope:        "user",
		ProjectName:  "",
		ProjectPath:  "",
		ManagedByHub: false,
		Warnings:     warnings,
	}, true
}

func pluginUsageSummary(entryCount int, projects map[string]bool, versions map[string]bool) string {
	parts := []string{fmt.Sprintf("Plugin je nainstalovaný ve %d kontextech", entryCount)}
	if len(projects) > 0 {
		parts = append(parts, fmt.Sprintf("projekty: %s", sortedKeysText(projects)))
	}
	if len(versions) > 1 {
		parts = append(parts, fmt.Sprintf("verze: %s", sortedKeysText(versions)))
	}
	return strings.Join(parts, "; ") + "."
}

func sortedKeysText(values map[string]bool) string {
	keys := make([]string, 0, len(values))
	for value := range values {
		if strings.TrimSpace(value) != "" {
			keys = append(keys, value)
		}
	}
	sort.Strings(keys)
	return strings.Join(keys, ", ")
}

// splitMcpServerPath rozdělí cestu typu "<file> :: mcpServers.<key>" na
// (soubor, klíč serveru). Vrátí (path, "", false) pokud řetězec není v očekávaném formátu.
func splitMcpServerPath(path string) (string, string, bool) {
	const sep = " :: mcpServers."
	idx := strings.Index(path, sep)
	if idx < 0 {
		return path, "", false
	}
	filePart := strings.TrimSpace(path[:idx])
	keyPart := strings.TrimSpace(path[idx+len(sep):])
	if filePart == "" || keyPart == "" {
		return path, "", false
	}
	return filePart, keyPart, true
}

// shareableSettingsSections obsahuje seznam sekcí settings.json, které lze
// sdílet skrz Claude Hub. Hooks má vlastní typ a permissions/apiKeyHelper jsou
// příliš osobní (cesty, přístupy), proto se nedetekují.
var shareableSettingsSections = []string{
	"env",
	"model",
	"statusLine",
	"includeCoAuthoredBy",
	"cleanupPeriodDays",
}

// settingsConfigAssets vrátí jeden LocalAsset za každou whitelistovanou sekci,
// kterou daný settings.json obsahuje. Granularita 1 sekce = 1 sdílitelná položka.
func (m *Manager) settingsConfigAssets(path string, scope string, projectName string, projectPath string, localIDPrefix string) []LocalAsset {
	doc, err := readSettingsDoc(path)
	if err != nil || doc == nil || len(doc.Sections) == 0 {
		return nil
	}
	assets := make([]LocalAsset, 0)
	for _, section := range shareableSettingsSections {
		value, ok := doc.Sections[section]
		if !ok || len(value) == 0 || string(value) == "null" {
			continue
		}
		assets = append(assets, LocalAsset{
			LocalAssetID: localIDPrefix + ":" + section,
			Type:         AssetTypeConfig,
			Slug:         section,
			Name:         "Nastavení: " + section,
			Path:         path + " :: " + section,
			Scope:        scope,
			ProjectName:  projectName,
			ProjectPath:  projectPath,
			ManagedByHub: false,
			Warnings:     textWarnings(string(value)),
		})
	}
	return assets
}

// splitSettingsSectionPath rozdělí cestu typu "<file> :: <sectionKey>".
func splitSettingsSectionPath(path string) (string, string, bool) {
	const sep = " :: "
	idx := strings.Index(path, sep)
	if idx < 0 {
		return path, "", false
	}
	filePart := strings.TrimSpace(path[:idx])
	keyPart := strings.TrimSpace(path[idx+len(sep):])
	if filePart == "" || keyPart == "" {
		return path, "", false
	}
	return filePart, keyPart, true
}

// userClaudeJsonPath vrací cestu k user-level .claude.json souboru, který
// Claude Code CLI fakticky používá k uchování per-user MCP konfigurace.
// Soubor leží vedle adresáře .claude/ (nikoli uvnitř něj).
func (m *Manager) userClaudeJsonPath() string {
	return filepath.Join(filepath.Dir(m.ClaudeHome), ".claude.json")
}

// readMcpServersFile přečte mcpServers sekci z libovolného JSON souboru,
// který tuto sekci obsahuje (.mcp.json i .claude.json). Vrací nil, pokud
// soubor neexistuje nebo žádné servery neobsahuje.
func readMcpServersFile(path string) map[string]json.RawMessage {
	doc, err := readMCPDoc(path)
	if err != nil || doc == nil {
		return nil
	}
	if len(doc.MCPServers) == 0 {
		return nil
	}
	return doc.MCPServers
}

// mcpServerAssets vrátí jeden LocalAsset za každý MCP server v daném souboru.
// Granularita 1 server = 1 sdílitelná položka.
func (m *Manager) mcpServerAssets(path string, scope string, projectName string, projectPath string, localIDPrefix string) []LocalAsset {
	servers := readMcpServersFile(path)
	if len(servers) == 0 {
		return nil
	}

	assets := make([]LocalAsset, 0, len(servers))
	for key, value := range servers {
		slug := Slugify(key)
		if slug == "" {
			continue
		}
		assets = append(assets, LocalAsset{
			LocalAssetID: localIDPrefix + ":" + slug,
			Type:         AssetTypeMCP,
			Slug:         slug,
			Name:         "MCP: " + key,
			Path:         path + " :: mcpServers." + key,
			Scope:        scope,
			ProjectName:  projectName,
			ProjectPath:  projectPath,
			ManagedByHub: false,
			Warnings:     textWarnings(string(value)),
		})
	}
	return assets
}

// userMcpAssets sloučí servery z ~/.claude.json (primary) a ~/.claude/.mcp.json
// (fallback). Pokud se server vyskytuje v obou, .claude.json má přednost.
func (m *Manager) userMcpAssets() []LocalAsset {
	seen := map[string]bool{}
	assets := make([]LocalAsset, 0)
	for _, item := range m.mcpServerAssets(m.userClaudeJsonPath(), "user", "", "", "mcp:user") {
		if seen[item.Slug] {
			continue
		}
		seen[item.Slug] = true
		assets = append(assets, item)
	}
	for _, item := range m.mcpServerAssets(filepath.Join(m.ClaudeHome, ".mcp.json"), "user", "", "", "mcp:user:legacy") {
		if seen[item.Slug] {
			continue
		}
		seen[item.Slug] = true
		assets = append(assets, item)
	}
	return assets
}

func (m *Manager) settingsHookAsset(path string, localID string, name string, scope string, projectName string, projectPath string) []LocalAsset {
	hooks, err := readSettingsSection(path, "hooks")
	if err != nil || len(hooks) == 0 {
		return nil
	}

	return []LocalAsset{{
		LocalAssetID: localID,
		Type:         AssetTypeHook,
		Slug:         Slugify(name),
		Name:         name,
		Path:         path,
		Scope:        scope,
		ProjectName:  projectName,
		ProjectPath:  projectPath,
		ManagedByHub: false,
		Warnings:     textWarnings(string(hooks)),
	}}
}

func (m *Manager) workspaceAssets() ([]LocalAsset, error) {
	roots := workspaceRoots()
	assets := make([]LocalAsset, 0)

	for _, root := range roots {
		err := filepath.WalkDir(root, func(current string, entry os.DirEntry, walkErr error) error {
			if walkErr != nil {
				return nil
			}
			if !entry.IsDir() {
				return nil
			}
			if current != root && skippedWorkspaceDirs[entry.Name()] {
				return filepath.SkipDir
			}
			if entry.Name() != ".claude" {
				return nil
			}

			projectRoot := filepath.Dir(current)
			projectName := filepath.Base(projectRoot)
			projectSlug := projectSlugFromPath(projectRoot)
			assets = append(assets, m.workspaceClaudeDirAssets(current, projectRoot, projectName, projectSlug)...)
			return filepath.SkipDir
		})
		if err != nil && !os.IsNotExist(err) {
			return nil, err
		}
	}

	return assets, nil
}

func (m *Manager) workspaceClaudeDirAssets(claudeDir string, projectRoot string, projectName string, projectSlug string) []LocalAsset {
	assets := make([]LocalAsset, 0)
	assets = append(assets, m.skillAssets(filepath.Join(claudeDir, "skills"), "project", projectName, projectRoot, projectSlug, false)...)
	assets = append(assets, m.commandAssets(filepath.Join(claudeDir, "commands"), "project", projectName, projectRoot, projectSlug, false)...)
	assets = append(assets, m.entryAssets(filepath.Join(claudeDir, "hooks"), AssetTypeHook, "Hook", "project", projectName, projectRoot)...)
	assets = append(assets, m.settingsHookAsset(filepath.Join(claudeDir, "settings.json"), "project:"+projectSlug+":hook:settings", projectName+" - nastavení hooků", "project", projectName, projectRoot)...)
	assets = append(assets, m.entryAssets(filepath.Join(claudeDir, "plugins"), AssetTypePlugin, "Plugin", "project", projectName, projectRoot)...)
	assets = append(assets, m.mcpServerAssets(filepath.Join(claudeDir, ".mcp.json"), "project", projectName, projectRoot, "project:"+projectSlug+":mcp")...)
	assets = append(assets, m.mcpServerAssets(filepath.Join(projectRoot, ".mcp.json"), "project", projectName, projectRoot, "project:"+projectSlug+":mcp-root")...)
	assets = append(assets, m.settingsConfigAssets(filepath.Join(claudeDir, "settings.json"), "project", projectName, projectRoot, "project:"+projectSlug+":config")...)
	return assets
}

func (m *Manager) translateClaudeStoredPath(value string) string {
	if strings.TrimSpace(value) == "" {
		return value
	}

	normalized := strings.ReplaceAll(value, "\\", string(os.PathSeparator))
	cleaned := filepath.Clean(normalized)
	parts := strings.Split(cleaned, string(os.PathSeparator))
	for index, part := range parts {
		if strings.EqualFold(part, ".claude") && index+1 < len(parts) {
			return filepath.Join(append([]string{m.ClaudeHome}, parts[index+1:]...)...)
		}
	}
	return cleaned
}

func (m *Manager) assetExportFiles(asset LocalAsset) ([]AssetFile, error) {
	source := asset.Path
	if asset.Type == AssetTypeSkill && strings.EqualFold(filepath.Base(source), "SKILL.md") {
		source = filepath.Dir(source)
	}
	if asset.Type == AssetTypeHook && strings.EqualFold(filepath.Base(source), "settings.json") {
		return settingsSectionExport(source, "hooks", "settings.hooks.json")
	}
	if asset.Type == AssetTypeMCP {
		filePath, serverKey, ok := splitMcpServerPath(source)
		if !ok {
			return nil, errors.New("MCP položka nemá platnou cestu k serveru")
		}
		servers := readMcpServersFile(filePath)
		raw, exists := servers[serverKey]
		if !exists {
			return nil, fmt.Errorf("MCP server %q už v souboru %s není", serverKey, filePath)
		}
		payload := map[string]map[string]json.RawMessage{
			"mcpServers": {serverKey: raw},
		}
		content, err := json.MarshalIndent(payload, "", "  ")
		if err != nil {
			return nil, err
		}
		return []AssetFile{{
			Path:    "mcp.json",
			Content: string(content),
		}}, nil
	}
	if asset.Type == AssetTypeConfig {
		filePath, sectionKey, ok := splitSettingsSectionPath(source)
		if !ok {
			return nil, errors.New("config položka nemá platnou cestu k sekci")
		}
		doc, err := readSettingsDoc(filePath)
		if err != nil {
			return nil, err
		}
		value, exists := doc.Sections[sectionKey]
		if !exists {
			return nil, fmt.Errorf("sekce %q už v %s není", sectionKey, filePath)
		}
		payload := map[string]json.RawMessage{sectionKey: value}
		content, err := json.MarshalIndent(payload, "", "  ")
		if err != nil {
			return nil, err
		}
		return []AssetFile{{
			Path:    "settings." + sectionKey + ".json",
			Content: string(content),
		}}, nil
	}

	info, err := os.Stat(source)
	if err != nil {
		return nil, err
	}

	if !info.IsDir() {
		content, err := readSmallTextFile(source)
		if err != nil {
			return nil, err
		}
		return []AssetFile{{
			Path:    exportFileName(asset, source),
			Content: content,
		}}, nil
	}

	files := make([]AssetFile, 0)
	skipped := make([]string, 0)
	err = filepath.WalkDir(source, func(current string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return nil
		}
		if current != source && entry.IsDir() && skippedWorkspaceDirs[entry.Name()] {
			return filepath.SkipDir
		}
		if entry.IsDir() {
			return nil
		}
		relative, err := filepath.Rel(source, current)
		if err != nil {
			return err
		}
		if shouldSkipExportFile(entry.Name()) {
			skipped = append(skipped, filepath.ToSlash(relative))
			return nil
		}
		content, err := readSmallTextFile(current)
		if err != nil {
			skipped = append(skipped, filepath.ToSlash(relative))
			return nil
		}
		files = append(files, AssetFile{
			Path:    filepath.ToSlash(relative),
			Content: content,
		})
		return nil
	})
	if err != nil {
		return nil, err
	}
	if len(files) == 0 {
		return nil, errors.New("lokální položka nemá žádné sdílitelné textové soubory")
	}

	sort.Slice(files, func(i, j int) bool {
		return files[i].Path < files[j].Path
	})

	if len(skipped) > 0 {
		m.recordExportSkipWarning(asset, skipped)
	}

	return files, nil
}

// recordExportSkipWarning si poznamená přeskočené soubory do paměti per export volání.
// Konkrétní warning text se přidá v ExportLocalAsset z těchto stop.
var exportSkipMemory sync.Map

func (m *Manager) recordExportSkipWarning(asset LocalAsset, skipped []string) {
	exportSkipMemory.Store(asset.LocalAssetID, skipped)
}

func (m *Manager) consumeExportSkipWarning(localAssetID string) []string {
	value, ok := exportSkipMemory.LoadAndDelete(localAssetID)
	if !ok {
		return nil
	}
	skipped, ok := value.([]string)
	if !ok || len(skipped) == 0 {
		return nil
	}
	count := len(skipped)
	preview := strings.Join(skipped, ", ")
	if count > 5 {
		preview = strings.Join(skipped[:5], ", ") + ", …"
	}
	return []string{fmt.Sprintf("Přeskočeno %d souborů (binární nebo příliš velké pro sdílení): %s.", count, preview)}
}

func (m *Manager) assetState(asset CatalogAsset, localIndex map[string]LocalAsset) (LocalAssetState, error) {
	if err := validateSupported(asset); err != nil {
		return LocalAssetState{
			AssetID:        asset.ID,
			Type:           asset.Type,
			Slug:           asset.Slug,
			State:          "unsupported",
			Installed:      false,
			Enabled:        false,
			ManagedByHub:   false,
			CatalogVersion: asset.Version,
			Warnings:       []string{err.Error()},
		}, nil
	}

	paths := m.paths(asset)
	record, _ := readManifest(paths.Manifest)
	targetExists := exists(paths.TargetFile)
	disabledExists := exists(paths.DisabledFile)

	mergeType := asset.Type == AssetTypeMCP || asset.Type == AssetTypeHook || asset.Type == AssetTypeConfig
	installed := false
	enabled := false
	if mergeType {
		installed = record != nil
		if record != nil {
			enabled = record.Enabled
		}
	} else {
		installed = targetExists || disabledExists
		enabled = targetExists
	}
	matchedLocalAsset, hasLocalMatch := localIndex[assetIdentityKey(asset.Type, asset.Slug)]
	if !installed && hasLocalMatch {
		installed = true
		enabled = true
	}
	localVersion := ""
	if record != nil {
		localVersion = record.Version
	}

	localChanges := false
	if installed && record != nil && record.ContentFingerprint != "" {
		content := ""
		if enabled {
			content = readText(paths.TargetFile)
		} else {
			content = readText(paths.DisabledFile)
		}
		localChanges = shaText(content) != record.ContentFingerprint
	}

	updateAvailable := installed && localVersion != "" && localVersion != asset.Version
	state := "not_installed"
	switch {
	case localChanges:
		state = "local_changes"
	case updateAvailable:
		state = "update_available"
	case enabled:
		state = "enabled"
	case installed:
		state = "disabled"
	}

	return LocalAssetState{
		AssetID:         asset.ID,
		Type:            asset.Type,
		Slug:            asset.Slug,
		State:           state,
		Installed:       installed,
		Enabled:         enabled,
		ManagedByHub:    record != nil,
		LocalVersion:    localVersion,
		CatalogVersion:  asset.Version,
		LocalChanges:    localChanges,
		UpdateAvailable: updateAvailable,
		Warnings:        stateWarnings(asset, matchedLocalAsset, hasLocalMatch && record == nil, record != nil && !installed),
	}, nil
}

func (m *Manager) localInstalledIndex() (map[string]LocalAsset, error) {
	assets, err := m.LocalAssets()
	if err != nil {
		return nil, err
	}

	index := make(map[string]LocalAsset, len(assets))
	for _, asset := range assets {
		if asset.Type != AssetTypeSkill && asset.Type != AssetTypeCommand {
			continue
		}
		key := assetIdentityKey(asset.Type, asset.Slug)
		if _, exists := index[key]; exists {
			continue
		}
		index[key] = asset
	}
	return index, nil
}

func assetIdentityKey(assetType AssetType, slug string) string {
	return string(assetType) + ":" + Slugify(slug)
}

func stateWarnings(asset CatalogAsset, localAsset LocalAsset, localMatchWithoutManifest bool, orphanManifest bool) []string {
	warnings := contentWarnings(asset.Files)
	if localMatchWithoutManifest {
		warnings = append(warnings, fmt.Sprintf("Položka už v Claude Code existuje (%s), ale nepochází z instalace přes Claude Hub.", scopeLabel(localAsset.Scope)))
	}
	if orphanManifest {
		warnings = append(warnings, "Claude Hub má k položce uložený záznam, ale lokální soubor už neexistuje.")
	}
	sort.Strings(warnings)
	return warnings
}

func (m *Manager) paths(asset CatalogAsset) assetPaths {
	manifestPath := filepath.Join(m.HubHome, "installed", string(asset.Type)+"-"+asset.Slug+".json")
	switch asset.Type {
	case AssetTypeSkill:
		return assetPaths{
			TargetRoot:   filepath.Join(m.ClaudeHome, "skills", asset.Slug),
			TargetFile:   filepath.Join(m.ClaudeHome, "skills", asset.Slug, "SKILL.md"),
			DisabledRoot: filepath.Join(m.HubHome, "disabled", "skills", asset.Slug),
			DisabledFile: filepath.Join(m.HubHome, "disabled", "skills", asset.Slug, "SKILL.md"),
			Manifest:     manifestPath,
		}
	case AssetTypeMCP:
		// Primární cíl je user-level ~/.claude.json (kam CLI ukládá MCP servery).
		// Pokud uživatel nemá ~/.claude.json (čerstvá instalace nebo jen .mcp.json),
		// zapisujeme do legacy ~/.claude/.mcp.json.
		target := m.userClaudeJsonPath()
		if !exists(target) {
			target = filepath.Join(m.ClaudeHome, ".mcp.json")
		}
		return assetPaths{
			TargetRoot:   target,
			TargetFile:   target,
			DisabledRoot: filepath.Join(m.HubHome, "disabled", "mcp", asset.Slug+".json"),
			DisabledFile: filepath.Join(m.HubHome, "disabled", "mcp", asset.Slug+".json"),
			Manifest:     manifestPath,
		}
	case AssetTypeHook:
		target := filepath.Join(m.ClaudeHome, "settings.json")
		return assetPaths{
			TargetRoot:   target,
			TargetFile:   target,
			DisabledRoot: filepath.Join(m.HubHome, "disabled", "hooks", asset.Slug+".json"),
			DisabledFile: filepath.Join(m.HubHome, "disabled", "hooks", asset.Slug+".json"),
			Manifest:     manifestPath,
		}
	case AssetTypePlugin:
		root := filepath.Join(m.ClaudeHome, "plugins", asset.Slug)
		return assetPaths{
			TargetRoot:   root,
			TargetFile:   filepath.Join(root, "plugin.json"),
			DisabledRoot: filepath.Join(m.HubHome, "disabled", "plugins", asset.Slug),
			DisabledFile: filepath.Join(m.HubHome, "disabled", "plugins", asset.Slug, "plugin.json"),
			Manifest:     manifestPath,
		}
	case AssetTypeConfig:
		// Config asset merguje jednu sekci do ~/.claude/settings.json.
		// Slug nese název sekce (env, model, statusLine, ...).
		target := filepath.Join(m.ClaudeHome, "settings.json")
		return assetPaths{
			TargetRoot:   target,
			TargetFile:   target,
			DisabledRoot: filepath.Join(m.HubHome, "disabled", "configs", asset.Slug+".json"),
			DisabledFile: filepath.Join(m.HubHome, "disabled", "configs", asset.Slug+".json"),
			Manifest:     manifestPath,
		}
	}

	return assetPaths{
		TargetRoot:   filepath.Join(m.ClaudeHome, "commands", asset.Slug+".md"),
		TargetFile:   filepath.Join(m.ClaudeHome, "commands", asset.Slug+".md"),
		DisabledRoot: filepath.Join(m.HubHome, "disabled", "commands", asset.Slug+".md"),
		DisabledFile: filepath.Join(m.HubHome, "disabled", "commands", asset.Slug+".md"),
		Manifest:     manifestPath,
	}
}

func (m *Manager) backup(paths assetPaths, asset CatalogAsset) (string, error) {
	if !exists(paths.TargetRoot) && !exists(paths.DisabledRoot) && !exists(paths.Manifest) {
		return "", nil
	}

	stamp := time.Now().UTC().Format("20060102T150405Z")
	backupRoot := filepath.Join(m.HubHome, "backups", stamp+"-"+string(asset.Type)+"-"+asset.Slug)
	if err := os.MkdirAll(backupRoot, 0o755); err != nil {
		return "", err
	}

	if exists(paths.TargetRoot) {
		if err := copyPath(paths.TargetRoot, filepath.Join(backupRoot, "enabled")); err != nil {
			return "", err
		}
	}
	if exists(paths.DisabledRoot) {
		if err := copyPath(paths.DisabledRoot, filepath.Join(backupRoot, "disabled")); err != nil {
			return "", err
		}
	}
	if exists(paths.Manifest) {
		if err := copyPath(paths.Manifest, filepath.Join(backupRoot, "manifest.json")); err != nil {
			return "", err
		}
	}
	return backupRoot, nil
}

func normalizeAsset(asset CatalogAsset) CatalogAsset {
	if asset.Slug == "" {
		asset.Slug = Slugify(firstNonEmpty(asset.ID, asset.Name))
	}
	if asset.ID == "" {
		asset.ID = asset.Slug
	}
	if asset.Version == "" {
		asset.Version = "0.1.0"
	}
	return asset
}

func validateSupported(asset CatalogAsset) error {
	switch asset.Type {
	case AssetTypeSkill, AssetTypeCommand, AssetTypeMCP, AssetTypeHook, AssetTypePlugin, AssetTypeConfig:
		// OK — všechny typy jsou nyní podporované, jen některé skrz merge logiku
	default:
		return fmt.Errorf("tato verze lokální služby nepodporuje typ položky %q", asset.Type)
	}
	if asset.Slug == "" {
		return errors.New("chybí technický název položky (slug)")
	}
	if len(asset.Files) == 0 {
		return errors.New("položka neobsahuje žádné soubory")
	}
	for _, file := range asset.Files {
		if _, err := SafeRelativePath(file.Path); err != nil {
			return err
		}
	}
	return nil
}

func writeAssetFiles(targetRoot string, asset CatalogAsset) error {
	if asset.Type == AssetTypeCommand {
		if err := os.MkdirAll(filepath.Dir(targetRoot), 0o755); err != nil {
			return err
		}
		return os.WriteFile(targetRoot, []byte(asset.Files[0].Content), 0o644)
	}

	if err := os.MkdirAll(targetRoot, 0o755); err != nil {
		return err
	}

	for _, file := range asset.Files {
		safePath, err := SafeRelativePath(file.Path)
		if err != nil {
			return err
		}
		target := filepath.Join(targetRoot, safePath)
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(target, []byte(file.Content), 0o644); err != nil {
			return err
		}
	}
	return nil
}

func contentWarnings(files []AssetFile) []string {
	seen := map[string]bool{}
	for _, file := range files {
		for _, warning := range textWarnings(file.Content) {
			seen[warning] = true
		}
	}
	warnings := make([]string, 0, len(seen))
	for warning := range seen {
		warnings = append(warnings, warning)
	}
	sort.Strings(warnings)
	return warnings
}

func textWarnings(content string) []string {
	warnings := make([]string, 0, 2)
	if secretLikePattern.MatchString(content) {
		warnings = append(warnings, "Text pravděpodobně obsahuje token, heslo nebo klíč. Před sdílením ho zkontrolujte.")
	}
	if localPathPattern.MatchString(content) {
		warnings = append(warnings, "Text obsahuje cestu svázanou s konkrétním počítačem.")
	}
	return warnings
}

func markdownTitle(content string, fallback string) string {
	for _, line := range strings.Split(content, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "# ") {
			return strings.TrimSpace(strings.TrimPrefix(line, "# "))
		}
	}
	return fallback
}

func workspaceRoots() []string {
	raw := firstNonEmpty(os.Getenv("CLAUDE_HUB_WORKSPACE_ROOTS"), os.Getenv("CLAUDE_HUB_WORKSPACE_ROOT"))
	if strings.TrimSpace(raw) == "" {
		return nil
	}

	roots := make([]string, 0)
	for _, item := range filepath.SplitList(raw) {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		roots = append(roots, filepath.Clean(item))
	}
	return roots
}

func localAssetID(scope string, projectSlug string, assetType AssetType, slug string) string {
	if scope == "project" {
		return "project:" + projectSlug + ":" + string(assetType) + ":" + slug
	}
	return string(assetType) + ":" + slug
}

func projectSlugFromPath(path string) string {
	if strings.TrimSpace(path) == "" {
		return ""
	}
	return Slugify(baseName(path) + "-" + shortHash(path))
}

func baseName(path string) string {
	normalized := strings.TrimRight(strings.ReplaceAll(path, "\\", "/"), "/")
	if normalized == "" {
		return ""
	}
	index := strings.LastIndex(normalized, "/")
	if index == -1 {
		return normalized
	}
	return normalized[index+1:]
}

func shortHash(value string) string {
	sum := sha256.Sum256([]byte(strings.ToLower(filepath.Clean(value))))
	return hex.EncodeToString(sum[:])[:10]
}

func readSmallTextFile(path string) (string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if info.IsDir() {
		return "", errors.New("zadaná cesta je složka, ne soubor")
	}
	if info.Size() > maxExportFileSize {
		return "", fmt.Errorf("soubor %s je příliš velký pro bezpečné sdílení jako text", path)
	}

	content, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	if !utf8.Valid(content) {
		return "", fmt.Errorf("soubor %s není platný text v UTF-8", path)
	}
	return string(content), nil
}

func readSettingsSection(path string, section string) (json.RawMessage, error) {
	content, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	var settings map[string]json.RawMessage
	if err := json.Unmarshal(content, &settings); err != nil {
		return nil, err
	}

	raw, ok := settings[section]
	if !ok || len(raw) == 0 || string(raw) == "null" || string(raw) == "{}" {
		return nil, errors.New("sekce settings je prázdná")
	}
	return raw, nil
}

func settingsSectionExport(path string, section string, fileName string) ([]AssetFile, error) {
	raw, err := readSettingsSection(path, section)
	if err != nil {
		return nil, err
	}

	var sectionValue any
	if err := json.Unmarshal(raw, &sectionValue); err != nil {
		return nil, err
	}
	content, err := json.MarshalIndent(map[string]any{section: sectionValue}, "", "  ")
	if err != nil {
		return nil, err
	}

	return []AssetFile{{
		Path:    fileName,
		Content: string(append(content, '\n')),
	}}, nil
}

func exportFileName(asset LocalAsset, source string) string {
	switch asset.Type {
	case AssetTypeSkill:
		return "SKILL.md"
	case AssetTypeCommand:
		return asset.Slug + ".md"
	case AssetTypeMCP:
		return ".mcp.json"
	default:
		return filepath.Base(source)
	}
}

func shouldSkipExportFile(name string) bool {
	lower := strings.ToLower(name)
	switch lower {
	case ".ds_store", "thumbs.db":
		return true
	}
	for _, suffix := range []string{".exe", ".dll", ".so", ".dylib", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".zip", ".tar", ".gz", ".pyc"} {
		if strings.HasSuffix(lower, suffix) {
			return true
		}
	}
	return false
}

func mergeWarnings(groups ...[]string) []string {
	seen := map[string]bool{}
	for _, group := range groups {
		for _, warning := range group {
			if strings.TrimSpace(warning) != "" {
				seen[warning] = true
			}
		}
	}

	warnings := make([]string, 0, len(seen))
	for warning := range seen {
		warnings = append(warnings, warning)
	}
	sort.Strings(warnings)
	return warnings
}

func normalizeLocalAssetSlices(assets []LocalAsset) {
	for index := range assets {
		if assets[index].Warnings == nil {
			assets[index].Warnings = []string{}
		}
	}
}

func scopeRank(scope string) int {
	if scope == "user" {
		return 0
	}
	return 1
}

func scopeLabel(scope string) string {
	if scope == "project" {
		return "projekt"
	}
	return "osobní"
}

func readManifest(path string) (*manifest, error) {
	var record manifest
	if err := readJSON(path, &record); err != nil {
		return nil, err
	}
	return &record, nil
}

func writeJSON(path string, value any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	bytes, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(bytes, '\n'), 0o644)
}

func readJSON(path string, value any) error {
	bytes, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(bytes, value)
}

func copyPath(source string, destination string) error {
	info, err := os.Stat(source)
	if err != nil {
		return err
	}
	if info.IsDir() {
		return filepath.WalkDir(source, func(current string, entry os.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			relative, err := filepath.Rel(source, current)
			if err != nil {
				return err
			}
			target := filepath.Join(destination, relative)
			if entry.IsDir() {
				return os.MkdirAll(target, 0o755)
			}
			content, err := os.ReadFile(current)
			if err != nil {
				return err
			}
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			return os.WriteFile(target, content, 0o644)
		})
	}
	content, err := os.ReadFile(source)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(destination), 0o755); err != nil {
		return err
	}
	return os.WriteFile(destination, content, 0o644)
}

func moveIfExists(source string, destination string) error {
	if !exists(source) {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(destination), 0o755); err != nil {
		return err
	}
	_ = os.RemoveAll(destination)
	return os.Rename(source, destination)
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func readText(path string) string {
	content, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return string(content)
}

func shaText(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func fingerprint(asset CatalogAsset) string {
	bytes, _ := json.Marshal(asset)
	return shaText(string(bytes))
}

func firstExisting(values ...string) string {
	for _, value := range values {
		if exists(value) {
			return value
		}
	}
	return ""
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
