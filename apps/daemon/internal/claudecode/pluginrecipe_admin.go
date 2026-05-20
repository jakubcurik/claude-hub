package claudecode

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/claude-hub/claude-hub/apps/daemon/internal/gitauth"
)

// InstalledRecipe je view do manifestu plugin recipe — scheduler / UI ho
// používá pro listing a auto-update rozhodování.
type InstalledRecipe struct {
	AssetID         string
	Slug            string
	MarketplaceName string
	PluginKey       string
	HeadSHA         string
	AutoUpdate      bool
	Recipe          PluginRecipe
	ManifestPath    string
	MarketplaceDir  string
}

// ListInstalledRecipes čte všechny plugin recipe manifesty v
// ~/.claude/.claude-hub/installed/ a vrátí jejich strukturovaný view.
func (m *Manager) ListInstalledRecipes() ([]InstalledRecipe, error) {
	dir := filepath.Join(m.HubHome, "installed")
	entries, err := os.ReadDir(dir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}

	out := make([]InstalledRecipe, 0)
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if !strings.HasPrefix(name, "plugin-") || !strings.HasSuffix(name, ".json") {
			continue
		}
		manifestPath := filepath.Join(dir, name)
		record, err := readManifest(manifestPath)
		if err != nil || record == nil {
			continue
		}
		if record.Type != AssetTypePlugin || record.RecipePayload == "" {
			continue
		}
		var recipe PluginRecipe
		if err := json.Unmarshal([]byte(record.RecipePayload), &recipe); err != nil {
			continue
		}
		mpName, pluginKey, headSHA := parseRecipePluginEntries(record.PluginEntries)
		if mpName == "" {
			mpName = recipe.MarketplaceName
		}
		out = append(out, InstalledRecipe{
			AssetID:         record.AssetID,
			Slug:            record.Slug,
			MarketplaceName: mpName,
			PluginKey:       pluginKey,
			HeadSHA:         headSHA,
			AutoUpdate:      recipe.AutoUpdateEnabled(),
			Recipe:          recipe,
			ManifestPath:    manifestPath,
			MarketplaceDir:  marketplaceDirFor(m.ClaudeHome, mpName),
		})
	}
	return out, nil
}

// UpdateRecipeMarketplace provede `git pull --ff-only` v marketplace klonu a
// aktualizuje záznam HEAD SHA v manifestu. Auth ladder (Vrstva 1 → 2) jako u
// install. Vrátí (newSHA, changed, error). `changed = true`, pokud SHA se
// posunula proti zaznamenanému v manifestu.
func (m *Manager) UpdateRecipeMarketplace(ctx context.Context, info InstalledRecipe) (string, bool, error) {
	if m.GitAuth == nil {
		return "", false, errors.New("daemon nemá k dispozici git")
	}
	mpLock := m.marketplaceLock(info.MarketplaceName)
	mpLock.Lock()
	defer mpLock.Unlock()

	cloneURL, err := buildCloneURL(&info.Recipe.MarketplaceSource)
	if err != nil {
		return "", false, err
	}

	res, err := m.GitAuth.Pull(ctx, info.MarketplaceDir, cloneURL)
	if err != nil {
		return "", false, err
	}

	newSHA := res.HeadSHA
	changed := newSHA != "" && newSHA != info.HeadSHA

	if changed {
		record, err := readManifest(info.ManifestPath)
		if err != nil || record == nil {
			return newSHA, changed, fmt.Errorf("nelze načíst manifest pro update: %w", err)
		}
		// Aktualizuj PluginEntries — nahraď "sha:<old>" za "sha:<new>".
		newEntries := make([]string, 0, len(record.PluginEntries))
		shaReplaced := false
		for _, entry := range record.PluginEntries {
			if strings.HasPrefix(entry, "sha:") {
				newEntries = append(newEntries, "sha:"+newSHA)
				shaReplaced = true
				continue
			}
			newEntries = append(newEntries, entry)
		}
		if !shaReplaced {
			newEntries = append(newEntries, "sha:"+newSHA)
		}
		record.PluginEntries = newEntries
		record.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
		if err := writeJSON(info.ManifestPath, record); err != nil {
			return newSHA, changed, fmt.Errorf("nelze přepsat manifest po update: %w", err)
		}
	}
	return newSHA, changed, nil
}

