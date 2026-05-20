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
