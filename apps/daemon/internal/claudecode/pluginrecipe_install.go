package claudecode

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/claude-hub/claude-hub/apps/daemon/internal/gitauth"
)

// GitAuthRunner je injektovaná závislost pro klonování marketplace repos.
// V produkci se nastavuje na *gitauth.Ladder, v testech na mock.
type GitAuthRunner interface {
	Clone(ctx context.Context, opts gitauth.CloneOptions) (gitauth.Result, error)
	Pull(ctx context.Context, repoPath, remoteURL string) (gitauth.Result, error)
}

const (
	// recipeCloneTimeout je strop na jednu git operaci. Malé marketplace
	// klony jsou <5s, ale shallow ze záplaty pluginů může trvat déle.
	recipeCloneTimeout = 90 * time.Second
)

// installPluginRecipe naklonuje marketplace, JSON-patchuje ~/.claude/settings.json
// a doplní entry do installed_plugins.json. Vrací typed error
// (např. *gitauth.AuthRequiredError) — server.go ho mapuje na HTTP 401.
func (m *Manager) installPluginRecipe(asset CatalogAsset, opts InstallOptions) (LocalAssetState, error) {
	recipe, err := ExtractPluginRecipe(asset)
	if err != nil {
		return LocalAssetState{}, err
	}
	if m.GitAuth == nil {
		return LocalAssetState{}, errors.New("daemon nemá k dispozici git — plugin recipe install není možný (spusť daemon s git binárkou v PATH)")
	}
	if opts.Scope != "user" && opts.Scope != "" {
		return LocalAssetState{}, fmt.Errorf("plugin recipe install zatím podporuje pouze user scope, nalezeno %q", opts.Scope)
	}

	// Per-marketplace lock: dva recipes sdílející stejný marketplace by si
	// jinak mohly nakročit při klonování / pull.
	mpLock := m.marketplaceLock(recipe.MarketplaceName)
	mpLock.Lock()
	defer mpLock.Unlock()

	paths := m.pathsForScope(asset, opts)
	pluginManifestPath := filepath.Join(m.ClaudeHome, "plugins", "installed_plugins.json")
	settingsPath := paths.TargetFile

	// Backup current artifacts (settings.json + installed_plugins.json + marketplace dir).
	backupPath, err := m.backup(paths, asset)
	if err != nil {
		return LocalAssetState{}, fmt.Errorf("backup selhal: %w", err)
	}

	snapshots := map[string]string{}

	// Clone or update marketplace.
	mpDir := marketplaceDirFor(m.ClaudeHome, recipe.MarketplaceName)
	cloned, err := m.cloneOrPullMarketplace(recipe, mpDir)
	if err != nil {
		return LocalAssetState{}, err
	}

	// Patch settings.json (extraKnownMarketplaces, enabledPlugins, pluginConfigs).
	settingsDocPtr, err := readSettingsDoc(settingsPath)
	if err != nil {
		return LocalAssetState{}, fmt.Errorf("nelze načíst settings.json: %w", err)
	}
	if err := patchSettingsForRecipe(settingsDocPtr, recipe, snapshots); err != nil {
		return LocalAssetState{}, err
	}
	if err := writeSettingsDoc(settingsPath, settingsDocPtr); err != nil {
		return LocalAssetState{}, fmt.Errorf("nelze zapsat settings.json: %w", err)
	}

	// Patch installed_plugins.json: Claude Code se podle něj orientuje, který
	// plugin@marketplace je nainstalovaný a kde leží.
	pluginKey := recipe.PluginKey()
	pluginDocPtr, err := readPluginDoc(pluginManifestPath)
	if err != nil {
		return LocalAssetState{}, fmt.Errorf("nelze načíst installed_plugins.json: %w", err)
	}
	if prev, ok := pluginDocPtr.Plugins[pluginKey]; ok {
		prevRaw, err := json.Marshal(prev)
		if err == nil {
			snapshots[recipeSnapshotKey("installed_plugins", pluginKey)] = string(prevRaw)
		}
	} else {
		snapshots[recipeSnapshotKey("installed_plugins", pluginKey)] = snapshotAbsent
	}
	pluginDocPtr.Plugins[pluginKey] = []installedPluginEntry{
		{
			Scope:       "user",
			ProjectPath: "",
			InstallPath: mpDir,
			Version:     cloned.HeadSHA,
		},
	}
	if err := writePluginDoc(pluginManifestPath, pluginDocPtr); err != nil {
		return LocalAssetState{}, fmt.Errorf("nelze zapsat installed_plugins.json: %w", err)
	}

	// Hub manifest pro rollback + audit.
	now := time.Now().UTC().Format(time.RFC3339)
	recipePayload, _ := json.Marshal(recipe)
	record := manifest{
		AssetID:            asset.ID,
		Type:               asset.Type,
		Slug:               asset.Slug,
		Name:               asset.Name,
		Version:            asset.Version,
		Enabled:            true,
		InstalledAt:        now,
		Fingerprint:        fingerprint(asset),
		ContentFingerprint: shaText(readText(settingsPath)),
		BackupPath:         backupPath,
		Scope:              opts.Scope,
		ProjectPath:        opts.ProjectPath,
		PluginEntries: []string{
			"marketplace:" + recipe.MarketplaceName,
			"plugin:" + pluginKey,
			"sha:" + cloned.HeadSHA,
			"authMethod:" + string(cloned.AuthMethod),
		},
		ContentSnapshots: snapshots,
		RecipePayload:    string(recipePayload),
	}
	if err := writeJSON(paths.Manifest, record); err != nil {
		return LocalAssetState{}, err
	}

	localIndex, _ := m.localInstalledIndex()
	return m.assetState(asset, localIndex)
}

