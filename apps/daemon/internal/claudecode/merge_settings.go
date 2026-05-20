package claudecode

import (
	"encoding/json"
	"fmt"
	"sort"
)

// snapshotAbsent je sentinel ve ContentSnapshots: klíč v cílovém dokumentu
// před patchem neexistoval, takže při uninstallu se má zase smazat (ne obnovit).
// Prázdný řetězec by se mohl plést s validním "null" nebo "" hodnotou, proto
// explicitní marker.
const snapshotAbsent = "<absent>"

// Snapshot klíče pro recipe install. Drží předchozí hodnoty napatchovaných
// sekcí, aby uninstall mohl vrátit byte-equal stav.
//
// Konvence: "<section>.<subkey>" → RawMessage previous value, nebo snapshotAbsent.
func recipeSnapshotKey(section, subkey string) string {
	return section + "." + subkey
}

// patchSettingsForRecipe upraví settingsDoc tak, aby obsahoval marketplace,
// enabled flag a (volitelně) plugin configs pro daný recipe. Předchozí
// hodnoty zapíše do snapshots — uninstall ho použije pro restore.
//
// Sekce v settings.json:
//
//	extraKnownMarketplaces.<marketplaceName> = { source: ..., autoUpdate: ... }
//	enabledPlugins["<plugin>@<marketplace>"] = true
//	pluginConfigs["<plugin>@<marketplace>"].options = { ... }  (jen pokud defaultOptions)
func patchSettingsForRecipe(doc *settingsDoc, recipe *PluginRecipe, snapshots map[string]string) error {
	if doc == nil {
		return fmt.Errorf("settingsDoc je nil")
	}
	pluginKey := recipe.PluginKey()

	// 1) extraKnownMarketplaces
	mpSection := "extraKnownMarketplaces"
	mpMap, err := readSubObject(doc.Sections[mpSection])
	if err != nil {
		return fmt.Errorf("nelze parsovat sekci %s: %w", mpSection, err)
	}
	if prev, ok := mpMap[recipe.MarketplaceName]; ok {
		snapshots[recipeSnapshotKey(mpSection, recipe.MarketplaceName)] = string(prev)
	} else {
		snapshots[recipeSnapshotKey(mpSection, recipe.MarketplaceName)] = snapshotAbsent
	}
	mpEntry, err := buildMarketplaceEntry(recipe)
	if err != nil {
		return fmt.Errorf("nelze sestavit marketplace entry: %w", err)
	}
	mpMap[recipe.MarketplaceName] = mpEntry
	encoded, err := marshalSubObject(mpMap)
	if err != nil {
		return err
	}
	doc.Sections[mpSection] = encoded

	// 2) enabledPlugins
	enabledSection := "enabledPlugins"
	enabledMap, err := readSubObject(doc.Sections[enabledSection])
	if err != nil {
		return fmt.Errorf("nelze parsovat sekci %s: %w", enabledSection, err)
	}
	if prev, ok := enabledMap[pluginKey]; ok {
		snapshots[recipeSnapshotKey(enabledSection, pluginKey)] = string(prev)
	} else {
		snapshots[recipeSnapshotKey(enabledSection, pluginKey)] = snapshotAbsent
	}
	enabledMap[pluginKey] = json.RawMessage("true")
	encoded, err = marshalSubObject(enabledMap)
	if err != nil {
		return err
	}
	doc.Sections[enabledSection] = encoded

	// 3) pluginConfigs.options (jen když máme non-sensitive defaults)
	if len(recipe.DefaultOptions) > 0 {
		configsSection := "pluginConfigs"
		configsMap, err := readSubObject(doc.Sections[configsSection])
		if err != nil {
			return fmt.Errorf("nelze parsovat sekci %s: %w", configsSection, err)
		}
		if prev, ok := configsMap[pluginKey]; ok {
			snapshots[recipeSnapshotKey(configsSection, pluginKey)] = string(prev)
		} else {
			snapshots[recipeSnapshotKey(configsSection, pluginKey)] = snapshotAbsent
		}
		optionsRaw, err := json.Marshal(recipe.DefaultOptions)
		if err != nil {
			return fmt.Errorf("nelze marshalovat defaultOptions: %w", err)
		}
		pluginConfigEntry := map[string]json.RawMessage{
			"options": optionsRaw,
		}
		entryRaw, err := marshalSubObject(pluginConfigEntry)
		if err != nil {
			return err
		}
		configsMap[pluginKey] = entryRaw
		encoded, err := marshalSubObject(configsMap)
		if err != nil {
			return err
		}
		doc.Sections[configsSection] = encoded
	}

	return nil
}