// allowedCredentialHostPattern omezuje, pro které hosty může Hub UI ukládat
// PAT do keychainu. Whitelist pokrývá běžné public Git hostingy a self-hosted
// GitLab/Gitea ve formátu *.<corp>.com.
var allowedCredentialHostPattern = regexp.MustCompile(`^([a-z0-9-]+\.)+[a-z]{2,}$`)

// SetGitCredential uloží PAT do OS keychainu pro daný host. Volá ho daemon
// HTTP endpoint /v1/plugin/credentials.
//
// Host musí matchovat allowedCredentialHostPattern (žádné IP literály, žádný
// localhost). Vlastní whitelist konkrétních hostů necháváme na UI, tady jen
// základní defensive check.
func (m *Manager) SetGitCredential(host, token string) error {
	cleanHost := strings.ToLower(strings.TrimSpace(host))
	if cleanHost == "" {
		return errors.New("host je prázdný")
	}
	if strings.Contains(cleanHost, "://") {
		// někdo poslal URL místo hostnamu — pokus o extrakci
		if parsed, err := url.Parse(cleanHost); err == nil && parsed.Hostname() != "" {
			cleanHost = parsed.Hostname()
		}
	}
	if !allowedCredentialHostPattern.MatchString(cleanHost) {
		return fmt.Errorf("host %q není ve validním tvaru DNS hostname", cleanHost)
	}
	if cleanHost == "localhost" {
		return errors.New("localhost není povolen jako credential host")
	}
	if strings.TrimSpace(token) == "" {
		return errors.New("token je prázdný")
	}
	if m.GitAuth == nil {
		return errors.New("daemon nemá k dispozici git/keyring")
	}

	// Type-assert k konkrétní implementaci, která má SetGitCredential.
	type credentialSetter interface {
		SetCredential(host, token string) error
	}
	if cs, ok := m.GitAuth.(credentialSetter); ok {
		return cs.SetCredential(cleanHost, token)
	}
	// Fallback: vytvoř OSKeyring přímo (GitAuthRunner nemusí mít keychain mgmt).
	return gitauth.NewOSKeyring().Set(cleanHost, token)
}

// DeleteGitCredential smaže PAT z keychainu.
func (m *Manager) DeleteGitCredential(host string) error {
	cleanHost := strings.ToLower(strings.TrimSpace(host))
	if cleanHost == "" {
		return errors.New("host je prázdný")
	}
	if strings.Contains(cleanHost, "://") {
		if parsed, err := url.Parse(cleanHost); err == nil && parsed.Hostname() != "" {
			cleanHost = parsed.Hostname()
		}
	}
	type credentialDeleter interface {
		DeleteCredential(host string) error
	}
	if cd, ok := m.GitAuth.(credentialDeleter); ok {
		return cd.DeleteCredential(cleanHost)
	}
	return gitauth.NewOSKeyring().Delete(cleanHost)
}