// uninstallPluginRecipe vrátí settings.json a installed_plugins.json do
// pre-install stavu na základě snapshots v manifestu. Pokud žádný jiný
// recipe nesdílí marketplace, smaže i klon marketplace.
func (m *Manager) uninstallPluginRecipe(asset CatalogAsset, opts InstallOptions) (LocalAssetState, error) {
	paths := m.pathsForScope(asset, opts)
	record, _ := readManifest(paths.Manifest)
	if record == nil {
		return LocalAssetState{}, errors.New("plugin recipe není evidovaný v Claude Hubu, nelze bezpečně odstranit")
	}

	marketplaceName, pluginKey, _ := parseRecipePluginEntries(record.PluginEntries)
	if marketplaceName == "" || pluginKey == "" {
		return LocalAssetState{}, errors.New("manifest postrádá marketplace/plugin identifikátor — recipe byla pravděpodobně instalována starší verzí daemonu")
	}

	mpLock := m.marketplaceLock(marketplaceName)
	mpLock.Lock()
	defer mpLock.Unlock()

	pluginManifestPath := filepath.Join(m.ClaudeHome, "plugins", "installed_plugins.json")
	settingsPath := paths.TargetFile

	// Backup current state.
	if _, err := m.backup(paths, asset); err != nil {
		return LocalAssetState{}, err
	}

	// Recipe pro restoreSettingsFromSnapshots — potřebujeme jen MarketplaceName a PluginName.
	// Plugin name extrahneme z pluginKey "<plugin>@<marketplace>".
	pluginName := strings.TrimSuffix(pluginKey, "@"+marketplaceName)
	recipe := &PluginRecipe{
		MarketplaceName: marketplaceName,
		PluginName:      pluginName,
	}

	// Restore settings.json.
	settingsDocPtr, err := readSettingsDoc(settingsPath)
	if err != nil {
		return LocalAssetState{}, err
	}
	if err := restoreSettingsFromSnapshots(settingsDocPtr, recipe, record.ContentSnapshots); err != nil {
		return LocalAssetState{}, err
	}
	if err := writeSettingsDoc(settingsPath, settingsDocPtr); err != nil {
		return LocalAssetState{}, err
	}

	// Restore installed_plugins.json.
	pluginDocPtr, err := readPluginDoc(pluginManifestPath)
	if err == nil {
		snapKey := recipeSnapshotKey("installed_plugins", pluginKey)
		if snap, ok := record.ContentSnapshots[snapKey]; ok {
			if snap == snapshotAbsent {
				delete(pluginDocPtr.Plugins, pluginKey)
			} else {
				var entries []installedPluginEntry
				if err := json.Unmarshal([]byte(snap), &entries); err == nil {
					pluginDocPtr.Plugins[pluginKey] = entries
				}
			}
		} else {
			delete(pluginDocPtr.Plugins, pluginKey)
		}
		_ = writePluginDoc(pluginManifestPath, pluginDocPtr)
	}

	// Smaž marketplace clone, pokud na něj neukazuje jiný recipe.
	if !m.marketplaceReferencedByOtherRecipes(marketplaceName, asset.ID) {
		mpDir := marketplaceDirFor(m.ClaudeHome, marketplaceName)
		_ = os.RemoveAll(mpDir)
		// Pokud je marketplaces parent dir prázdný, taky ho zruš (kosmetika).
		parent := filepath.Dir(mpDir)
		if entries, err := os.ReadDir(parent); err == nil && len(entries) == 0 {
			_ = os.Remove(parent)
		}
	}

	_ = os.Remove(paths.Manifest)
	_ = os.Remove(paths.DisabledFile)

	localIndex, _ := m.localInstalledIndex()
	return m.assetState(asset, localIndex)
}

