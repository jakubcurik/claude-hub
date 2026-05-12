package claudecode

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// mcpServerMap drží MCP servery v stabilní podobě (mapa klíč → raw JSON).
type mcpDoc struct {
	MCPServers map[string]json.RawMessage `json:"mcpServers"`
	Other      map[string]json.RawMessage `json:"-"`
}

func readMCPDoc(path string) (*mcpDoc, error) {
	doc := &mcpDoc{
		MCPServers: map[string]json.RawMessage{},
		Other:      map[string]json.RawMessage{},
	}

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
	raw := map[string]json.RawMessage{}
	if err := json.Unmarshal(bytes, &raw); err != nil {
		return nil, fmt.Errorf("nelze parsovat MCP soubor %s: %w", path, err)
	}
	for key, value := range raw {
		if key == "mcpServers" {
			servers := map[string]json.RawMessage{}
			if len(value) > 0 && string(value) != "null" {
				if err := json.Unmarshal(value, &servers); err != nil {
					return nil, fmt.Errorf("nelze parsovat mcpServers: %w", err)
				}
			}
			doc.MCPServers = servers
			continue
		}
		doc.Other[key] = value
	}
	return doc, nil
}

func writeMCPDoc(path string, doc *mcpDoc) error {
	out := map[string]json.RawMessage{}
	for key, value := range doc.Other {
		out[key] = value
	}
	if len(doc.MCPServers) > 0 {
		serversBytes, err := marshalIndentSorted(doc.MCPServers)
		if err != nil {
			return err
		}
		out["mcpServers"] = serversBytes
	}
	content, err := marshalIndentSorted(out)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, append(content, '\n'), 0o644)
}

// extractMCPServersFromAsset najde v souborech assetu mcpServers definice a vrátí je.
// Akceptuje buď celý `.mcp.json` (s `mcpServers`), nebo soubor obsahující přímo mapu.
func extractMCPServersFromAsset(asset CatalogAsset) (map[string]json.RawMessage, error) {
	servers := map[string]json.RawMessage{}
	for _, file := range asset.Files {
		raw := map[string]json.RawMessage{}
		if err := json.Unmarshal([]byte(file.Content), &raw); err != nil {
			continue
		}
		if value, ok := raw["mcpServers"]; ok {
			inner := map[string]json.RawMessage{}
			if err := json.Unmarshal(value, &inner); err == nil {
				for k, v := range inner {
					servers[k] = v
				}
				continue
			}
		}
		// Soubor je rovnou mapa serverů?
		looksLikeServers := true
		for _, val := range raw {
			var probe map[string]json.RawMessage
			if err := json.Unmarshal(val, &probe); err != nil {
				looksLikeServers = false
				break
			}
		}
		if looksLikeServers {
			for k, v := range raw {
				servers[k] = v
			}
		}
	}
	if len(servers) == 0 {
		return nil, errors.New("MCP položka neobsahuje žádné mcpServers definice")
	}
	return servers, nil
}

// hookDoc je settings.json se sekcí "hooks", kde každý event mapuje na pole položek.
type hookDoc struct {
	Other map[string]json.RawMessage          `json:"-"`
	Hooks map[string][]json.RawMessage        `json:"-"`
}

func readHookDoc(path string) (*hookDoc, error) {
	doc := &hookDoc{
		Other: map[string]json.RawMessage{},
		Hooks: map[string][]json.RawMessage{},
	}
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
	raw := map[string]json.RawMessage{}
	if err := json.Unmarshal(bytes, &raw); err != nil {
		return nil, fmt.Errorf("nelze parsovat settings.json %s: %w", path, err)
	}
	for key, value := range raw {
		if key == "hooks" {
			hooks := map[string][]json.RawMessage{}
			if len(value) > 0 && string(value) != "null" {
				if err := json.Unmarshal(value, &hooks); err != nil {
					return nil, fmt.Errorf("nelze parsovat hooks: %w", err)
				}
			}
			doc.Hooks = hooks
			continue
		}
		doc.Other[key] = value
	}
	return doc, nil
}

func writeHookDoc(path string, doc *hookDoc) error {
	out := map[string]json.RawMessage{}
	for key, value := range doc.Other {
		out[key] = value
	}
	if len(doc.Hooks) > 0 {
		hooksBytes, err := marshalIndentSorted(doc.Hooks)
		if err != nil {
			return err
		}
		out["hooks"] = hooksBytes
	}
	content, err := marshalIndentSorted(out)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, append(content, '\n'), 0o644)
}

// extractHookEntriesFromAsset načte z assetových souborů sekci hooks.
// Vrací mapu event → seznam položek.
func extractHookEntriesFromAsset(asset CatalogAsset) (map[string][]json.RawMessage, error) {
	result := map[string][]json.RawMessage{}
	for _, file := range asset.Files {
		raw := map[string]json.RawMessage{}
		if err := json.Unmarshal([]byte(file.Content), &raw); err != nil {
			continue
		}
		hooksValue, ok := raw["hooks"]
		if !ok {
			// soubor je rovnou mapa eventů?
			hooksValue, _ = json.Marshal(raw)
		}
		hooks := map[string][]json.RawMessage{}
		if err := json.Unmarshal(hooksValue, &hooks); err != nil {
			continue
		}
		for event, entries := range hooks {
			result[event] = append(result[event], entries...)
		}
	}
	if len(result) == 0 {
		return nil, errors.New("hook položka neobsahuje žádné hooky")
	}
	return result, nil
}