// BuildRecipeFromLocalPlugin sestaví PluginRecipe z lokálně nainstalovaného
// pluginu — ať už byl instalovaný přes Hub recipe model nebo přes
// `/plugin marketplace add ...` v Claude Code. Volá ho exportLocalAsset, aby
// uživatel mohl jedním klikem nasdílet plugin, který má lokálně.
//
// Postup:
//  1. Najde plugin v ~/.claude/plugins/installed_plugins.json podle slugu.
//  2. Z pluginKey ("<plugin>@<marketplace>") extrahuje obě jména.
//  3. Najde marketplace clone v ~/.claude/plugins/marketplaces/<marketplace>/
//  4. Z .git/config přečte remote URL.
//  5. Pokud URL ukazuje na github.com → source=github (repo=owner/repo),
//     jinak source=url.
func (m *Manager) BuildRecipeFromLocalPlugin(pluginSlug string) (*PluginRecipe, error) {
	pluginManifestPath := filepath.Join(m.ClaudeHome, "plugins", "installed_plugins.json")
	doc, err := readPluginDoc(pluginManifestPath)
	if err != nil {
		return nil, fmt.Errorf("nelze přečíst installed_plugins.json: %w", err)
	}

	// Plugin keys v installed_plugins.json jsou "<plugin>@<marketplace>".
	// Slug v LocalAsset je Slugify(pluginKey) — zpětně z toho nelze přesně
	// rekonstruovat originální key (Slugify odstraňuje @ a další znaky), takže
	// musíme projít všechny klíče a najít ten, jehož slug matchuje.
	var pluginKey string
	for key := range doc.Plugins {
		if Slugify(key) == pluginSlug {
			pluginKey = key
			break
		}
	}
	if pluginKey == "" {
		return nil, fmt.Errorf("plugin %q nenalezen v installed_plugins.json — pravděpodobně není v Claude Code zaregistrovaný", pluginSlug)
	}

	atIdx := strings.LastIndex(pluginKey, "@")
	if atIdx < 0 {
		return nil, fmt.Errorf("plugin key %q nemá očekávaný tvar \"<plugin>@<marketplace>\"", pluginKey)
	}
	pluginName := pluginKey[:atIdx]
	marketplaceName := pluginKey[atIdx+1:]

	// Marketplace clone musí existovat (Claude Code ho vytvoří při install).
	mpDir := marketplaceDirFor(m.ClaudeHome, marketplaceName)
	originURL, err := readGitOriginURL(mpDir)
	if err != nil {
		return nil, fmt.Errorf("nelze zjistit marketplace URL — marketplace %q není naklonovaný v %s (%w)", marketplaceName, mpDir, err)
	}

	source := classifyGitURL(originURL)
	recipe := &PluginRecipe{
		MarketplaceName:   marketplaceName,
		MarketplaceSource: source,
		PluginName:        pluginName,
		// AutoUpdate nepřebíráme — uživatel ho rozhodne v UI při uploadu.
	}
	return recipe, nil
}

// readGitOriginURL přečte URL remote "origin" z .git/config bez závislosti na
// git binárce. Parsuje INI-style soubor — žádné případy obecnýho git configu
// tady neumíme, ale pro `[remote "origin"] url = ...` to stačí.
func readGitOriginURL(repoPath string) (string, error) {
	configPath := filepath.Join(repoPath, ".git", "config")
	data, err := os.ReadFile(configPath)
	if err != nil {
		return "", err
	}
	inOrigin := false
	for _, line := range strings.Split(string(data), "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "[") && strings.HasSuffix(trimmed, "]") {
			inOrigin = trimmed == `[remote "origin"]`
			continue
		}
		if inOrigin && strings.HasPrefix(strings.ToLower(trimmed), "url") {
			parts := strings.SplitN(trimmed, "=", 2)
			if len(parts) == 2 {
				return strings.TrimSpace(parts[1]), nil
			}
		}
	}
	return "", errors.New("origin URL nenalezena v .git/config")
}