// togglePluginRecipe překlopí enabledPlugins[<plugin>@<mp>] v settings.json
// na true/false. Funguje pro plugin instalovaný Hub recipe modelem i pro
// plugin instalovaný klasicky přes `/plugin marketplace add ...` (bez Hub
// manifestu) — v druhém případě odvodí pluginKey z installed_plugins.json.
func (m *Manager) togglePluginRecipe(asset CatalogAsset, opts InstallOptions, enabled bool) (LocalAssetState, error) {
	paths := m.pathsForScope(asset, opts)
	record, _ := readManifest(paths.Manifest)

	var pluginKey string
	if record != nil {
		_, pluginKey, _ = parseRecipePluginEntries(record.PluginEntries)
	}
	if pluginKey == "" {
		pluginKey = m.findPluginKeyBySlug(asset.Slug)
	}
	if pluginKey == "" {
		return LocalAssetState{}, errors.New("plugin nelze přepnout — nenašel jsem ho v installed_plugins.json")
	}

	settingsPath := paths.TargetFile
	doc, err := readSettingsDoc(settingsPath)
	if err != nil {
		return LocalAssetState{}, err
	}
	if record != nil {
		if _, err := m.backupMergeArtifact(paths, asset, doc); err != nil {
			return LocalAssetState{}, err
		}
	}
	if err := togglePluginInSettings(doc, pluginKey, enabled); err != nil {
		return LocalAssetState{}, err
	}
	if err := writeSettingsDoc(settingsPath, doc); err != nil {
		return LocalAssetState{}, err
	}

	if record != nil {
		record.Enabled = enabled
		record.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
		record.ContentFingerprint = shaText(readText(settingsPath))
		if err := writeJSON(paths.Manifest, record); err != nil {
			return LocalAssetState{}, err
		}
	}

	localIndex, _ := m.localInstalledIndex()
	return m.assetState(asset, localIndex)
}

