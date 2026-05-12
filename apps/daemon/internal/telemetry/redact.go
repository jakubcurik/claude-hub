package telemetry

import "strings"

// metricAllowlist určuje, které metriky se vůbec ukládají. Vše ostatní receiver
// vrací jako 200 a dropne — Claude Code emituje 8 metrik, sledujeme jen 4.
var metricAllowlist = map[string]bool{
	"claude_code.session.count":     true,
	"claude_code.token.usage":       true,
	"claude_code.cost.usage":        true,
	"claude_code.active_time.total": true,
}

// eventAllowlist určuje, které log records (events) ukládáme. Z 21 emitovaných
// Claude Codem ukládáme jen "ekosystem adoption" čtveřici. Body se nikdy neukládá.
var eventAllowlist = map[string]bool{
	"claude_code.skill_activated":   true,
	"claude_code.plugin_loaded":     true,
	"claude_code.plugin_installed":  true,
	"claude_code.at_mention":        true,
}

// sensitiveAttrSubstrings zachytí atributy, které mohou obsahovat uživatelský
// obsah (prompt, kód, surová těla API requestů). Drop je defenzivní — Claude
// Code je už redactuje na úrovni klienta, ale tahle vrstva chrání proti budoucím
// změnám telemetrie a omylem zapnutým env varům jako `OTEL_LOG_USER_PROMPTS=1`.
var sensitiveAttrSubstrings = []string{
	"prompt",
	"body",
	"content",
	"code",
	"text",
	"message",
	"command",
	"file_path",
	"input",
	"output",
	"parameters",
}

func isMetricAllowed(name string) bool {
	return metricAllowlist[name]
}

func isEventAllowed(name string) bool {
	return eventAllowlist[name]
}

// isSensitiveAttr vrátí true, pokud má být klíč při normalizaci zahozen.
// Některé legitimní atributy obsahují citlivá substringy ("event.name",
// "skill.name", "plugin.name") — ty vyjímáme bílou listinou.
func isSensitiveAttr(key string) bool {
	lower := strings.ToLower(key)
	if attrWhitelist[lower] {
		return false
	}
	for _, frag := range sensitiveAttrSubstrings {
		if strings.Contains(lower, frag) {
			return true
		}
	}
	return false
}

// attrWhitelist je whitelist klíčů, které ponecháváme i když by spadly pod
// sensitiveAttrSubstrings (např. "event.name" obsahuje "name", ale "message"
// matches je jiné slovo).
var attrWhitelist = map[string]bool{
	"event.name":        true,
	"event.sequence":    true,
	"prompt_length":     true,
	"command_name":      true,
	"command_source":    true,
	"mentioned_name":    true,
	"mentioned_type":    true,
}

// sanitizeAttrs zkopíruje vstupní mapu bez citlivých klíčů.
func sanitizeAttrs(in map[string]string) map[string]string {
	out := make(map[string]string, len(in))
	for k, v := range in {
		if isSensitiveAttr(k) {
			continue
		}
		out[k] = v
	}
	return out
}
