package claudecode

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// telemetryEnvKeys jsou klíče v sekci "env" souboru ~/.claude/settings.json,
// které Hub spravuje pro OpenTelemetry export. Při EnableTelemetry je doplníme
// (s zachováním ostatních env), při DisableTelemetry odstraníme **jen tyto klíče**,
// aby uživatelovo vlastní env zůstalo netknuté.
var telemetryEnvKeys = []string{
	"CLAUDE_CODE_ENABLE_TELEMETRY",
	"OTEL_METRICS_EXPORTER",
	"OTEL_LOGS_EXPORTER",
	"OTEL_EXPORTER_OTLP_PROTOCOL",
	"OTEL_EXPORTER_OTLP_ENDPOINT",
	"OTEL_METRIC_EXPORT_INTERVAL",
	"OTEL_LOGS_EXPORT_INTERVAL",
}

// telemetryConfigFile je sidecar v HubHome, kde si pamatujeme, zda Hub
// telemetry aktivně spravuje. Backfill při startu daemonu to využívá, aby věděl
// jestli má při novém pairingu znovu zapsat env.
type telemetryConfig struct {
	Enabled     bool   `json:"enabled"`
	APIEndpoint string `json:"apiEndpoint"`
}

func (m *Manager) telemetryConfigPath() string {
	return filepath.Join(m.HubHome, "telemetry.json")
}

// LoadTelemetryConfig vrátí poslední uložený stav. Pokud soubor neexistuje,
// vrátí zero-hodnoty bez chyby.
func (m *Manager) LoadTelemetryConfig() (bool, string, error) {
	bytes, err := os.ReadFile(m.telemetryConfigPath())
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, "", nil
		}
		return false, "", err
	}
	var cfg telemetryConfig
	if err := json.Unmarshal(bytes, &cfg); err != nil {
		return false, "", err
	}
	return cfg.Enabled, cfg.APIEndpoint, nil
}

func (m *Manager) saveTelemetryConfig(enabled bool, apiEndpoint string) error {
	if err := os.MkdirAll(m.HubHome, 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(telemetryConfig{Enabled: enabled, APIEndpoint: apiEndpoint}, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(m.telemetryConfigPath(), append(data, '\n'), 0o600)
}

// EnableTelemetry doplní env proměnné pro OTel export do ~/.claude/settings.json
// idempotentně — zachová ostatní env i jiné sekce souboru. Receiver endpoint
// je pevný (lokální daemon na 127.0.0.1:4318); apiEndpoint je centrální API
// pro forwarder a uloží se do telemetry config sidecaru.
func (m *Manager) EnableTelemetry(apiEndpoint string) error {
	if err := m.EnsureBaseDirs(); err != nil {
		return err
	}
	settingsPath := filepath.Join(m.ClaudeHome, "settings.json")
	if err := m.mergeTelemetryEnv(settingsPath, true); err != nil {
		return err
	}
	return m.saveTelemetryConfig(true, apiEndpoint)
}

// DisableTelemetry odstraní z ~/.claude/settings.json pouze Hub-managed env
// klíče. Uživatelovo vlastní env (i v "env" sekci) zůstane.
func (m *Manager) DisableTelemetry() error {
	if err := m.EnsureBaseDirs(); err != nil {
		return err
	}
	settingsPath := filepath.Join(m.ClaudeHome, "settings.json")
	if err := m.mergeTelemetryEnv(settingsPath, false); err != nil {
		return err
	}
	enabled, apiEndpoint, _ := m.LoadTelemetryConfig()
	_ = enabled // explicitně přepíšeme na false
	return m.saveTelemetryConfig(false, apiEndpoint)
}

// TelemetryEnabled vrátí true, pokud konfigurační sidecar říká enabled.
func (m *Manager) TelemetryEnabled() bool {
	enabled, _, _ := m.LoadTelemetryConfig()
	return enabled
}

// TelemetryAPIEndpoint vrátí poslední známé URL centrálního API pro forwarder.
func (m *Manager) TelemetryAPIEndpoint() string {
	_, endpoint, _ := m.LoadTelemetryConfig()
	return endpoint
}

const telemetryReceiverEndpoint = "http://127.0.0.1:4318"

func telemetryEnvValues() map[string]string {
	return map[string]string{
		"CLAUDE_CODE_ENABLE_TELEMETRY":  "1",
		"OTEL_METRICS_EXPORTER":         "otlp",
		"OTEL_LOGS_EXPORTER":            "otlp",
		"OTEL_EXPORTER_OTLP_PROTOCOL":   "http/json",
		"OTEL_EXPORTER_OTLP_ENDPOINT":   telemetryReceiverEndpoint,
		"OTEL_METRIC_EXPORT_INTERVAL":   "30000",
		"OTEL_LOGS_EXPORT_INTERVAL":     "10000",
	}
}

func (m *Manager) mergeTelemetryEnv(settingsPath string, enable bool) error {
	doc, err := readSettingsDoc(settingsPath)
	if err != nil {
		return err
	}

	env := map[string]string{}
	if existing, ok := doc.Sections["env"]; ok && len(existing) > 0 {
		if err := json.Unmarshal(existing, &env); err != nil {
			// "env" sekce může být něco jiného než plochá mapa string→string —
			// v tom případě raději neměníme nic a vrátíme chybu.
			return errors.New("settings.json env sekce není mapa string→string; zasáhněte ručně")
		}
	}

	if enable {
		for key, value := range telemetryEnvValues() {
			env[key] = value
		}
	} else {
		for _, key := range telemetryEnvKeys {
			delete(env, key)
		}
	}

	if len(env) == 0 {
		delete(doc.Sections, "env")
	} else {
		encoded, err := marshalEnvSection(env)
		if err != nil {
			return err
		}
		doc.Sections["env"] = encoded
	}

	return writeSettingsDoc(settingsPath, doc)
}

// marshalEnvSection serializuje mapu s deterministickým pořadím klíčů, aby
// settings.json měl předvídatelný diff napříč spuštěními.
func marshalEnvSection(env map[string]string) (json.RawMessage, error) {
	keys := make([]string, 0, len(env))
	for key := range env {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var builder strings.Builder
	builder.WriteString("{\n")
	for i, key := range keys {
		value, _ := json.Marshal(env[key])
		builder.WriteString("    ")
		keyBytes, _ := json.Marshal(key)
		builder.Write(keyBytes)
		builder.WriteString(": ")
		builder.Write(value)
		if i < len(keys)-1 {
			builder.WriteString(",")
		}
		builder.WriteString("\n")
	}
	builder.WriteString("  }")
	return json.RawMessage(builder.String()), nil
}