// togglePluginInSettings překlopí enabledPlugins[pluginKey] na true/false.
// Žádné snapshots — toggle je idempotentní operace, uninstall stejně všechno
// odstraní podle původních recipe snapshots.
func togglePluginInSettings(doc *settingsDoc, pluginKey string, enabled bool) error {
	enabledSection := "enabledPlugins"
	enabledMap, err := readSubObject(doc.Sections[enabledSection])
	if err != nil {
		return fmt.Errorf("nelze parsovat sekci %s: %w", enabledSection, err)
	}
	if enabled {
		enabledMap[pluginKey] = json.RawMessage("true")
	} else {
		enabledMap[pluginKey] = json.RawMessage("false")
	}
	encoded, err := marshalSubObject(enabledMap)
	if err != nil {
		return err
	}
	doc.Sections[enabledSection] = encoded
	return nil
}

// restoreSettingsFromSnapshots vrátí změny napsané patchSettingsForRecipe.
// Pro každý uložený klíč buď obnoví předchozí hodnotu, nebo (pokud snapshot je
// snapshotAbsent) smaže klíč ze sekce.
//
// Volá se při uninstallPluginRecipe.
func restoreSettingsFromSnapshots(doc *settingsDoc, recipe *PluginRecipe, snapshots map[string]string) error {
	if doc == nil {
		return fmt.Errorf("settingsDoc je nil")
	}
	pluginKey := recipe.PluginKey()

	restoreSection := func(section, subkey string) error {
		key := recipeSnapshotKey(section, subkey)
		snap, ok := snapshots[key]
		if !ok {
			// nepatch ovali jsme to → nedělej nic
			return nil
		}
		current, err := readSubObject(doc.Sections[section])
		if err != nil {
			return err
		}
		if snap == snapshotAbsent {
			delete(current, subkey)
		} else {
			current[subkey] = json.RawMessage(snap)
		}
		if len(current) == 0 {
			delete(doc.Sections, section)
			return nil
		}
		encoded, err := marshalSubObject(current)
		if err != nil {
			return err
		}
		doc.Sections[section] = encoded
		return nil
	}

	if err := restoreSection("extraKnownMarketplaces", recipe.MarketplaceName); err != nil {
		return err
	}
	if err := restoreSection("enabledPlugins", pluginKey); err != nil {
		return err
	}
	if err := restoreSection("pluginConfigs", pluginKey); err != nil {
		return err
	}
	return nil
}

// buildMarketplaceEntry vytvoří JSON value, kterou Claude Code očekává v
// extraKnownMarketplaces[<name>]:
//
//	{ "source": { ... source-specific ... }, "autoUpdate": true|false }
//
// `source` přebírá tvar přímo z PluginRecipe.MarketplaceSource (discriminated
// union podle pole `source`).
func buildMarketplaceEntry(recipe *PluginRecipe) (json.RawMessage, error) {
	sourceRaw, err := json.Marshal(recipe.MarketplaceSource)
	if err != nil {
		return nil, err
	}
	entry := map[string]json.RawMessage{
		"source": sourceRaw,
	}
	if recipe.AutoUpdateEnabled() {
		entry["autoUpdate"] = json.RawMessage("true")
	} else {
		entry["autoUpdate"] = json.RawMessage("false")
	}
	return marshalSubObject(entry)
}

// readSubObject naparsuje vnořený objekt v settings.json (např. obsah
// extraKnownMarketplaces nebo enabledPlugins) do flat mapy raw JSON hodnot.
// Pro `null` nebo prázdný RawMessage vrátí prázdnou mapu.
func readSubObject(raw json.RawMessage) (map[string]json.RawMessage, error) {
	result := map[string]json.RawMessage{}
	if len(raw) == 0 || string(raw) == "null" {
		return result, nil
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, fmt.Errorf("podsekce není objekt: %w", err)
	}
	return result, nil
}

// marshalSubObject serializuje mapu zpět na JSON s deterministickým pořadím
// klíčů (stejně jako marshalIndentSorted v merge.go).
func marshalSubObject(m map[string]json.RawMessage) (json.RawMessage, error) {
	if len(m) == 0 {
		return json.RawMessage("{}"), nil
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	// Použij standardní json.Marshal pro vnořené hodnoty — jejich vnitřní
	// pořadí klíčů řešíme úrovní výše (recipe entry je explicitně skládaný).
	ordered := struct{}{}
	_ = ordered

	// Sestav manuálně, aby zaručil pořadí klíčů.
	parts := make([]byte, 0, 64*len(keys))
	parts = append(parts, '{')
	for i, k := range keys {
		if i > 0 {
			parts = append(parts, ',')
		}
		keyJSON, err := json.Marshal(k)
		if err != nil {
			return nil, err
		}
		parts = append(parts, keyJSON...)
		parts = append(parts, ':')
		parts = append(parts, m[k]...)
	}
	parts = append(parts, '}')
	return parts, nil
}
