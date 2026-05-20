package claudecode

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"
)

// PluginRecipeFilePath je očekávaná cesta jediného souboru v CatalogAsset.Files
// pro plugin recipe. Daemon JSON-stringified PluginRecipe naparsuje z tohoto souboru.
const PluginRecipeFilePath = "recipe.json"

// MarketplaceSource popisuje, kde najít marketplace nebo plugin repo.
// Mirror TypeScript discriminated union v packages/schema/src/index.ts.
//
// Pole jsou union — naplněna jsou jen ta, která odpovídají Source typu.
type MarketplaceSource struct {
	Source   string `json:"source"`             // "github" | "url" | "git-subdir" | "npm"
	Repo     string `json:"repo,omitempty"`     // pro source=github (např. "owner/repo")
	URL      string `json:"url,omitempty"`      // pro source=url / git-subdir
	Path     string `json:"path,omitempty"`     // pro source=git-subdir
	Package  string `json:"package,omitempty"`  // pro source=npm
	Version  string `json:"version,omitempty"`  // pro source=npm
	Registry string `json:"registry,omitempty"` // pro source=npm
	Ref      string `json:"ref,omitempty"`      // pro git zdroje (branch nebo tag)
	SHA      string `json:"sha,omitempty"`      // pro git zdroje (commit SHA)
}

// PluginRecipe je payload uložený v asset.Files[0].Content (JSON-stringified).
// Hub daemon ho použije k naklonování marketplace repo a JSON-patch settings.json.
type PluginRecipe struct {
	MarketplaceName   string                 `json:"marketplaceName"`
	MarketplaceSource MarketplaceSource      `json:"marketplaceSource"`
	PluginName        string                 `json:"pluginName"`
	DefaultOptions    map[string]any         `json:"defaultOptions,omitempty"`
	AutoUpdate        *bool                  `json:"autoUpdate,omitempty"`
	SetupCommand      string                 `json:"setupCommand,omitempty"`
}

// AutoUpdateEnabled vrátí true, pokud recipe explicitně nezakázal auto-update.
// Default je true (auto-update zapnut).
func (r *PluginRecipe) AutoUpdateEnabled() bool {
	if r.AutoUpdate == nil {
		return true
	}
	return *r.AutoUpdate
}

// PluginKey vrací identifikátor "pluginName@marketplaceName" používaný v
// enabledPlugins a pluginConfigs sekcích settings.json.
func (r *PluginRecipe) PluginKey() string {
	return r.PluginName + "@" + r.MarketplaceName
}

var (
	// validSlugPattern matchuje kebab-case identifikátory: a-z, 0-9, pomlčky uvnitř.
	// Stejný pattern používá CatalogAsset.Slug v JSON Schema. (Pozor: `slugPattern`
	// v paths.go je opak — matchuje NE-slug znaky pro slugifikaci.)
	validSlugPattern = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)

	// githubRepoPattern matchuje "owner/repo" formát s povolenými znaky.
	githubRepoPattern = regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)

	// npmPackagePattern matchuje npm package name (scoped i unscoped).
	npmPackagePattern = regexp.MustCompile(`^(?:@[a-z0-9][a-z0-9_.-]*/)?[a-z0-9][a-z0-9_.-]*$`)

	// sensitiveKeyPattern matchuje názvy polí, která indikují citlivou hodnotu.
	// Používáme samostatný pattern (secretLikePattern v manager.go je laděný pro
	// scanování OBSAHU souborů, ne pro jména klíčů).
	sensitiveKeyPattern = regexp.MustCompile(`(?i)(token|secret|password|api[_-]?key|client[_-]?secret|refresh[_-]?token|access[_-]?token|private[_-]?key|credential)`)
)

// ExtractPluginRecipe naparsuje recipe payload z CatalogAsset a provede plnou
// validaci. Vrací error, pokud recipe nemá očekávaný tvar nebo obsahuje
// sensitive klíče v defaultOptions (policy: Hub nesdílí credentials).
func ExtractPluginRecipe(asset CatalogAsset) (*PluginRecipe, error) {
	if asset.Type != AssetTypePlugin {
		return nil, fmt.Errorf("asset typu %q nelze parsovat jako plugin recipe", asset.Type)
	}
	if len(asset.Files) != 1 {
		return nil, fmt.Errorf("plugin recipe musí mít právě jeden soubor, nalezeno %d", len(asset.Files))
	}
	if asset.Files[0].Path != PluginRecipeFilePath {
		return nil, fmt.Errorf("plugin recipe soubor musí mít cestu %q, nalezeno %q", PluginRecipeFilePath, asset.Files[0].Path)
	}

	var recipe PluginRecipe
	if err := json.Unmarshal([]byte(asset.Files[0].Content), &recipe); err != nil {
		return nil, fmt.Errorf("recipe.json nelze parsovat: %w", err)
	}

	if err := validateRecipeShape(&recipe); err != nil {
		return nil, err
	}
	return &recipe, nil
}

