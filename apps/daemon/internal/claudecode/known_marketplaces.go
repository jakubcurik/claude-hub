package claudecode

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// knownMarketplaceEntry je položka v ~/.claude/plugins/known_marketplaces.json.
// Tvar musí přesně odpovídat tomu, co generuje Claude Code, jinak `/plugin`
// hlásí "Marketplace not found" nebo "expected object, received string".
type knownMarketplaceEntry struct {
	Source          json.RawMessage `json:"source"`
	InstallLocation string          `json:"installLocation"`
	LastUpdated     string          `json:"lastUpdated"`
}

// knownMarketplacesDoc reprezentuje known_marketplaces.json. Top-level je
// rovnou mapa marketplaceName→entry (žádný wrapper jako u installed_plugins.json).
type knownMarketplacesDoc struct {
	Entries map[string]knownMarketplaceEntry
}

func knownMarketplacesPath(claudeHome string) string {
	return filepath.Join(claudeHome, "plugins", "known_marketplaces.json")
}

func readKnownMarketplacesDoc(path string) (*knownMarketplacesDoc, error) {
	doc := &knownMarketplacesDoc{Entries: map[string]knownMarketplaceEntry{}}
	bytes, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return doc, nil
		}
		return nil, err
	}
	if len(bytes) == 0 {
		return doc, nil
	}
	if err := json.Unmarshal(bytes, &doc.Entries); err != nil {
		return nil, fmt.Errorf("nelze parsovat known_marketplaces.json: %w", err)
	}
	if doc.Entries == nil {
		doc.Entries = map[string]knownMarketplaceEntry{}
	}
	return doc, nil
}

func writeKnownMarketplacesDoc(path string, doc *knownMarketplacesDoc) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	if len(doc.Entries) == 0 {
		// Pokud se vyprázdní, smaž soubor — Claude Code ho regeneruje sám.
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return nil
	}
	content, err := json.MarshalIndent(doc.Entries, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(content, '\n'), 0o644)
}

// upsertKnownMarketplace nastaví entry pro recipe.MarketplaceName na hodnotu,
// kterou Claude Code očekává: source z recipe (JSON-marshalled), installLocation
// na path klonu a lastUpdated na teď.
//
// Vrací (předchozí raw entry jako string, ok) — slouží pro snapshot do manifestu.
func upsertKnownMarketplace(doc *knownMarketplacesDoc, recipe *PluginRecipe, mpDir string) (string, bool, error) {
	prevRaw := ""
	prevOK := false
	if prev, ok := doc.Entries[recipe.MarketplaceName]; ok {
		raw, err := json.Marshal(prev)
		if err != nil {
			return "", false, err
		}
		prevRaw = string(raw)
		prevOK = true
	}
	sourceRaw, err := json.Marshal(recipe.MarketplaceSource)
	if err != nil {
		return "", false, err
	}
	doc.Entries[recipe.MarketplaceName] = knownMarketplaceEntry{
		Source:          sourceRaw,
		InstallLocation: mpDir,
		LastUpdated:     time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
	}
	return prevRaw, prevOK, nil
}

// restoreKnownMarketplace vrátí entry do stavu před patchem podle uloženého
// snapshotu. snapshot == snapshotAbsent znamená "smaž entry".
func restoreKnownMarketplace(doc *knownMarketplacesDoc, marketplaceName, snapshot string) error {
	if snapshot == snapshotAbsent {
		delete(doc.Entries, marketplaceName)
		return nil
	}
	var entry knownMarketplaceEntry
	if err := json.Unmarshal([]byte(snapshot), &entry); err != nil {
		return fmt.Errorf("nelze obnovit known_marketplaces.%s: %w", marketplaceName, err)
	}
	doc.Entries[marketplaceName] = entry
	return nil
}

// marketplaceReferencedByInstalledPlugins vrátí true, pokud existuje plugin
// v installed_plugins.json, jehož klíč končí na "@<marketplaceName>" a není
// roven excludePluginKey. Slouží pro rozhodnutí, jestli při uninstallu pluginu
// smazat i marketplace entry / clone.
func marketplaceReferencedByInstalledPlugins(doc *pluginDoc, marketplaceName, excludePluginKey string) bool {
	if doc == nil {
		return false
	}
	suffix := "@" + marketplaceName
	for key := range doc.Plugins {
		if key == excludePluginKey {
			continue
		}
		if len(key) > len(suffix) && key[len(key)-len(suffix):] == suffix {
			return true
		}
	}
	return false
}
