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
	"strconv"
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

	// GitAuth obsluhuje plugin recipe install/update — klonování marketplace
	// repos pres systémový git s auth fallback ladderem (Vrstva 1 system creds,
	// Vrstva 2 PAT z OS keychainu). Nil v testech, které ne testují plugin
	// recipe lifecycle. Server.go ho injektuje při startu daemonu.
	GitAuth GitAuthRunner

	locksMu          sync.Mutex
	locks            map[string]*sync.Mutex
	marketplaceLocks map[string]*sync.Mutex
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

// marketplaceLock serializuje git operace na konkrétním marketplace klonu.
// Bez něj by dva paralelní installs sdílející stejný marketplace mohly do
// sebe nakročit (jeden klonuje, druhý se snaží pull).
func (m *Manager) marketplaceLock(marketplaceName string) *sync.Mutex {
	key := "mp:" + marketplaceName
	m.locksMu.Lock()
	defer m.locksMu.Unlock()
	if m.marketplaceLocks == nil {
		m.marketplaceLocks = make(map[string]*sync.Mutex)
	}
	if lock, ok := m.marketplaceLocks[key]; ok {
		return lock
	}
	lock := &sync.Mutex{}
	m.marketplaceLocks[key] = lock
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

func (m *Manager) PreviewInstall(asset CatalogAsset, opts InstallOptions) (InstallPreview, error) {
	if err := m.EnsureBaseDirs(); err != nil {
		return InstallPreview{}, err
	}

	asset = normalizeAsset(asset)
	opts = opts.Normalize()
	if err := validateSupported(asset); err != nil {
		return InstallPreview{}, err
	}
	if err := validateInstallOptions(opts); err != nil {
		return InstallPreview{}, err
	}

	switch asset.Type {
	case AssetTypeMCP:
		return m.previewMCPInstall(asset, opts)
	case AssetTypeHook:
		return m.previewHookInstall(asset, opts)
	case AssetTypePlugin:
		return m.previewPluginInstall(asset, opts)
	case AssetTypeConfig:
		return m.previewConfigInstall(asset, opts)
	}

	paths := m.pathsForScope(asset, opts)
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

func (m *Manager) previewConfigInstall(asset CatalogAsset, opts InstallOptions) (InstallPreview, error) {
	paths := m.pathsForScope(asset, opts)
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

func (m *Manager) previewMCPInstall(asset CatalogAsset, opts InstallOptions) (InstallPreview, error) {
	paths := m.pathsForScope(asset, opts)
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

func (m *Manager) previewHookInstall(asset CatalogAsset, opts InstallOptions) (InstallPreview, error) {
	paths := m.pathsForScope(asset, opts)
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

func (m *Manager) previewPluginInstall(asset CatalogAsset, opts InstallOptions) (InstallPreview, error) {
	recipe, err := ExtractPluginRecipe(asset)
	if err != nil {
		return InstallPreview{}, err
	}
	paths := m.pathsForScope(asset, opts)
	mpDir := marketplaceDirFor(m.ClaudeHome, recipe.MarketplaceName)
	pluginManifestPath := filepath.Join(m.ClaudeHome, "plugins", "installed_plugins.json")

	operations := []InstallOperation{
		{
			Type:        "backup",
			Path:        paths.TargetFile,
			Description: "Zazálohovat settings.json a installed_plugins.json před úpravou.",
			Risk:        RiskLow,
		},
		{
			Type:        "create",
			Path:        mpDir,
			Description: fmt.Sprintf("Klonovat plugin marketplace %q z původního git zdroje.", recipe.MarketplaceName),
			Risk:        asset.Risk,
		},
		{
			Type:        "create",
			Path:        paths.TargetFile + " :: extraKnownMarketplaces." + recipe.MarketplaceName,
			Description: "Zaregistrovat marketplace v ~/.claude/settings.json.",
			Risk:        asset.Risk,
		},
		{
			Type:        "create",
			Path:        paths.TargetFile + " :: enabledPlugins[" + recipe.PluginKey() + "]",
			Description: fmt.Sprintf("Zapnout plugin %q v Claude Code.", recipe.PluginName),
			Risk:        asset.Risk,
		},
	}
	if len(recipe.DefaultOptions) > 0 {
		operations = append(operations, InstallOperation{
			Type:        "create",
			Path:        paths.TargetFile + " :: pluginConfigs[" + recipe.PluginKey() + "].options",
			Description: fmt.Sprintf("Nastavit %d non-sensitive defaultních voleb pluginu.", len(recipe.DefaultOptions)),
			Risk:        asset.Risk,
		})
	}
	operations = append(operations, InstallOperation{
		Type:        "create",
		Path:        pluginManifestPath + " :: plugins[" + recipe.PluginKey() + "]",
		Description: "Aktualizovat installed_plugins.json o nový plugin.",
		Risk:        asset.Risk,
	}, InstallOperation{
		Type:        "manifest",
		Path:        paths.Manifest,
		Description: "Uložit Hub recipe manifest pro pozdější uninstall/update.",
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

func (m *Manager) Install(asset CatalogAsset, opts InstallOptions) (LocalAssetState, error) {
	if err := m.EnsureBaseDirs(); err != nil {
		return LocalAssetState{}, err
	}

	asset = normalizeAsset(asset)
	opts = opts.Normalize()
	if err := validateSupported(asset); err != nil {
		return LocalAssetState{}, err
	}
	if err := validateInstallOptions(opts); err != nil {
		return LocalAssetState{}, err
	}

	lock := m.assetLock(asset.Type, asset.Slug)
	lock.Lock()
	defer lock.Unlock()

	switch asset.Type {
	case AssetTypeMCP:
		return m.installMCP(asset, opts)
	case AssetTypeHook:
		return m.installHook(asset, opts)
	case AssetTypePlugin:
		return m.installPluginRecipe(asset, opts)
	case AssetTypeConfig:
		return m.installConfig(asset, opts)
	}

	paths := m.pathsForScope(asset, opts)
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
		Scope:              opts.Scope,
		ProjectPath:        opts.ProjectPath,
	}

	if err := writeJSON(paths.Manifest, record); err != nil {
		return LocalAssetState{}, err
	}

	localIndex, _ := m.localInstalledIndex()
	return m.assetState(asset, localIndex)
}

func (m *Manager) installMCP(asset CatalogAsset, opts InstallOptions) (LocalAssetState, error) {
	paths := m.pathsForScope(asset, opts)
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
		Scope:              opts.Scope,
		ProjectPath:        opts.ProjectPath,
	}
	if err := writeJSON(paths.Manifest, record); err != nil {
		return LocalAssetState{}, err
	}

	localIndex, _ := m.localInstalledIndex()
	return m.assetState(asset, localIndex)
}

func (m *Manager) installHook(asset CatalogAsset, opts InstallOptions) (LocalAssetState, error) {
	paths := m.pathsForScope(asset, opts)
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
		Scope:              opts.Scope,
		ProjectPath:        opts.ProjectPath,
	}
	if err := writeJSON(paths.Manifest, record); err != nil {
		return LocalAssetState{}, err
	}

	localIndex, _ := m.localInstalledIndex()
	return m.assetState(asset, localIndex)
}

func (m *Manager) installConfig(asset CatalogAsset, opts InstallOptions) (LocalAssetState, error) {
	paths := m.pathsForScope(asset, opts)
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
		Scope:              opts.Scope,
		ProjectPath:        opts.ProjectPath,
	}
	if err := writeJSON(paths.Manifest, record); err != nil {
		return LocalAssetState{}, err
	}
	localIndex, _ := m.localInstalledIndex()
	return m.assetState(asset, localIndex)
}

// toggleMergeAsset pro MCP / hook přesune položky mezi aktivním dokumentem a "disabled stash"
// uloženou v `.claude-hub/disabled/<type>/<slug>.json`.
func (m *Manager) toggleMergeAsset(asset CatalogAsset, enabled bool, opts InstallOptions) (LocalAssetState, error) {
	paths := m.pathsForScope(asset, opts)
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

func (m *Manager) SetEnabled(asset CatalogAsset, enabled bool, opts InstallOptions) (LocalAssetState, error) {
	if err := m.EnsureBaseDirs(); err != nil {
		return LocalAssetState{}, err
	}

	asset = normalizeAsset(asset)
	opts = opts.Normalize()
	if err := validateSupported(asset); err != nil {
		return LocalAssetState{}, err
	}
	if err := validateInstallOptions(opts); err != nil {
		return LocalAssetState{}, err
	}

	lock := m.assetLock(asset.Type, asset.Slug)
	lock.Lock()
	defer lock.Unlock()

	if asset.Type == AssetTypePlugin {
		return m.togglePluginRecipe(asset, opts, enabled)
	}
	if asset.Type == AssetTypeMCP || asset.Type == AssetTypeHook || asset.Type == AssetTypeConfig {
		return m.toggleMergeAsset(asset, enabled, opts)
	}

	paths := m.pathsForScope(asset, opts)
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
func (m *Manager) Uninstall(asset CatalogAsset, opts InstallOptions) (LocalAssetState, error) {
	if err := m.EnsureBaseDirs(); err != nil {
		return LocalAssetState{}, err
	}

	asset = normalizeAsset(asset)
	opts = opts.Normalize()
	if err := validateSupported(asset); err != nil {
		return LocalAssetState{}, err
	}
	if err := validateInstallOptions(opts); err != nil {
		return LocalAssetState{}, err
	}

	lock := m.assetLock(asset.Type, asset.Slug)
	lock.Lock()
	defer lock.Unlock()

	switch asset.Type {
	case AssetTypeMCP:
		return m.uninstallMCP(asset, opts)
	case AssetTypeHook:
		return m.uninstallHook(asset, opts)
	case AssetTypePlugin:
		return m.uninstallPluginRecipe(asset, opts)
	case AssetTypeConfig:
		return m.uninstallConfig(asset, opts)
	}

	paths := m.pathsForScope(asset, opts)
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

func (m *Manager) uninstallMCP(asset CatalogAsset, opts InstallOptions) (LocalAssetState, error) {
	paths := m.pathsForScope(asset, opts)
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

func (m *Manager) uninstallConfig(asset CatalogAsset, opts InstallOptions) (LocalAssetState, error) {
	paths := m.pathsForScope(asset, opts)
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

func (m *Manager) uninstallHook(asset CatalogAsset, opts InstallOptions) (LocalAssetState, error) {
	paths := m.pathsForScope(asset, opts)
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


func (m *Manager) LocalAssets() ([]LocalAsset, error) {
	if err := m.EnsureBaseDirs(); err != nil {
		return nil, err
	}

	assets := make([]LocalAsset, 0)
	assets = append(assets, m.skillAssets(filepath.Join(m.ClaudeHome, "skills"), "user", "", "", "", true)...)
	assets = append(assets, m.commandAssets(filepath.Join(m.ClaudeHome, "commands"), "user", "", "", "", true)...)
	assets = append(assets, m.entryAssets(filepath.Join(m.ClaudeHome, "hooks"), AssetTypeHook, "Hook", "user", "", "")...)
	assets = append(assets, m.settingsHookAssets(filepath.Join(m.ClaudeHome, "settings.json"), "hook:user-settings", "user", "", "")...)
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
			LocalAssetID:       localAssetID(scope, projectSlug, AssetTypeSkill, slug),
			Type:               AssetTypeSkill,
			Slug:               slug,
			Name:               markdownTitle(string(content), entry.Name()),
			Path:               filePath,
			Scope:              scope,
			ProjectName:        projectName,
			ProjectPath:        projectPath,
			ManagedByHub:       managedByHub,
			Warnings:           textWarnings(string(content)),
			ContentFingerprint: shaText(string(content)),
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
			LocalAssetID:       localAssetID(scope, projectSlug, AssetTypeCommand, slug),
			Type:               AssetTypeCommand,
			Slug:               slug,
			Name:               markdownTitle(string(content), "/"+slug),
			Path:               filePath,
			Scope:              scope,
			ProjectName:        projectName,
			ProjectPath:        projectPath,
			ManagedByHub:       managedByHub,
			Warnings:           textWarnings(string(content)),
			ContentFingerprint: shaText(string(content)),
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
			LocalAssetID:       localAssetID(scope, projectSlug, assetType, slug),
			Type:               assetType,
			Slug:               slug,
			Name:               name,
			Path:               itemPath,
			Scope:              scope,
			ProjectName:        projectName,
			ProjectPath:        projectPath,
			ManagedByHub:       false,
			Warnings:           warnings,
			ContentFingerprint: entryFingerprint(itemPath, entry),
		})
	}
	return assets
}

// entryFingerprint vrátí SHA-256 obsahu položky (soubor) nebo prvního
// rozpoznaného manifestu uvnitř adresáře. Slouží UI pro detekci duplikátů
// napříč projekty.
func entryFingerprint(path string, entry os.DirEntry) string {
	if !entry.IsDir() {
		content, err := readSmallTextFile(path)
		if err != nil {
			return ""
		}
		return shaText(content)
	}
	for _, candidate := range []string{
		filepath.Join(path, "plugin.json"),
		filepath.Join(path, ".claude-plugin", "plugin.json"),
		filepath.Join(path, "hook.json"),
		filepath.Join(path, "README.md"),
	} {
		content, err := readSmallTextFile(candidate)
		if err == nil {
			return shaText(content)
		}
	}
	return ""
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

	fingerprint := ""
	if selected.path != "" {
		for _, candidate := range []string{
			filepath.Join(selected.path, "plugin.json"),
			filepath.Join(selected.path, ".claude-plugin", "plugin.json"),
		} {
			if content, err := readSmallTextFile(candidate); err == nil {
				fingerprint = shaText(content)
				break
			}
		}
	}

	return LocalAsset{
		LocalAssetID:       "plugin:" + pluginSlug,
		Type:               AssetTypePlugin,
		Slug:               pluginSlug,
		Name:               pluginKey,
		Path:               selected.path,
		Scope:              "user",
		ProjectName:        "",
		ProjectPath:        "",
		ManagedByHub:       false,
		Warnings:           warnings,
		ContentFingerprint: fingerprint,
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
			LocalAssetID:       localIDPrefix + ":" + section,
			Type:               AssetTypeConfig,
			Slug:               section,
			Name:               "Nastavení: " + section,
			Path:               path + " :: " + section,
			Scope:              scope,
			ProjectName:        projectName,
			ProjectPath:        projectPath,
			ManagedByHub:       false,
			Warnings:           textWarnings(string(value)),
			ContentFingerprint: shaText(string(value)),
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
			LocalAssetID:       localIDPrefix + ":" + slug,
			Type:               AssetTypeMCP,
			Slug:               slug,
			Name:               "MCP: " + key,
			Path:               path + " :: mcpServers." + key,
			Scope:              scope,
			ProjectName:        projectName,
			ProjectPath:        projectPath,
			ManagedByHub:       false,
			Warnings:           textWarnings(string(value)),
			ContentFingerprint: shaText(string(value)),
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

// settingsHookAssets rozdělí hooks sekci v settings.json na samostatné položky —
// jednu za každý matcher block v každém eventu. Granularita: 1 entry = 1 LocalAsset.
// Paralela k mcpServerAssets, kde 1 MCP server = 1 LocalAsset.
func (m *Manager) settingsHookAssets(path string, localIDPrefix string, scope string, projectName string, projectPath string) []LocalAsset {
	doc, err := readHookDoc(path)
	if err != nil || doc == nil || len(doc.Hooks) == 0 {
		return nil
	}

	assets := make([]LocalAsset, 0)
	for _, event := range sortedHookEventKeys(doc.Hooks) {
		entries := doc.Hooks[event]
		for index, entry := range entries {
			matcher := hookEntryMatcher(entry)
			displayName := "Hook: " + event
			if matcher != "" && matcher != "*" && matcher != ".*" {
				displayName += " – " + matcher
			}
			assets = append(assets, LocalAsset{
				LocalAssetID:       fmt.Sprintf("%s:%s:%d", localIDPrefix, event, index),
				Type:               AssetTypeHook,
				Slug:               Slugify(fmt.Sprintf("%s-%d", event, index)),
				Name:               displayName,
				Path:               fmt.Sprintf("%s :: hooks.%s[%d]", path, event, index),
				Scope:              scope,
				ProjectName:        projectName,
				ProjectPath:        projectPath,
				ManagedByHub:       false,
				Warnings:           textWarnings(string(entry)),
				ContentFingerprint: shaText(string(entry)),
			})
		}
	}
	return assets
}

// hookEntryMatcher extrahuje pole "matcher" z hook entry pro UI label.
func hookEntryMatcher(entry json.RawMessage) string {
	var parsed struct {
		Matcher string `json:"matcher"`
	}
	if err := json.Unmarshal(entry, &parsed); err != nil {
		return ""
	}
	return parsed.Matcher
}

// splitSettingsHookPath rozdělí cestu typu "<file> :: hooks.<event>[<index>]" na
// (soubor, event, index). Vrátí (path, "", 0, false) pokud řetězec není ve formátu.
func splitSettingsHookPath(path string) (string, string, int, bool) {
	const sep = " :: hooks."
	idx := strings.Index(path, sep)
	if idx < 0 {
		return path, "", 0, false
	}
	filePart := strings.TrimSpace(path[:idx])
	rest := strings.TrimSpace(path[idx+len(sep):])
	open := strings.LastIndex(rest, "[")
	close := strings.LastIndex(rest, "]")
	if open < 0 || close < 0 || close <= open+1 {
		return path, "", 0, false
	}
	event := strings.TrimSpace(rest[:open])
	indexStr := rest[open+1 : close]
	indexNum, err := strconv.Atoi(indexStr)
	if err != nil || filePart == "" || event == "" {
		return path, "", 0, false
	}
	return filePart, event, indexNum, true
}

func (m *Manager) workspaceAssets() ([]LocalAsset, error) {
	assets := make([]LocalAsset, 0)
	visited := map[string]bool{}

	// 1) Env-based workspace roots (manuální override) — walkdir hledá .claude/ ve všech podadresářích.
	for _, root := range workspaceRoots() {
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
			key := strings.ToLower(filepath.Clean(projectRoot))
			if visited[key] {
				return filepath.SkipDir
			}
			visited[key] = true
			projectName := filepath.Base(projectRoot)
			projectSlug := projectSlugFromPath(projectRoot)
			assets = append(assets, m.workspaceClaudeDirAssets(current, projectRoot, projectName, projectSlug)...)
			return filepath.SkipDir
		})
		if err != nil && !os.IsNotExist(err) {
			return nil, err
		}
	}

	// 2) Auto-detekce projektů z ~/.claude.json (zero-config). Daemon vidí každý
	// projekt, ve kterém Claude Code už běžel. V Dockeru se cesty mimo mount
	// tichounce přeskočí — uživatel buď přidá mount, nebo si nainstaluje daemon
	// nativně.
	for _, projectRoot := range m.projectsFromClaudeJson() {
		key := strings.ToLower(filepath.Clean(projectRoot))
		if visited[key] {
			continue
		}
		claudeDir := filepath.Join(projectRoot, ".claude")
		info, err := os.Stat(claudeDir)
		if err != nil || !info.IsDir() {
			continue
		}
		visited[key] = true
		projectName := filepath.Base(projectRoot)
		projectSlug := projectSlugFromPath(projectRoot)
		assets = append(assets, m.workspaceClaudeDirAssets(claudeDir, projectRoot, projectName, projectSlug)...)
	}

	return assets, nil
}

// KnownProjects vrátí všechny projekty, které daemon zná: ze sekce projects
// v ~/.claude.json plus z env-based workspace mountů. Pro každý projekt vrátí
// flag accessible (`os.Stat` na cestě prošlo) a claudeDirExists (přítomnost
// .claude/ adresáře). UI tyto informace používá v install scope pickeru.
func (m *Manager) KnownProjects() []KnownProject {
	seen := map[string]bool{}
	result := make([]KnownProject, 0)

	add := func(path string) {
		path = filepath.Clean(strings.TrimSpace(path))
		if path == "" {
			return
		}
		key := strings.ToLower(path)
		if seen[key] {
			return
		}
		seen[key] = true

		project := KnownProject{
			Path: path,
			Name: baseName(path),
		}
		if info, err := os.Stat(path); err == nil && info.IsDir() {
			project.Accessible = true
			if claude, err := os.Stat(filepath.Join(path, ".claude")); err == nil && claude.IsDir() {
				project.ClaudeDirExists = true
			}
		}
		result = append(result, project)
	}

	for _, path := range m.projectsFromClaudeJson() {
		add(path)
	}
	for _, root := range workspaceRoots() {
		_ = filepath.WalkDir(root, func(current string, entry os.DirEntry, walkErr error) error {
			if walkErr != nil || !entry.IsDir() {
				return nil
			}
			if current != root && skippedWorkspaceDirs[entry.Name()] {
				return filepath.SkipDir
			}
			if entry.Name() != ".claude" {
				return nil
			}
			add(filepath.Dir(current))
			return filepath.SkipDir
		})
	}

	sort.Slice(result, func(i, j int) bool {
		return result[i].Name < result[j].Name
	})
	return result
}

// projectsFromClaudeJson vrátí cesty k projektům, ve kterých už uživatel
// spustil Claude Code. Claude CLI je ukládá do ~/.claude.json sekce "projects".
// V Dockeru jsou cesty v host formátu (D:/Dev/foo) — daemon je stejně zkusí
// otevřít a neexistující tichounce přeskočí.
func (m *Manager) projectsFromClaudeJson() []string {
	bytes, err := os.ReadFile(m.userClaudeJsonPath())
	if err != nil {
		return nil
	}
	raw := map[string]json.RawMessage{}
	if err := json.Unmarshal(bytes, &raw); err != nil {
		return nil
	}
	projectsRaw, ok := raw["projects"]
	if !ok || len(projectsRaw) == 0 {
		return nil
	}
	projects := map[string]json.RawMessage{}
	if err := json.Unmarshal(projectsRaw, &projects); err != nil {
		return nil
	}
	paths := make([]string, 0, len(projects))
	for path := range projects {
		path = strings.TrimSpace(path)
		if path == "" {
			continue
		}
		paths = append(paths, filepath.Clean(path))
	}
	sort.Strings(paths)
	return paths
}

func (m *Manager) workspaceClaudeDirAssets(claudeDir string, projectRoot string, projectName string, projectSlug string) []LocalAsset {
	assets := make([]LocalAsset, 0)
	assets = append(assets, m.skillAssets(filepath.Join(claudeDir, "skills"), "project", projectName, projectRoot, projectSlug, false)...)
	assets = append(assets, m.commandAssets(filepath.Join(claudeDir, "commands"), "project", projectName, projectRoot, projectSlug, false)...)
	assets = append(assets, m.entryAssets(filepath.Join(claudeDir, "hooks"), AssetTypeHook, "Hook", "project", projectName, projectRoot)...)
	assets = append(assets, m.settingsHookAssets(filepath.Join(claudeDir, "settings.json"), "project:"+projectSlug+":hook:settings", "project", projectName, projectRoot)...)
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
	if asset.Type == AssetTypePlugin {
		// Pluginy se v Hub modelu nesdílí jako file bundle, ale jako recipe
		// (marketplace pointer). Dvě cesty:
		//  1) Plugin byl instalovaný přes Hub recipe → manifest má RecipePayload.
		//  2) Plugin byl instalovaný klasicky přes `/plugin marketplace add ...` →
		//     daemon zrekonstruuje recipe z installed_plugins.json + .git/config
		//     marketplace klonu.
		if recipeJSON := m.recipePayloadFromManifests(asset.Slug); recipeJSON != "" {
			return []AssetFile{{Path: PluginRecipeFilePath, Content: recipeJSON}}, nil
		}
		recipe, err := m.BuildRecipeFromLocalPlugin(asset.Slug)
		if err != nil {
			return nil, fmt.Errorf("plugin nelze automaticky sdílet: %w", err)
		}
		recipeJSON, err := json.MarshalIndent(recipe, "", "  ")
		if err != nil {
			return nil, fmt.Errorf("nelze serializovat recipe: %w", err)
		}
		return []AssetFile{{Path: PluginRecipeFilePath, Content: string(recipeJSON)}}, nil
	}
	if asset.Type == AssetTypeHook {
		if filePath, event, index, ok := splitSettingsHookPath(source); ok {
			doc, err := readHookDoc(filePath)
			if err != nil {
				return nil, err
			}
			entries, exists := doc.Hooks[event]
			if !exists || index < 0 || index >= len(entries) {
				return nil, fmt.Errorf("hook %s[%d] už v %s není", event, index, filePath)
			}
			payload := map[string]map[string][]json.RawMessage{
				"hooks": {event: {entries[index]}},
			}
			content, err := json.MarshalIndent(payload, "", "  ")
			if err != nil {
				return nil, err
			}
			return []AssetFile{{
				Path:    "hook.json",
				Content: string(append(content, '\n')),
			}}, nil
		}
		if strings.EqualFold(filepath.Base(source), "settings.json") {
			return settingsSectionExport(source, "hooks", "settings.hooks.json")
		}
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

	scopes := m.collectInstalledScopes(asset)
	// Plugin recipe je merge typ — patchuje settings.json a installed_plugins.json,
	// nemá samostatný TargetFile který by indikoval install. Bez plug-in tady by
	// `targetExists := exists(settings.json)` lhalo (settings.json existuje i
	// bez recipe).
	mergeType := asset.Type == AssetTypeMCP || asset.Type == AssetTypeHook || asset.Type == AssetTypeConfig || asset.Type == AssetTypePlugin

	scopeStates := make([]InstallScopeState, 0, len(scopes))
	anyInstalled := false
	anyEnabled := false
	anyLocalChanges := false
	anyUpdateAvailable := false
	managedByHub := false
	primaryLocalVersion := ""

	for _, opts := range scopes {
		paths := m.pathsForScope(asset, opts)
		record, _ := readManifest(paths.Manifest)
		if record != nil {
			managedByHub = true
		}
		targetExists := exists(paths.TargetFile)
		disabledExists := exists(paths.DisabledFile)

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
		if !installed {
			continue
		}

		localVersion := ""
		if record != nil {
			localVersion = record.Version
		}
		localChanges := false
		if record != nil && record.ContentFingerprint != "" {
			content := ""
			if enabled {
				content = readText(paths.TargetFile)
			} else {
				content = readText(paths.DisabledFile)
			}
			localChanges = shaText(content) != record.ContentFingerprint
		}
		updateAvailable := localVersion != "" && localVersion != asset.Version

		scopeStates = append(scopeStates, InstallScopeState{
			Scope:           opts.Scope,
			ProjectPath:     opts.ProjectPath,
			ProjectName:     baseName(opts.ProjectPath),
			Installed:       installed,
			Enabled:         enabled,
			ManagedByHub:    record != nil,
			LocalVersion:    localVersion,
			LocalChanges:    localChanges,
			UpdateAvailable: updateAvailable,
		})

		anyInstalled = anyInstalled || installed
		anyEnabled = anyEnabled || enabled
		anyLocalChanges = anyLocalChanges || localChanges
		anyUpdateAvailable = anyUpdateAvailable || updateAvailable
		if primaryLocalVersion == "" {
			primaryLocalVersion = localVersion
		}
	}

	// Plugin recipe může být lokálně nainstalovaný bez Hub manifestu — uživatel
	// si plugin přidal přes `/plugin marketplace add ...` v Claude Code. V tom
	// případě čteme stav přímo z installed_plugins.json + settings.json
	// (enabledPlugins flag) — to je přesnější než generický localIndex fallback,
	// proto musí běžet PŘED ním.
	if asset.Type == AssetTypePlugin && !anyInstalled {
		if pluginKey := m.findPluginKeyBySlug(asset.Slug); pluginKey != "" {
			anyInstalled = true
			anyEnabled = m.isPluginEnabledInSettings(pluginKey)
			scopeStates = append(scopeStates, InstallScopeState{
				Scope:        "user",
				Installed:    true,
				Enabled:      anyEnabled,
				ManagedByHub: false,
			})
		}
	}

	// Generic localIndex fallback pro všechny ostatní typy (skill, command,
	// mcp, hook, config). Pokud lokálně položku najdeme bez Hub manifestu,
	// zobrazíme ji jako Zapnutou (přítomnost souboru = enabled).
	matchedLocalAsset, hasLocalMatch := localIndex[assetIdentityKey(asset.Type, asset.Slug)]
	if !anyInstalled && hasLocalMatch {
		anyInstalled = true
		anyEnabled = true
	}

	state := "not_installed"
	switch {
	case anyLocalChanges:
		state = "local_changes"
	case anyUpdateAvailable:
		state = "update_available"
	case anyEnabled:
		state = "enabled"
	case anyInstalled:
		state = "disabled"
	}

	return LocalAssetState{
		AssetID:         asset.ID,
		Type:            asset.Type,
		Slug:            asset.Slug,
		State:           state,
		Installed:       anyInstalled,
		Enabled:         anyEnabled,
		ManagedByHub:    managedByHub,
		LocalVersion:    primaryLocalVersion,
		CatalogVersion:  asset.Version,
		LocalChanges:    anyLocalChanges,
		UpdateAvailable: anyUpdateAvailable,
		Warnings:        stateWarnings(asset, matchedLocalAsset, hasLocalMatch && !managedByHub, managedByHub && !anyInstalled),
		Scopes:          scopeStates,
	}, nil
}

// collectInstalledScopes prochází installed/ adresář a vrátí InstallOptions
// pro každý manifest, který odpovídá danému (type, slug). Manifest si scope
// pamatuje uvnitř (Scope + ProjectPath fields).
func (m *Manager) collectInstalledScopes(asset CatalogAsset) []InstallOptions {
	prefix := string(asset.Type) + "-" + asset.Slug + "__"
	suffix := ".json"
	dir := filepath.Join(m.HubHome, "installed")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}

	scopes := make([]InstallOptions, 0)
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasPrefix(name, prefix) || !strings.HasSuffix(name, suffix) {
			continue
		}
		record, err := readManifest(filepath.Join(dir, name))
		if err != nil || record == nil {
			continue
		}
		scope := record.Scope
		if scope == "" {
			scope = "user"
		}
		scopes = append(scopes, InstallOptions{Scope: scope, ProjectPath: record.ProjectPath})
	}
	return scopes
}

func (m *Manager) localInstalledIndex() (map[string]LocalAsset, error) {
	assets, err := m.LocalAssets()
	if err != nil {
		return nil, err
	}

	// localIndex obsahuje VŠECHNY typy lokálně detekovaných položek
	// (skill, command, mcp, hook, plugin, config). assetState ho používá
	// jako fallback: pokud nemá Hub manifest, ale položka je lokálně
	// přítomná, katalog ji ukáže jako "Zapnuto" místo "Nenainstalováno".
	//
	// Pro plugin existuje navíc specifický fallback (findPluginKeyBySlug +
	// isPluginEnabledInSettings) v assetState, který běží PŘED localIndex
	// kontrolou — tam čteme skutečný enabled stav ze settings.json
	// místo hardcoded enabled=true.
	index := make(map[string]LocalAsset, len(assets))
	for _, asset := range assets {
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

// paths vrací cesty pro výchozí user-scope install. Zachováno pro detection
// codepaths, které pracují čistě s user-level assety.
func (m *Manager) paths(asset CatalogAsset) assetPaths {
	return m.pathsForScope(asset, InstallOptions{Scope: "user"})
}

// pathsForScope vrací assetPaths podle vybraného scope.
// User scope cílí na ~/.claude/..., project scope na <projectPath>/.claude/...
// Manifest, disabled stash a backup adresáře jsou stejně izolované per scope.
func (m *Manager) pathsForScope(asset CatalogAsset, opts InstallOptions) assetPaths {
	opts = opts.Normalize()
	manifestPath := m.manifestPath(asset, opts)
	stashID := scopedStashID(opts, asset.Slug)
	isProject := opts.Scope == "project" && opts.ProjectPath != ""
	base := m.ClaudeHome
	if isProject {
		base = filepath.Join(opts.ProjectPath, ".claude")
	}

	switch asset.Type {
	case AssetTypeSkill:
		return assetPaths{
			TargetRoot:   filepath.Join(base, "skills", asset.Slug),
			TargetFile:   filepath.Join(base, "skills", asset.Slug, "SKILL.md"),
			DisabledRoot: filepath.Join(m.HubHome, "disabled", "skills", stashID),
			DisabledFile: filepath.Join(m.HubHome, "disabled", "skills", stashID, "SKILL.md"),
			Manifest:     manifestPath,
		}
	case AssetTypeMCP:
		var target string
		if isProject {
			target = filepath.Join(opts.ProjectPath, ".mcp.json")
		} else {
			target = m.userClaudeJsonPath()
			if !exists(target) {
				target = filepath.Join(m.ClaudeHome, ".mcp.json")
			}
		}
		return assetPaths{
			TargetRoot:   target,
			TargetFile:   target,
			DisabledRoot: filepath.Join(m.HubHome, "disabled", "mcp", stashID+".json"),
			DisabledFile: filepath.Join(m.HubHome, "disabled", "mcp", stashID+".json"),
			Manifest:     manifestPath,
		}
	case AssetTypeHook:
		target := filepath.Join(base, "settings.json")
		return assetPaths{
			TargetRoot:   target,
			TargetFile:   target,
			DisabledRoot: filepath.Join(m.HubHome, "disabled", "hooks", stashID+".json"),
			DisabledFile: filepath.Join(m.HubHome, "disabled", "hooks", stashID+".json"),
			Manifest:     manifestPath,
		}
	case AssetTypePlugin:
		// Plugin recipe model: Hub neukládá soubory pluginu, ale JSON-patchuje
		// settings.json. TargetRoot/TargetFile cílí na settings.json (file který
		// recipe upravuje). DisabledFile drží snapshot enabledPlugins entry pro
		// případné toggle reverze.
		target := filepath.Join(base, "settings.json")
		return assetPaths{
			TargetRoot:   target,
			TargetFile:   target,
			DisabledRoot: filepath.Join(m.HubHome, "disabled", "plugins", stashID+".json"),
			DisabledFile: filepath.Join(m.HubHome, "disabled", "plugins", stashID+".json"),
			Manifest:     manifestPath,
		}
	case AssetTypeConfig:
		target := filepath.Join(base, "settings.json")
		return assetPaths{
			TargetRoot:   target,
			TargetFile:   target,
			DisabledRoot: filepath.Join(m.HubHome, "disabled", "configs", stashID+".json"),
			DisabledFile: filepath.Join(m.HubHome, "disabled", "configs", stashID+".json"),
			Manifest:     manifestPath,
		}
	}

	return assetPaths{
		TargetRoot:   filepath.Join(base, "commands", asset.Slug+".md"),
		TargetFile:   filepath.Join(base, "commands", asset.Slug+".md"),
		DisabledRoot: filepath.Join(m.HubHome, "disabled", "commands", stashID+".md"),
		DisabledFile: filepath.Join(m.HubHome, "disabled", "commands", stashID+".md"),
		Manifest:     manifestPath,
	}
}

// manifestPath vrátí cestu k manifestu konkrétní instalace.
// Soubory mají suffix __user nebo __proj-<projektSlug>, aby v adresáři
// installed/ mohly žít manifesty různých scope nezávisle.
func (m *Manager) manifestPath(asset CatalogAsset, opts InstallOptions) string {
	return filepath.Join(m.HubHome, "installed", manifestFilename(asset, opts))
}

func manifestFilename(asset CatalogAsset, opts InstallOptions) string {
	opts = opts.Normalize()
	suffix := manifestScopeSuffix(opts)
	return fmt.Sprintf("%s-%s__%s.json", asset.Type, asset.Slug, suffix)
}

func manifestScopeSuffix(opts InstallOptions) string {
	if opts.Scope == "project" && opts.ProjectPath != "" {
		return "proj-" + projectSlugFromPath(opts.ProjectPath)
	}
	return "user"
}

// scopedStashID vrátí identifikátor pro disabled/backup adresáře, který je
// jedinečný napříč scope (aby disabled user-level a project-level kopie
// nekolidovaly).
func scopedStashID(opts InstallOptions, slug string) string {
	suffix := manifestScopeSuffix(opts)
	if suffix == "user" {
		return slug
	}
	return suffix + "-" + slug
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

// validateInstallOptions ověří, že volba scope je smysluplná. Project scope
// vyžaduje neprázdný projectPath, který existuje jako adresář.
func validateInstallOptions(opts InstallOptions) error {
	switch opts.Scope {
	case "user", "":
		return nil
	case "project":
		if strings.TrimSpace(opts.ProjectPath) == "" {
			return errors.New("project scope vyžaduje cestu k projektu")
		}
		info, err := os.Stat(opts.ProjectPath)
		if err != nil {
			return fmt.Errorf("cesta k projektu %q neexistuje: %w", opts.ProjectPath, err)
		}
		if !info.IsDir() {
			return fmt.Errorf("cesta k projektu %q není adresář", opts.ProjectPath)
		}
		return nil
	default:
		return fmt.Errorf("neznámý install scope %q", opts.Scope)
	}
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