// classifyGitURL rozhodne, jestli URL má tvar github (owner/repo) nebo obecné
// git URL. Pro github vrací zkrácený source s polem "repo", pro ostatní hosty
// (GitLab, Bitbucket, self-hosted) plný url source.
func classifyGitURL(rawURL string) MarketplaceSource {
	// SSH zkrácený tvar: git@github.com:owner/repo.git → převést na https.
	if strings.HasPrefix(rawURL, "git@") {
		// git@host:path
		at := strings.Index(rawURL, "@")
		colon := strings.Index(rawURL[at:], ":")
		if colon > 0 {
			host := rawURL[at+1 : at+colon]
			path := strings.TrimSuffix(rawURL[at+colon+1:], ".git")
			if strings.EqualFold(host, "github.com") {
				return MarketplaceSource{Source: "github", Repo: path}
			}
			return MarketplaceSource{Source: "url", URL: "https://" + host + "/" + path + ".git"}
		}
	}
	// HTTPS tvar.
	if strings.HasPrefix(rawURL, "https://github.com/") {
		path := strings.TrimSuffix(strings.TrimPrefix(rawURL, "https://github.com/"), ".git")
		return MarketplaceSource{Source: "github", Repo: path}
	}
	return MarketplaceSource{Source: "url", URL: rawURL}
}

// findPluginKeyBySlug projde installed_plugins.json a najde plugin, jehož
// Slugified key matchuje hledaný slug. Vrátí původní pluginKey (např.
// "animato-mcp@animato"), nebo prázdný string, pokud plugin lokálně není.
//
// Slouží pro detekci „plugin je lokálně nainstalovaný, i když nebyl
// instalovaný přes Hub recipe model".
func (m *Manager) findPluginKeyBySlug(slug string) string {
	pluginManifestPath := filepath.Join(m.ClaudeHome, "plugins", "installed_plugins.json")
	doc, err := readPluginDoc(pluginManifestPath)
	if err != nil {
		return ""
	}
	for key := range doc.Plugins {
		if Slugify(key) == slug {
			return key
		}
	}
	return ""
}

// isPluginEnabledInSettings přečte ~/.claude/settings.json a vrátí stav
// enabledPlugins[pluginKey]. Default je true (plugin je default zapnutý,
// pokud existuje v installed_plugins.json) — explicitně false jen pokud
// settings.json říká false.
func (m *Manager) isPluginEnabledInSettings(pluginKey string) bool {
	settingsPath := filepath.Join(m.ClaudeHome, "settings.json")
	doc, err := readSettingsDoc(settingsPath)
	if err != nil {
		return true
	}
	enabled, err := readSubObject(doc.Sections["enabledPlugins"])
	if err != nil {
		return true
	}
	raw, ok := enabled[pluginKey]
	if !ok {
		return true
	}
	return string(raw) != "false"
}

// recipePayloadFromManifests hledá Hub recipe manifest podle pluginSlug a
// vrátí RecipePayload (JSON-stringified PluginRecipe). Prázdný string, pokud
// manifest neexistuje nebo recipe payload chybí.
//
// Slouží pro export plugin recipe zpět do katalogu — pokud byl plugin
// instalovaný přes Hub recipe model, recipe se opětovně sdílet dá bez ručního
// vyplňování.
func (m *Manager) recipePayloadFromManifests(pluginSlug string) string {
	installedDir := filepath.Join(m.HubHome, "installed")
	entries, err := os.ReadDir(installedDir)
	if err != nil {
		return ""
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if !strings.HasPrefix(name, "plugin-"+pluginSlug+"__") || !strings.HasSuffix(name, ".json") {
			continue
		}
		record, err := readManifest(filepath.Join(installedDir, name))
		if err != nil || record == nil {
			continue
		}
		if record.RecipePayload != "" {
			return record.RecipePayload
		}
	}
	return ""
}

// HasGitCredential vrátí true, pokud daemon má pro host uložený PAT.
// Slouží UI, aby zobrazila stav "PAT v keychainu pro <host>" bez exposování tokenu.
func (m *Manager) HasGitCredential(host string) bool {
	cleanHost := strings.ToLower(strings.TrimSpace(host))
	if cleanHost == "" {
		return false
	}
	type credentialChecker interface {
		HasCredential(host string) bool
	}
	if cc, ok := m.GitAuth.(credentialChecker); ok {
		return cc.HasCredential(cleanHost)
	}
	_, err := gitauth.NewOSKeyring().Get(cleanHost)
	return err == nil
}