// settingsDoc reprezentuje settings.json jako flat mapu top-level klíčů.
// Slouží pro sdílení jednotlivých sekcí (env, model, statusLine, ...) přes
// AssetTypeConfig. Sekce hooks má vlastní typ a tento doc se jí netýká.
type settingsDoc struct {
	Sections map[string]json.RawMessage `json:"-"`
}

func readSettingsDoc(path string) (*settingsDoc, error) {
	doc := &settingsDoc{Sections: map[string]json.RawMessage{}}
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
	if err := json.Unmarshal(bytes, &doc.Sections); err != nil {
		return nil, fmt.Errorf("nelze parsovat settings.json %s: %w", path, err)
	}
	return doc, nil
}

func writeSettingsDoc(path string, doc *settingsDoc) error {
	content, err := marshalIndentSorted(doc.Sections)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, append(content, '\n'), 0o644)
}

// extractConfigSectionFromAsset najde v souborech assetu konkrétní sekci (podle slugu).
// Asset může obsahovat buď obal `{"<section>": <value>}` nebo přímo `<value>`.
func extractConfigSectionFromAsset(asset CatalogAsset, sectionKey string) (json.RawMessage, error) {
	for _, file := range asset.Files {
		raw := map[string]json.RawMessage{}
		if err := json.Unmarshal([]byte(file.Content), &raw); err == nil {
			if value, ok := raw[sectionKey]; ok && len(value) > 0 {
				return value, nil
			}
		}
		// Soubor je rovnou hodnota sekce
		trimmed := strings.TrimSpace(file.Content)
		if trimmed == "" {
			continue
		}
		var probe any
		if err := json.Unmarshal([]byte(trimmed), &probe); err == nil {
			return json.RawMessage(trimmed), nil
		}
	}
	return nil, fmt.Errorf("položka neobsahuje žádnou hodnotu pro sekci %q", sectionKey)
}

// pluginDoc reprezentuje installed_plugins.json.
type pluginDoc struct {
	Plugins map[string][]installedPluginEntry `json:"plugins"`
	Other   map[string]json.RawMessage        `json:"-"`
}

func readPluginDoc(path string) (*pluginDoc, error) {
	doc := &pluginDoc{
		Plugins: map[string][]installedPluginEntry{},
		Other:   map[string]json.RawMessage{},
	}
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
	raw := map[string]json.RawMessage{}
	if err := json.Unmarshal(bytes, &raw); err != nil {
		return nil, fmt.Errorf("nelze parsovat plugin manifest %s: %w", path, err)
	}
	for key, value := range raw {
		if key == "plugins" {
			plugins := map[string][]installedPluginEntry{}
			if len(value) > 0 && string(value) != "null" {
				if err := json.Unmarshal(value, &plugins); err != nil {
					return nil, fmt.Errorf("nelze parsovat plugins: %w", err)
				}
			}
			doc.Plugins = plugins
			continue
		}
		doc.Other[key] = value
	}
	return doc, nil
}

func writePluginDoc(path string, doc *pluginDoc) error {
	out := map[string]json.RawMessage{}
	for key, value := range doc.Other {
		out[key] = value
	}
	if len(doc.Plugins) > 0 {
		bytes, err := marshalIndentSorted(doc.Plugins)
		if err != nil {
			return err
		}
		out["plugins"] = bytes
	} else {
		bytes, err := marshalIndentSorted(map[string][]installedPluginEntry{})
		if err != nil {
			return err
		}
		out["plugins"] = bytes
	}
	content, err := marshalIndentSorted(out)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, append(content, '\n'), 0o644)
}

// marshalIndentSorted serializuje mapu se stabilním pořadím klíčů, aby byly diffy předvídatelné.
func marshalIndentSorted(value any) ([]byte, error) {
	switch typed := value.(type) {
	case map[string]json.RawMessage:
		keys := sortedKeys(typed)
		var builder strings.Builder
		builder.WriteString("{\n")
		for i, key := range keys {
			builder.WriteString(fmt.Sprintf("  %q: ", key))
			indented, err := indentJSON(typed[key], "  ")
			if err != nil {
				return nil, err
			}
			builder.WriteString(indented)
			if i < len(keys)-1 {
				builder.WriteString(",")
			}
			builder.WriteString("\n")
		}
		builder.WriteString("}")
		return []byte(builder.String()), nil
	case map[string][]json.RawMessage:
		keys := make([]string, 0, len(typed))
		for k := range typed {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		var builder strings.Builder
		builder.WriteString("{\n")
		for i, key := range keys {
			entries := typed[key]
			builder.WriteString(fmt.Sprintf("  %q: [", key))
			if len(entries) == 0 {
				builder.WriteString("]")
			} else {
				builder.WriteString("\n")
				for j, entry := range entries {
					indented, err := indentJSON(entry, "    ")
					if err != nil {
						return nil, err
					}
					builder.WriteString("    ")
					builder.WriteString(indented)
					if j < len(entries)-1 {
						builder.WriteString(",")
					}
					builder.WriteString("\n")
				}
				builder.WriteString("  ]")
			}
			if i < len(keys)-1 {
				builder.WriteString(",")
			}
			builder.WriteString("\n")
		}
		builder.WriteString("}")
		return []byte(builder.String()), nil
	case map[string][]installedPluginEntry:
		return json.MarshalIndent(typed, "", "  ")
	default:
		return json.MarshalIndent(value, "", "  ")
	}
}

func sortedKeys(m map[string]json.RawMessage) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func indentJSON(raw json.RawMessage, indent string) (string, error) {
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return string(raw), nil
	}
	bytes, err := json.MarshalIndent(value, indent, "  ")
	if err != nil {
		return "", err
	}
	return string(bytes), nil
}