func validateRecipeShape(recipe *PluginRecipe) error {
	if !validSlugPattern.MatchString(recipe.MarketplaceName) {
		return fmt.Errorf("marketplaceName %q není validní slug (a-z, 0-9, pomlčky)", recipe.MarketplaceName)
	}
	if !validSlugPattern.MatchString(recipe.PluginName) {
		return fmt.Errorf("pluginName %q není validní slug (a-z, 0-9, pomlčky)", recipe.PluginName)
	}
	if err := validateMarketplaceSource(&recipe.MarketplaceSource); err != nil {
		return err
	}
	if err := validateDefaultOptions(recipe.DefaultOptions); err != nil {
		return err
	}
	if recipe.SetupCommand != "" {
		if !strings.HasPrefix(recipe.SetupCommand, "/") {
			return fmt.Errorf("setupCommand %q musí začínat \"/\"", recipe.SetupCommand)
		}
	}
	return nil
}

func validateMarketplaceSource(src *MarketplaceSource) error {
	switch src.Source {
	case "github":
		if !githubRepoPattern.MatchString(src.Repo) {
			return fmt.Errorf("github source vyžaduje repo ve tvaru \"owner/repo\", nalezeno %q", src.Repo)
		}
	case "url":
		if err := validateGitURL(src.URL); err != nil {
			return fmt.Errorf("url source: %w", err)
		}
	case "git-subdir":
		if err := validateGitURL(src.URL); err != nil {
			return fmt.Errorf("git-subdir source: %w", err)
		}
		if _, err := SafeRelativePath(src.Path); err != nil {
			return fmt.Errorf("git-subdir path není bezpečná relativní cesta: %w", err)
		}
	case "npm":
		if !npmPackagePattern.MatchString(src.Package) {
			return fmt.Errorf("npm source vyžaduje validní package name, nalezeno %q", src.Package)
		}
	default:
		return fmt.Errorf("neznámý marketplaceSource.source %q (povoleno: github, url, git-subdir, npm)", src.Source)
	}
	return nil
}

var ipLiteralPattern = regexp.MustCompile(`^(\d{1,3}\.){3}\d{1,3}$|^\[?[0-9a-fA-F:]+\]?$`)

// validateGitURL kontroluje, že URL je https:// nebo ssh:// na bezpečný hostname.
// Zamítá http://, file://, ftp:// a IP-literál hostnames (SSRF mitigation).
func validateGitURL(raw string) error {
	if raw == "" {
		return errors.New("url je prázdná")
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("nelze parsovat url: %w", err)
	}
	if parsed.Scheme != "https" && parsed.Scheme != "ssh" {
		return fmt.Errorf("povoleny pouze https:// a ssh:// schémata, nalezeno %q", parsed.Scheme)
	}
	host := parsed.Hostname()
	if host == "" {
		return errors.New("url nemá hostname")
	}
	if ipLiteralPattern.MatchString(host) {
		return fmt.Errorf("IP-literál hostname %q není povolen (SSRF mitigation)", host)
	}
	lowered := strings.ToLower(host)
	if lowered == "localhost" || strings.HasSuffix(lowered, ".localhost") {
		return fmt.Errorf("localhost hostname %q není povolen", host)
	}
	return nil
}

// validateDefaultOptions ověří, že pole jsou jen skalární (string/number/bool)
// a žádné jméno klíče nematchuje sensitive pattern. Hub nesdílí credentials —
// sensitive userConfig pole se musí získat přes setup wizard pluginu.
func validateDefaultOptions(options map[string]any) error {
	if len(options) == 0 {
		return nil
	}
	for key, value := range options {
		if key == "" {
			return errors.New("defaultOptions má prázdné jméno klíče")
		}
		if sensitiveKeyPattern.MatchString(key) {
			return fmt.Errorf("defaultOptions[%q] vypadá jako citlivá hodnota; sensitive credentials nikdy nesdílejte přes Hub", key)
		}
		switch v := value.(type) {
		case string, bool:
			// ok
		case float64, int, int64:
			// JSON-decoded čísla
			_ = v
		case nil:
			return fmt.Errorf("defaultOptions[%q] je null; vynechte klíč místo null hodnoty", key)
		default:
			return fmt.Errorf("defaultOptions[%q] musí být string, číslo nebo bool, nalezeno %T", key, value)
		}
	}
	return nil
}
