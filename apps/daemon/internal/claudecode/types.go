package claudecode

type AssetType string

const (
	AssetTypeSkill   AssetType = "skill"
	AssetTypeCommand AssetType = "command"
	AssetTypeMCP     AssetType = "mcp"
	AssetTypeHook    AssetType = "hook"
	AssetTypePlugin  AssetType = "plugin"
	AssetTypeConfig  AssetType = "config"
)

type RiskLevel string

const (
	RiskLow        RiskLevel = "low"
	RiskMedium     RiskLevel = "medium"
	RiskHigh       RiskLevel = "high"
	RiskRestricted RiskLevel = "restricted"
)

type AssetFile struct {
	Path       string `json:"path"`
	Content    string `json:"content"`
	Executable bool   `json:"executable,omitempty"`
}

type CatalogAsset struct {
	ID          string      `json:"id"`
	Type        AssetType   `json:"type"`
	Slug        string      `json:"slug"`
	Name        string      `json:"name"`
	Summary     string      `json:"summary"`
	Version     string      `json:"version"`
	Risk        RiskLevel   `json:"risk"`
	RequiredEnv []string    `json:"requiredEnv"`
	Files       []AssetFile `json:"files"`
}

// InstallOptions určuje cílový scope pro install/uninstall/enable operace.
// Scope je "user" (default) nebo "project". Pro project je nutné zadat ProjectPath
// (absolutní cesta ke kořeni projektu, který obsahuje .claude/ adresář).
type InstallOptions struct {
	Scope       string `json:"scope,omitempty"`
	ProjectPath string `json:"projectPath,omitempty"`
}

// Normalize vrátí copy s výchozím scope "user" pokud není zadaný.
func (o InstallOptions) Normalize() InstallOptions {
	scope := o.Scope
	if scope == "" {
		scope = "user"
	}
	return InstallOptions{Scope: scope, ProjectPath: o.ProjectPath}
}

// InstallScopeState popisuje stav jedné konkrétní instalace položky
// (jedna položka může být nainstalovaná v user-level i v několika projektech současně).
type InstallScopeState struct {
	Scope           string `json:"scope"`
	ProjectPath     string `json:"projectPath,omitempty"`
	ProjectName     string `json:"projectName,omitempty"`
	Installed       bool   `json:"installed"`
	Enabled         bool   `json:"enabled"`
	ManagedByHub    bool   `json:"managedByHub"`
	LocalVersion    string `json:"localVersion,omitempty"`
	LocalChanges    bool   `json:"localChanges"`
	UpdateAvailable bool   `json:"updateAvailable"`
}

type LocalAssetState struct {
	AssetID         string              `json:"assetId"`
	Type            AssetType           `json:"type"`
	Slug            string              `json:"slug"`
	State           string              `json:"state"`
	Installed       bool                `json:"installed"`
	Enabled         bool                `json:"enabled"`
	ManagedByHub    bool                `json:"managedByHub"`
	LocalVersion    string              `json:"localVersion,omitempty"`
	CatalogVersion  string              `json:"catalogVersion,omitempty"`
	LocalChanges    bool                `json:"localChanges"`
	UpdateAvailable bool                `json:"updateAvailable"`
	Warnings        []string            `json:"warnings"`
	// Scopes popisuje stav instalace v každém scope (user + projekty), kde Hub
	// našel manifest nebo lokální položku. Top-level pole jsou agregace
	// (Installed = jakýkoli scope nainstalovaný, Enabled = jakýkoli zapnutý)
	// kvůli zpětné kompatibilitě.
	Scopes []InstallScopeState `json:"scopes,omitempty"`
}

type InstallOperation struct {
	Type        string    `json:"type"`
	Path        string    `json:"path"`
	Description string    `json:"description"`
	Risk        RiskLevel `json:"risk"`
}

type InstallPreview struct {
	AssetID     string             `json:"assetId"`
	Version     string             `json:"version"`
	Operations  []InstallOperation `json:"operations"`
	Warnings    []string           `json:"warnings"`
	RequiredEnv []string           `json:"requiredEnv"`
}

type LocalAsset struct {
	LocalAssetID       string    `json:"localAssetId"`
	Type               AssetType `json:"type"`
	Slug               string    `json:"slug"`
	Name               string    `json:"name"`
	Path               string    `json:"path"`
	Scope              string    `json:"scope"`
	ProjectName        string    `json:"projectName,omitempty"`
	ProjectPath        string    `json:"projectPath,omitempty"`
	ManagedByHub       bool      `json:"managedByHub"`
	Warnings           []string  `json:"warnings"`
	ContentFingerprint string    `json:"contentFingerprint,omitempty"`
}

type LocalAssetExport struct {
	LocalAssetID string      `json:"localAssetId"`
	Type         AssetType   `json:"type"`
	Slug         string      `json:"slug"`
	Name         string      `json:"name"`
	Summary      string      `json:"summary"`
	Description  string      `json:"description"`
	Version      string      `json:"version"`
	Risk         RiskLevel   `json:"risk"`
	Warnings     []string    `json:"warnings"`
	RequiredEnv  []string    `json:"requiredEnv"`
	Files        []AssetFile `json:"files"`
}

type manifest struct {
	AssetID            string    `json:"assetId"`
	Type               AssetType `json:"type"`
	Slug               string    `json:"slug"`
	Name               string    `json:"name"`
	Version            string    `json:"version"`
	Enabled            bool      `json:"enabled"`
	InstalledAt        string    `json:"installedAt"`
	UpdatedAt          string    `json:"updatedAt,omitempty"`
	Fingerprint        string    `json:"fingerprint"`
	ContentFingerprint string    `json:"contentFingerprint"`
	BackupPath         string    `json:"backupPath,omitempty"`
	Scope              string    `json:"scope,omitempty"`
	ProjectPath        string    `json:"projectPath,omitempty"`

	// Snapshot pro merge-style assety (MCP, hook). Umožňuje při disable/uninstall
	// vrátit jen položku, kterou Hub přidal, a zachovat ostatní.
	MCPServerKeys    []string          `json:"mcpServerKeys,omitempty"`
	HookEventEntries map[string][]int  `json:"hookEventEntries,omitempty"` // event → indexy v poli hooků
	PluginEntries    []string          `json:"pluginEntries,omitempty"`     // "scope:projectPath" identifikace
	ContentSnapshots map[string]string `json:"contentSnapshots,omitempty"`  // path → sha256 obsahu, ke kterému patří manifest
}
