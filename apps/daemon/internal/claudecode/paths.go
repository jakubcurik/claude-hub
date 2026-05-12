package claudecode

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var slugPattern = regexp.MustCompile(`[^a-z0-9]+`)
var slugTransliterator = strings.NewReplacer(
	"á", "a", "č", "c", "ď", "d", "é", "e", "ě", "e", "í", "i", "ň", "n", "ó", "o", "ř", "r", "š", "s", "ť", "t", "ú", "u", "ů", "u", "ý", "y", "ž", "z",
	"Á", "a", "Č", "c", "Ď", "d", "É", "e", "Ě", "e", "Í", "i", "Ň", "n", "Ó", "o", "Ř", "r", "Š", "s", "Ť", "t", "Ú", "u", "Ů", "u", "Ý", "y", "Ž", "z",
)

func ResolveClaudeHome(explicit string) (string, error) {
	if explicit != "" {
		return filepath.Abs(explicit)
	}

	if fromEnv := os.Getenv("CLAUDE_HOME"); fromEnv != "" {
		return filepath.Abs(fromEnv)
	}

	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}

	return filepath.Join(home, ".claude"), nil
}

func HubHome(claudeHome string) string {
	return filepath.Join(claudeHome, ".claude-hub")
}

func Slugify(value string) string {
	slug := strings.ToLower(strings.TrimSpace(slugTransliterator.Replace(value)))
	slug = slugPattern.ReplaceAllString(slug, "-")
	slug = strings.Trim(slug, "-")
	if len(slug) > 72 {
		slug = slug[:72]
	}
	return slug
}

func SafeRelativePath(value string) (string, error) {
	if strings.TrimSpace(value) == "" {
		return "", errors.New("cesta k souboru je povinná")
	}

	cleaned := filepath.Clean(value)
	if filepath.IsAbs(cleaned) || strings.HasPrefix(cleaned, "..") || strings.Contains(cleaned, string(filepath.Separator)+".."+string(filepath.Separator)) {
		return "", errors.New("cesta k souboru není bezpečná: " + value)
	}

	return cleaned, nil
}