// cloneOrPullMarketplace zařídí, že v `dest` existuje aktuální klon marketplace
// repa. Pokud `dest/.git` existuje, dělá pull; jinak fresh clone.
func (m *Manager) cloneOrPullMarketplace(recipe *PluginRecipe, dest string) (gitauth.Result, error) {
	cloneURL, err := buildCloneURL(&recipe.MarketplaceSource)
	if err != nil {
		return gitauth.Result{}, err
	}

	ctx, cancel := context.WithTimeout(context.Background(), recipeCloneTimeout)
	defer cancel()

	if exists(filepath.Join(dest, ".git")) {
		return m.GitAuth.Pull(ctx, dest, cloneURL)
	}

	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return gitauth.Result{}, err
	}
	// Pokud destPath existuje jako prázdný adresář (z dřívější neúplné operace),
	// odklidíme — git clone odmítá psát do neprázdného adresáře.
	if entries, err := os.ReadDir(dest); err == nil && len(entries) > 0 {
		_ = os.RemoveAll(dest)
	}

	opts := gitauth.CloneOptions{
		URL:   cloneURL,
		Dest:  dest,
		Ref:   recipe.MarketplaceSource.Ref,
		Depth: 1, // marketplace klon nepotřebuje history
	}
	return m.GitAuth.Clone(ctx, opts)
}

// buildCloneURL přemění MarketplaceSource na HTTPS git URL, kterou pošleme git
// binárce. NPM zdroj nepodporujeme v MVP — recipe validace ho odmítne na vrstvě
// ExtractPluginRecipe, ale tady dáme explicitní chybu, kdyby propadla.
func buildCloneURL(src *MarketplaceSource) (string, error) {
	switch src.Source {
	case "github":
		return "https://github.com/" + src.Repo + ".git", nil
	case "url":
		return src.URL, nil
	case "git-subdir":
		// MVP: klonujeme celý repo a uživatel je odpovědný za to, že marketplace.json
		// správně odkazuje na subdir. Sparse-checkout je future.
		return src.URL, nil
	case "npm":
		return "", fmt.Errorf("npm marketplace zdroj zatím není podporován")
	default:
		return "", fmt.Errorf("neznámý marketplace source %q", src.Source)
	}
}

// marketplaceDirFor vrátí cestu, kam daemon klonuje marketplace.
func marketplaceDirFor(claudeHome, marketplaceName string) string {
	return filepath.Join(claudeHome, "plugins", "marketplaces", marketplaceName)
}

// parseRecipePluginEntries dekóduje strings z manifest.PluginEntries, které
// installPluginRecipe ukládá ve formátu "<klíč>:<hodnota>".
//
// Vrací marketplaceName, pluginKey (= "<plugin>@<marketplace>"), headSHA.
func parseRecipePluginEntries(entries []string) (marketplaceName, pluginKey, headSHA string) {
	for _, entry := range entries {
		idx := strings.Index(entry, ":")
		if idx < 0 {
			continue
		}
		key := entry[:idx]
		value := entry[idx+1:]
		switch key {
		case "marketplace":
			marketplaceName = value
		case "plugin":
			pluginKey = value
		case "sha":
			headSHA = value
		}
	}
	return
}

// marketplaceReferencedByOtherRecipes vrátí true, pokud existuje jiný plugin
// recipe manifest (kromě excludeAssetID), který ukládá stejný marketplace name.
// Slouží k tomu, aby uninstall jednoho recipe nesmazal marketplace clone,
// na který se ještě spoléhá jiný recipe.
func (m *Manager) marketplaceReferencedByOtherRecipes(marketplaceName, excludeAssetID string) bool {
	installedDir := filepath.Join(m.HubHome, "installed")
	entries, err := os.ReadDir(installedDir)
	if err != nil {
		return false
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if !strings.HasPrefix(name, "plugin-") || !strings.HasSuffix(name, ".json") {
			continue
		}
		record, err := readManifest(filepath.Join(installedDir, name))
		if err != nil || record == nil {
			continue
		}
		if record.AssetID == excludeAssetID {
			continue
		}
		mp, _, _ := parseRecipePluginEntries(record.PluginEntries)
		if mp == marketplaceName {
			return true
		}
	}
	return false
}
