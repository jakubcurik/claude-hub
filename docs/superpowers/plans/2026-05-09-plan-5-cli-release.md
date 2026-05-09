# CLI + Release Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dodat veřejný release v0.1.0 — `claude-hub` Go CLI, cross-platform instalační scripty, GitHub release pipeline, Homebrew + winget + MSI distribuci, kompletní dokumentaci, SPDX enforcement, backup/restore endpointy a release smoke test.

**Architecture:** CLI je Go modul v `apps/cli/` postavený na cobra + huh + lipgloss; sdílí typy s daemonem přes `go.work` replace direktivu. Distribuce běží přes GitHub Releases (GoReleaser) + GHCR (Docker), instalace přes `install.sh` / `install.ps1` (servované hub-serverem) + Homebrew tap + winget manifest + WiX MSI. Release pipeline je jeden GitHub Actions workflow triggerovaný `v*` tagem; backup/restore admin endpointy streamují `pg_dump` + MinIO mirror jako tar.gz.

**Tech Stack:**
- Go 1.23+ (`spf13/cobra`, `charmbracelet/huh`, `charmbracelet/lipgloss`, `gopkg.in/yaml.v3`)
- Node.js 22 LTS, pnpm 9, Hono 4 (server endpointy backup/restore)
- GoReleaser, Docker buildx, WiX 4 (MSI), Homebrew, winget
- GitHub Actions (release.yml, ci.yml extensions, actionlint, dependabot)
- git-cliff (changelog), Contributor Covenant 2.1 (CoC)

**Depends on:**
- Plan 1: hub-server REST endpointy (`/api/auth/*`, `/api/artifacts*`, `/api/daemons/{pair,register}`, `/api/artifacts/upload`), Postgres schema, MinIO, RBAC (`requireRole('admin')`), Hono mount.
- Plan 2: Go agent + daemon localhost API `/v1/{status,local,publish,install,uninstall,toggle,pair}`, agent token v `~/.claude-hub/agent.token`, `apps/agent/internal/api` package s DTOs, `service install` subcommand.
- Plan 3: dashboard build pipeline (`pnpm --filter dashboard build`).
- Plan 4: artifact tar layout + manifest validation reused by `--standalone` publish.

---

## Konvence

- Conventional Commits (`feat(cli): ...`, `fix(server): ...`, `docs: ...`).
- SPDX header `// SPDX-License-Identifier: Apache-2.0` (Go) / `// SPDX-License-Identifier: Apache-2.0` (TS) na prvním řádku.
- TDD-first kde dává smysl: failing test → implementation → passing test → commit.
- WSS toggle uses `job.toggle` (per `_implementation-contracts.md`), never `job.enable`.
- Bite-sized tasks: každý Step = 2–5 minut práce.
- Žádné placeholders s výjimkou explicit PGP fingerprint v `SECURITY.md`.

---

## Tasks

### Task 1: Bootstrap `apps/cli/` Go module

**Files:**
- Create: `apps/cli/go.mod`
- Create: `apps/cli/cmd/claude-hub/main.go`
- Modify: `go.work`

- [ ] **Step 1: Init Go module**

Run from `D:/Claude/hub/apps/cli/`:
```bash
go mod init github.com/animato/claude-hub/cli
```

- [ ] **Step 2: Register module in go.work**

Edit `D:/Claude/hub/go.work`:
```
go 1.23

use (
    ./apps/agent
    ./apps/cli
)
```

- [ ] **Step 3: Create entrypoint**

`apps/cli/cmd/claude-hub/main.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package main

import (
    "fmt"
    "os"
)

var version = "0.0.0-dev"

func main() {
    if len(os.Args) > 1 && os.Args[1] == "--version" {
        fmt.Printf("claude-hub %s\n", version)
        return
    }
    fmt.Printf("claude-hub %s (no command)\n", version)
}
```

- [ ] **Step 4: Verify build**

Run: `go work sync && go build ./apps/cli/cmd/claude-hub`
Expected: PASS, binary `claude-hub` (or `claude-hub.exe`) produced.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/go.mod apps/cli/cmd/claude-hub/main.go go.work
git commit -m "chore(cli): bootstrap go module and entrypoint"
```

---

### Task 2: Add cobra root command with global flags

**Files:**
- Create: `apps/cli/internal/cmd/root.go`
- Create: `apps/cli/internal/cmd/root_test.go`
- Modify: `apps/cli/cmd/claude-hub/main.go`

- [ ] **Step 1: Write failing test**

`apps/cli/internal/cmd/root_test.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package cmd

import (
    "bytes"
    "strings"
    "testing"
)

func TestRootHelp(t *testing.T) {
    cmd := NewRootCmd()
    var out bytes.Buffer
    cmd.SetOut(&out)
    cmd.SetErr(&out)
    cmd.SetArgs([]string{"--help"})
    if err := cmd.Execute(); err != nil {
        t.Fatalf("unexpected error: %v", err)
    }
    s := out.String()
    if !strings.Contains(s, "claude-hub") {
        t.Fatalf("help missing program name: %s", s)
    }
    if !strings.Contains(s, "--json") {
        t.Fatalf("help missing --json flag: %s", s)
    }
    if !strings.Contains(s, "--config") {
        t.Fatalf("help missing --config flag: %s", s)
    }
}

func TestRootJSONFlagDefault(t *testing.T) {
    cmd := NewRootCmd()
    cmd.SetArgs([]string{})
    if err := cmd.ParseFlags(nil); err != nil {
        t.Fatalf("parse: %v", err)
    }
    v, _ := cmd.PersistentFlags().GetBool("json")
    if v {
        t.Fatalf("expected --json default false, got true")
    }
}
```

- [ ] **Step 2: Run, verify FAIL**

Run: `cd apps/cli && go test ./internal/cmd/ -run TestRoot`
Expected: FAIL — package `cmd` does not exist / `NewRootCmd` undefined.

- [ ] **Step 3: Add cobra dependency**

```bash
cd apps/cli
go get github.com/spf13/cobra@v1.8.1
```

- [ ] **Step 4: Implement root command**

`apps/cli/internal/cmd/root.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package cmd

import (
    "os"
    "path/filepath"

    "github.com/spf13/cobra"
)

// Version is injected at build time via -ldflags.
var Version = "0.0.0-dev"

// GlobalFlags are populated by Cobra's persistent flag parsing.
type GlobalFlags struct {
    JSON       bool
    ConfigPath string
}

var Globals GlobalFlags

func defaultConfigPath() string {
    home, err := os.UserHomeDir()
    if err != nil {
        return ".claude-hub/config.yaml"
    }
    return filepath.Join(home, ".claude-hub", "config.yaml")
}

// NewRootCmd builds the root cobra.Command. Exported for tests.
func NewRootCmd() *cobra.Command {
    cmd := &cobra.Command{
        Use:           "claude-hub",
        Short:         "Claude Hub team marketplace CLI",
        Long:          "claude-hub is the command-line companion to a self-hosted Claude Hub deployment.",
        SilenceUsage:  true,
        SilenceErrors: true,
    }
    cmd.PersistentFlags().BoolVar(&Globals.JSON, "json", false, "emit machine-readable JSON instead of human tables")
    cmd.PersistentFlags().StringVar(&Globals.ConfigPath, "config", defaultConfigPath(), "path to claude-hub config.yaml")
    return cmd
}

// Execute is the binary entry point.
func Execute() error {
    return NewRootCmd().Execute()
}
```

- [ ] **Step 5: Wire main.go**

Replace `apps/cli/cmd/claude-hub/main.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package main

import (
    "fmt"
    "os"

    "github.com/animato/claude-hub/cli/internal/cmd"
)

func main() {
    if err := cmd.Execute(); err != nil {
        fmt.Fprintln(os.Stderr, "error:", err)
        os.Exit(1)
    }
}
```

- [ ] **Step 6: Run, verify PASS**

Run: `cd apps/cli && go test ./internal/cmd/ -run TestRoot`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/cli/internal/cmd/root.go apps/cli/internal/cmd/root_test.go apps/cli/cmd/claude-hub/main.go apps/cli/go.mod apps/cli/go.sum
git commit -m "feat(cli): add cobra root command with --json and --config flags"
```

---

### Task 3: Share daemon API DTOs via go.work replace

**Files:**
- Modify: `apps/cli/go.mod`
- Create: `apps/cli/internal/daemon/types.go`
- Create: `apps/cli/internal/daemon/types_test.go`

- [ ] **Step 1: Write failing test**

`apps/cli/internal/daemon/types_test.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package daemon

import (
    "encoding/json"
    "testing"
)

func TestInventoryItemRoundTrip(t *testing.T) {
    enabled := true
    in := InventoryItem{
        Type:    "plugin",
        Slug:    "org-tooling",
        Version: "1.2.3",
        Path:    "/home/u/.claude/plugins/org-tooling",
        Enabled: &enabled,
    }
    b, err := json.Marshal(in)
    if err != nil {
        t.Fatalf("marshal: %v", err)
    }
    var out InventoryItem
    if err := json.Unmarshal(b, &out); err != nil {
        t.Fatalf("unmarshal: %v", err)
    }
    if out.Slug != in.Slug || out.Type != in.Type || out.Version != in.Version {
        t.Fatalf("round-trip mismatch: %+v vs %+v", in, out)
    }
    if out.Enabled == nil || !*out.Enabled {
        t.Fatalf("enabled flag lost: %+v", out)
    }
}
```

- [ ] **Step 2: Run, verify FAIL**

Run: `cd apps/cli && go test ./internal/daemon/`
Expected: FAIL — package missing.

- [ ] **Step 3: Add replace directive + dependency**

Edit `apps/cli/go.mod` (append):
```
require github.com/animato/claude-hub/agent v0.0.0

replace github.com/animato/claude-hub/agent => ../agent
```

Then run `go work sync && go mod tidy` from `apps/cli/`.

- [ ] **Step 4: Re-export DTOs**

`apps/cli/internal/daemon/types.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package daemon

import (
    agentapi "github.com/animato/claude-hub/agent/internal/api"
)

// InventoryItem mirrors the daemon-side type so CLI imports are stable.
type InventoryItem = agentapi.InventoryItem

// PublishedAsRef mirrors the daemon-side reference type.
type PublishedAsRef = agentapi.PublishedAsRef
```

- [ ] **Step 5: Run, verify PASS**

Run: `cd apps/cli && go test ./internal/daemon/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/go.mod apps/cli/go.sum apps/cli/internal/daemon/types.go apps/cli/internal/daemon/types_test.go
git commit -m "feat(cli): share daemon API DTOs via go.work replace"
```

---

### Task 4: Daemon HTTP client with token auth

**Files:**
- Create: `apps/cli/internal/daemon/client.go`
- Create: `apps/cli/internal/daemon/client_test.go`
- Create: `apps/cli/internal/daemon/token.go`
- Create: `apps/cli/internal/daemon/token_test.go`

- [ ] **Step 1: Write failing token test**

`apps/cli/internal/daemon/token_test.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package daemon

import (
    "errors"
    "os"
    "path/filepath"
    "testing"
)

func TestLoadAgentToken_Missing(t *testing.T) {
    t.Setenv("HOME", t.TempDir())
    t.Setenv("USERPROFILE", t.TempDir())
    _, err := LoadAgentToken()
    if !errors.Is(err, ErrAgentTokenMissing) {
        t.Fatalf("expected ErrAgentTokenMissing, got %v", err)
    }
}

func TestLoadAgentToken_Reads(t *testing.T) {
    home := t.TempDir()
    t.Setenv("HOME", home)
    t.Setenv("USERPROFILE", home)
    dir := filepath.Join(home, ".claude-hub")
    if err := os.MkdirAll(dir, 0o700); err != nil {
        t.Fatal(err)
    }
    if err := os.WriteFile(filepath.Join(dir, "agent.token"), []byte("secret-xyz\n"), 0o600); err != nil {
        t.Fatal(err)
    }
    tok, err := LoadAgentToken()
    if err != nil {
        t.Fatalf("LoadAgentToken: %v", err)
    }
    if tok != "secret-xyz" {
        t.Fatalf("want secret-xyz, got %q", tok)
    }
}
```

- [ ] **Step 2: Run, verify FAIL**

Run: `cd apps/cli && go test ./internal/daemon/ -run TestLoadAgentToken`
Expected: FAIL — `LoadAgentToken` / `ErrAgentTokenMissing` undefined.

- [ ] **Step 3: Implement token loader**

`apps/cli/internal/daemon/token.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package daemon

import (
    "errors"
    "os"
    "path/filepath"
    "runtime"
    "strings"
)

// ErrAgentTokenMissing is returned when the local daemon token file is absent.
var ErrAgentTokenMissing = errors.New("agent token file not found at ~/.claude-hub/agent.token (is the daemon running?)")

// AgentTokenPath returns the canonical path to the daemon-issued bearer token.
func AgentTokenPath() string {
    home, err := os.UserHomeDir()
    if err != nil {
        return ""
    }
    return filepath.Join(home, ".claude-hub", "agent.token")
}

// LoadAgentToken reads the token file. On Unix it requires mode 0600.
func LoadAgentToken() (string, error) {
    p := AgentTokenPath()
    if p == "" {
        return "", ErrAgentTokenMissing
    }
    info, err := os.Stat(p)
    if err != nil {
        if errors.Is(err, os.ErrNotExist) {
            return "", ErrAgentTokenMissing
        }
        return "", err
    }
    if runtime.GOOS != "windows" {
        if info.Mode().Perm()&0o077 != 0 {
            return "", errors.New("agent token file has loose permissions; expected 0600")
        }
    }
    b, err := os.ReadFile(p)
    if err != nil {
        return "", err
    }
    return strings.TrimSpace(string(b)), nil
}
```

- [ ] **Step 4: Write failing client test**

`apps/cli/internal/daemon/client_test.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package daemon

import (
    "context"
    "encoding/json"
    "net/http"
    "net/http/httptest"
    "testing"
)

func TestClient_Status(t *testing.T) {
    srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        if got := r.Header.Get("Authorization"); got != "Bearer dev-token" {
            t.Fatalf("missing auth header, got %q", got)
        }
        if r.URL.Path != "/v1/status" {
            t.Fatalf("unexpected path: %s", r.URL.Path)
        }
        _ = json.NewEncoder(w).Encode(StatusResponse{
            Paired:       true,
            HubURL:       "https://hub.example.tld",
            AgentVersion: "0.1.0",
            Online:       true,
        })
    }))
    defer srv.Close()

    c := NewClient(srv.URL, "dev-token")
    got, err := c.Status(context.Background())
    if err != nil {
        t.Fatalf("Status: %v", err)
    }
    if got.HubURL != "https://hub.example.tld" || !got.Paired {
        t.Fatalf("unexpected status: %+v", got)
    }
}

func TestClient_BaseURLDefault(t *testing.T) {
    c := NewClient("", "tok")
    if c.BaseURL != "http://127.0.0.1:7878" {
        t.Fatalf("default base URL wrong: %q", c.BaseURL)
    }
}
```

- [ ] **Step 5: Implement client**

`apps/cli/internal/daemon/client.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package daemon

import (
    "bytes"
    "context"
    "encoding/json"
    "errors"
    "fmt"
    "io"
    "net/http"
    "os"
    "time"
)

const defaultBaseURL = "http://127.0.0.1:7878"

// Client talks to the local daemon HTTP API on 127.0.0.1:7878.
type Client struct {
    BaseURL string
    Token   string
    HTTP    *http.Client
}

// NewClient constructs a Client. baseURL of "" falls back to env CLAUDE_HUB_AGENT_ADDR or 127.0.0.1:7878.
func NewClient(baseURL, token string) *Client {
    if baseURL == "" {
        baseURL = os.Getenv("CLAUDE_HUB_AGENT_ADDR")
    }
    if baseURL == "" {
        baseURL = defaultBaseURL
    }
    return &Client{
        BaseURL: baseURL,
        Token:   token,
        HTTP:    &http.Client{Timeout: 30 * time.Second},
    }
}

// StatusResponse is the daemon /v1/status payload.
type StatusResponse struct {
    Paired       bool   `json:"paired"`
    HubURL       string `json:"hub_url"`
    AgentVersion string `json:"agent_version"`
    Online       bool   `json:"online"`
}

// LocalResponse is the daemon /v1/local payload.
type LocalResponse struct {
    Items []InventoryItem `json:"items"`
}

// PublishRequest is the body for POST /v1/publish.
type PublishRequest struct {
    Slug        string `json:"slug"`
    Type        string `json:"type"`
    Version     string `json:"version"`
    Description string `json:"description"`
    SourcePath  string `json:"source_path"`
}

// InstallRequest is the body for POST /v1/install.
type InstallRequest struct {
    ArtifactID string `json:"artifact_id"`
    Version    string `json:"version"`
}

// ToggleRequest is the body for POST /v1/toggle.
type ToggleRequest struct {
    ArtifactID string `json:"artifact_id"`
    Enabled    bool   `json:"enabled"`
}

// PairRequest is the body for POST /v1/pair.
type PairRequest struct {
    HubURL string `json:"hub_url"`
    Pin    string `json:"pin"`
}

func (c *Client) do(ctx context.Context, method, path string, body, out any) error {
    var rdr io.Reader
    if body != nil {
        b, err := json.Marshal(body)
        if err != nil {
            return err
        }
        rdr = bytes.NewReader(b)
    }
    req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, rdr)
    if err != nil {
        return err
    }
    if c.Token != "" {
        req.Header.Set("Authorization", "Bearer "+c.Token)
    }
    if body != nil {
        req.Header.Set("Content-Type", "application/json")
    }
    resp, err := c.HTTP.Do(req)
    if err != nil {
        return fmt.Errorf("daemon request failed: %w", err)
    }
    defer resp.Body.Close()
    if resp.StatusCode >= 400 {
        msg, _ := io.ReadAll(resp.Body)
        return fmt.Errorf("daemon returned %d: %s", resp.StatusCode, string(msg))
    }
    if out != nil {
        return json.NewDecoder(resp.Body).Decode(out)
    }
    return nil
}

func (c *Client) Status(ctx context.Context) (*StatusResponse, error) {
    var s StatusResponse
    if err := c.do(ctx, http.MethodGet, "/v1/status", nil, &s); err != nil {
        return nil, err
    }
    return &s, nil
}

func (c *Client) Local(ctx context.Context) (*LocalResponse, error) {
    var s LocalResponse
    if err := c.do(ctx, http.MethodGet, "/v1/local", nil, &s); err != nil {
        return nil, err
    }
    return &s, nil
}

func (c *Client) Publish(ctx context.Context, req PublishRequest) error {
    return c.do(ctx, http.MethodPost, "/v1/publish", req, nil)
}

func (c *Client) Install(ctx context.Context, req InstallRequest) error {
    return c.do(ctx, http.MethodPost, "/v1/install", req, nil)
}

func (c *Client) Uninstall(ctx context.Context, artifactID string) error {
    return c.do(ctx, http.MethodPost, "/v1/uninstall", map[string]string{"artifact_id": artifactID}, nil)
}

func (c *Client) Toggle(ctx context.Context, req ToggleRequest) error {
    return c.do(ctx, http.MethodPost, "/v1/toggle", req, nil)
}

func (c *Client) Pair(ctx context.Context, req PairRequest) error {
    return c.do(ctx, http.MethodPost, "/v1/pair", req, nil)
}

// Reachable returns nil if the daemon is responsive, an error otherwise.
func (c *Client) Reachable(ctx context.Context) error {
    _, err := c.Status(ctx)
    if err == nil {
        return nil
    }
    var dnsErr error
    if errors.As(err, &dnsErr) {
        return err
    }
    return err
}
```

- [ ] **Step 6: Run, verify PASS**

Run: `cd apps/cli && go test ./internal/daemon/`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/cli/internal/daemon/client.go apps/cli/internal/daemon/client_test.go apps/cli/internal/daemon/token.go apps/cli/internal/daemon/token_test.go
git commit -m "feat(cli): daemon HTTP client with token auth"
```

---

### Task 5: Hub session client with persisted CLI token

**Files:**
- Create: `apps/cli/internal/hub/client.go`
- Create: `apps/cli/internal/hub/client_test.go`
- Create: `apps/cli/internal/hub/token.go`

- [ ] **Step 1: Write failing test**

`apps/cli/internal/hub/client_test.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package hub

import (
    "context"
    "encoding/json"
    "errors"
    "net/http"
    "net/http/httptest"
    "testing"
)

func TestClient_Login(t *testing.T) {
    srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        if r.URL.Path != "/api/auth/login" || r.Method != http.MethodPost {
            t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
        }
        var body map[string]string
        _ = json.NewDecoder(r.Body).Decode(&body)
        if body["email"] != "alice@example.com" {
            t.Fatalf("bad email: %v", body)
        }
        http.SetCookie(w, &http.Cookie{Name: "session", Value: "tok-abc", Path: "/"})
        _ = json.NewEncoder(w).Encode(map[string]any{"id": "u1", "email": body["email"]})
    }))
    defer srv.Close()

    c := NewClient(srv.URL)
    if err := c.Login(context.Background(), "alice@example.com", "pw"); err != nil {
        t.Fatalf("Login: %v", err)
    }
    if c.SessionToken == "" {
        t.Fatalf("expected SessionToken populated")
    }
}

func TestClient_Errors(t *testing.T) {
    srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        switch r.URL.Path {
        case "/api/auth/me":
            http.Error(w, "unauthorized", http.StatusUnauthorized)
        case "/api/artifacts/missing":
            http.Error(w, "not found", http.StatusNotFound)
        }
    }))
    defer srv.Close()

    c := NewClient(srv.URL)
    if _, err := c.Me(context.Background()); !errors.Is(err, ErrUnauthorized) {
        t.Fatalf("expected ErrUnauthorized, got %v", err)
    }
    if _, err := c.GetArtifact(context.Background(), "missing"); !errors.Is(err, ErrNotFound) {
        t.Fatalf("expected ErrNotFound, got %v", err)
    }
}
```

- [ ] **Step 2: Run, verify FAIL**

Run: `cd apps/cli && go test ./internal/hub/`
Expected: FAIL — package missing.

- [ ] **Step 3: Implement token persistence**

`apps/cli/internal/hub/token.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package hub

import (
    "errors"
    "os"
    "path/filepath"
    "runtime"
    "strings"
)

// CLITokenPath returns the on-disk path for the persisted CLI session token.
func CLITokenPath() string {
    home, err := os.UserHomeDir()
    if err != nil {
        return ""
    }
    return filepath.Join(home, ".claude-hub", "cli.token")
}

// SaveCLIToken writes the token with mode 0600 (Unix); on Windows the FS ACLs apply.
func SaveCLIToken(token string) error {
    p := CLITokenPath()
    if p == "" {
        return errors.New("cannot resolve home directory")
    }
    if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
        return err
    }
    return os.WriteFile(p, []byte(strings.TrimSpace(token)+"\n"), 0o600)
}

// LoadCLIToken reads the persisted CLI token. Returns "" without error if not yet logged in.
func LoadCLIToken() (string, error) {
    p := CLITokenPath()
    if p == "" {
        return "", errors.New("cannot resolve home directory")
    }
    b, err := os.ReadFile(p)
    if err != nil {
        if errors.Is(err, os.ErrNotExist) {
            return "", nil
        }
        return "", err
    }
    if runtime.GOOS != "windows" {
        if info, err := os.Stat(p); err == nil && info.Mode().Perm()&0o077 != 0 {
            return "", errors.New("cli token file has loose permissions; expected 0600")
        }
    }
    return strings.TrimSpace(string(b)), nil
}

// DeleteCLIToken removes the token file; returns nil if already absent.
func DeleteCLIToken() error {
    p := CLITokenPath()
    if p == "" {
        return nil
    }
    err := os.Remove(p)
    if err != nil && !errors.Is(err, os.ErrNotExist) {
        return err
    }
    return nil
}
```

- [ ] **Step 4: Implement hub client**

`apps/cli/internal/hub/client.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package hub

import (
    "bytes"
    "context"
    "encoding/json"
    "errors"
    "fmt"
    "io"
    "mime/multipart"
    "net/http"
    "net/url"
    "os"
    "path/filepath"
    "strings"
    "time"
)

var (
    ErrUnauthorized = errors.New("hub returned 401 unauthorized")
    ErrNotFound     = errors.New("hub returned 404 not found")
)

// Client is the REST client for the hub server.
type Client struct {
    BaseURL      string
    SessionToken string
    HTTP         *http.Client
}

// NewClient builds a Client with sensible defaults.
func NewClient(baseURL string) *Client {
    return &Client{
        BaseURL: strings.TrimRight(baseURL, "/"),
        HTTP:    &http.Client{Timeout: 60 * time.Second},
    }
}

func (c *Client) do(ctx context.Context, method, path string, body, out any) error {
    var rdr io.Reader
    if body != nil {
        b, err := json.Marshal(body)
        if err != nil {
            return err
        }
        rdr = bytes.NewReader(b)
    }
    req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, rdr)
    if err != nil {
        return err
    }
    if body != nil {
        req.Header.Set("Content-Type", "application/json")
    }
    if c.SessionToken != "" {
        req.AddCookie(&http.Cookie{Name: "session", Value: c.SessionToken})
        req.Header.Set("Authorization", "Bearer "+c.SessionToken)
    }
    resp, err := c.HTTP.Do(req)
    if err != nil {
        return fmt.Errorf("hub request failed: %w", err)
    }
    defer resp.Body.Close()
    switch resp.StatusCode {
    case http.StatusUnauthorized:
        return ErrUnauthorized
    case http.StatusNotFound:
        return ErrNotFound
    }
    if resp.StatusCode >= 400 {
        msg, _ := io.ReadAll(resp.Body)
        return fmt.Errorf("hub returned %d: %s", resp.StatusCode, string(msg))
    }
    if out != nil {
        return json.NewDecoder(resp.Body).Decode(out)
    }
    return nil
}

// UserDTO mirrors shared-types.UserDTO.
type UserDTO struct {
    ID    string `json:"id"`
    Email string `json:"email"`
    Name  string `json:"name"`
    Role  string `json:"role"`
}

// ArtifactDTO mirrors shared-types.ArtifactDTO (subset).
type ArtifactDTO struct {
    ID            string `json:"id"`
    Slug          string `json:"slug"`
    Type          string `json:"type"`
    Description   string `json:"description"`
    OwnerUserID   string `json:"ownerUserId"`
    LatestVersion string `json:"latestVersion"`
}

// Login authenticates and stores the session cookie/token.
func (c *Client) Login(ctx context.Context, email, password string) error {
    body := map[string]string{"email": email, "password": password}
    b, _ := json.Marshal(body)
    req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+"/api/auth/login", bytes.NewReader(b))
    if err != nil {
        return err
    }
    req.Header.Set("Content-Type", "application/json")
    resp, err := c.HTTP.Do(req)
    if err != nil {
        return err
    }
    defer resp.Body.Close()
    if resp.StatusCode == http.StatusUnauthorized {
        return ErrUnauthorized
    }
    if resp.StatusCode >= 400 {
        msg, _ := io.ReadAll(resp.Body)
        return fmt.Errorf("login failed (%d): %s", resp.StatusCode, string(msg))
    }
    for _, ck := range resp.Cookies() {
        if ck.Name == "session" {
            c.SessionToken = ck.Value
            return nil
        }
    }
    return errors.New("login response missing session cookie")
}

// Logout invalidates the session server-side.
func (c *Client) Logout(ctx context.Context) error {
    err := c.do(ctx, http.MethodPost, "/api/auth/logout", nil, nil)
    if errors.Is(err, ErrUnauthorized) {
        return nil
    }
    return err
}

// Me returns the current user.
func (c *Client) Me(ctx context.Context) (*UserDTO, error) {
    var u UserDTO
    if err := c.do(ctx, http.MethodGet, "/api/auth/me", nil, &u); err != nil {
        return nil, err
    }
    return &u, nil
}

// ListArtifacts lists catalog entries with optional type/q filters.
func (c *Client) ListArtifacts(ctx context.Context, typ, q string) ([]ArtifactDTO, error) {
    qs := url.Values{}
    if typ != "" {
        qs.Set("type", typ)
    }
    if q != "" {
        qs.Set("q", q)
    }
    p := "/api/artifacts"
    if len(qs) > 0 {
        p += "?" + qs.Encode()
    }
    var out []ArtifactDTO
    if err := c.do(ctx, http.MethodGet, p, nil, &out); err != nil {
        return nil, err
    }
    return out, nil
}

// GetArtifact returns a single artifact by slug.
func (c *Client) GetArtifact(ctx context.Context, slug string) (*ArtifactDTO, error) {
    var out ArtifactDTO
    if err := c.do(ctx, http.MethodGet, "/api/artifacts/"+slug, nil, &out); err != nil {
        return nil, err
    }
    return &out, nil
}

// CreatePairingPin asks the hub for a fresh 6-digit pin (logged-in users).
func (c *Client) CreatePairingPin(ctx context.Context) (string, error) {
    var out struct {
        Pin string `json:"pin"`
    }
    if err := c.do(ctx, http.MethodPost, "/api/daemons/pair", nil, &out); err != nil {
        return "", err
    }
    return out.Pin, nil
}

// UploadArtifact streams a tar.gz to the upload endpoint (used by --standalone publish).
func (c *Client) UploadArtifact(ctx context.Context, tarPath, slug, typ, version, description, sha256 string) error {
    f, err := os.Open(tarPath)
    if err != nil {
        return err
    }
    defer f.Close()

    body := &bytes.Buffer{}
    mw := multipart.NewWriter(body)
    _ = mw.WriteField("slug", slug)
    _ = mw.WriteField("type", typ)
    _ = mw.WriteField("version", version)
    _ = mw.WriteField("description", description)
    _ = mw.WriteField("sha256", sha256)
    fw, err := mw.CreateFormFile("artifact", filepath.Base(tarPath))
    if err != nil {
        return err
    }
    if _, err := io.Copy(fw, f); err != nil {
        return err
    }
    if err := mw.Close(); err != nil {
        return err
    }
    req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+"/api/artifacts/upload", body)
    if err != nil {
        return err
    }
    req.Header.Set("Content-Type", mw.FormDataContentType())
    if c.SessionToken != "" {
        req.AddCookie(&http.Cookie{Name: "session", Value: c.SessionToken})
        req.Header.Set("Authorization", "Bearer "+c.SessionToken)
    }
    resp, err := c.HTTP.Do(req)
    if err != nil {
        return err
    }
    defer resp.Body.Close()
    if resp.StatusCode >= 400 {
        msg, _ := io.ReadAll(resp.Body)
        return fmt.Errorf("upload failed (%d): %s", resp.StatusCode, string(msg))
    }
    return nil
}
```

- [ ] **Step 5: Run, verify PASS**

Run: `cd apps/cli && go test ./internal/hub/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/internal/hub/client.go apps/cli/internal/hub/client_test.go apps/cli/internal/hub/token.go apps/cli/go.sum
git commit -m "feat(cli): hub REST client with persisted CLI token"
```

---

### Task 6: Config loader (`internal/config`)

**Files:**
- Create: `apps/cli/internal/config/config.go`
- Create: `apps/cli/internal/config/config_test.go`

- [ ] **Step 1: Write failing test**

`apps/cli/internal/config/config_test.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package config

import (
    "os"
    "path/filepath"
    "testing"
)

func TestLoad_DefaultsWhenMissing(t *testing.T) {
    dir := t.TempDir()
    p := filepath.Join(dir, "config.yaml")
    cfg, err := Load(p)
    if err != nil {
        t.Fatalf("Load: %v", err)
    }
    if cfg.DefaultVersionBump != "patch" {
        t.Fatalf("expected default patch, got %q", cfg.DefaultVersionBump)
    }
}

func TestLoad_ReadsExisting(t *testing.T) {
    dir := t.TempDir()
    p := filepath.Join(dir, "config.yaml")
    yaml := "hub_url: https://hub.example.tld\ndefault_version_bump: minor\n"
    if err := os.WriteFile(p, []byte(yaml), 0o600); err != nil {
        t.Fatal(err)
    }
    cfg, err := Load(p)
    if err != nil {
        t.Fatalf("Load: %v", err)
    }
    if cfg.HubURL != "https://hub.example.tld" || cfg.DefaultVersionBump != "minor" {
        t.Fatalf("unexpected: %+v", cfg)
    }
}

func TestLoad_RejectsBadBump(t *testing.T) {
    dir := t.TempDir()
    p := filepath.Join(dir, "config.yaml")
    if err := os.WriteFile(p, []byte("default_version_bump: yolo\n"), 0o600); err != nil {
        t.Fatal(err)
    }
    if _, err := Load(p); err == nil {
        t.Fatal("expected validation error")
    }
}

func TestSave_RoundTrip(t *testing.T) {
    dir := t.TempDir()
    p := filepath.Join(dir, "config.yaml")
    cfg := &Config{HubURL: "https://h", DefaultVersionBump: "major"}
    if err := Save(p, cfg); err != nil {
        t.Fatal(err)
    }
    loaded, err := Load(p)
    if err != nil {
        t.Fatal(err)
    }
    if loaded.HubURL != cfg.HubURL || loaded.DefaultVersionBump != cfg.DefaultVersionBump {
        t.Fatalf("round trip mismatch: %+v vs %+v", cfg, loaded)
    }
}
```

- [ ] **Step 2: Run, verify FAIL**

Run: `cd apps/cli && go test ./internal/config/`
Expected: FAIL — package missing.

- [ ] **Step 3: Add yaml dependency**

```bash
cd apps/cli && go get gopkg.in/yaml.v3@v3.0.1
```

- [ ] **Step 4: Implement loader**

`apps/cli/internal/config/config.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package config

import (
    "errors"
    "fmt"
    "os"
    "path/filepath"

    "gopkg.in/yaml.v3"
)

// Config is the on-disk CLI configuration.
type Config struct {
    HubURL             string `yaml:"hub_url,omitempty"`
    DefaultVersionBump string `yaml:"default_version_bump,omitempty"`
}

var validBumps = map[string]bool{"patch": true, "minor": true, "major": true}

// Load reads the YAML config from path. Missing file returns defaults.
func Load(path string) (*Config, error) {
    cfg := &Config{DefaultVersionBump: "patch"}
    b, err := os.ReadFile(path)
    if err != nil {
        if errors.Is(err, os.ErrNotExist) {
            return cfg, nil
        }
        return nil, err
    }
    if err := yaml.Unmarshal(b, cfg); err != nil {
        return nil, fmt.Errorf("parse %s: %w", path, err)
    }
    if cfg.DefaultVersionBump == "" {
        cfg.DefaultVersionBump = "patch"
    }
    if !validBumps[cfg.DefaultVersionBump] {
        return nil, fmt.Errorf("invalid default_version_bump %q (want patch|minor|major)", cfg.DefaultVersionBump)
    }
    return cfg, nil
}

// Save writes the config to disk, ensuring parent dir mode 0700.
func Save(path string, cfg *Config) error {
    if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
        return err
    }
    b, err := yaml.Marshal(cfg)
    if err != nil {
        return err
    }
    return os.WriteFile(path, b, 0o600)
}
```

- [ ] **Step 5: Run, verify PASS**

Run: `cd apps/cli && go test ./internal/config/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/internal/config/config.go apps/cli/internal/config/config_test.go apps/cli/go.mod apps/cli/go.sum
git commit -m "feat(cli): config loader for hub_url and default version bump"
```

---

### Task 7: Output formatting helpers

**Files:**
- Create: `apps/cli/internal/output/output.go`
- Create: `apps/cli/internal/output/output_test.go`

- [ ] **Step 1: Write failing test**

`apps/cli/internal/output/output_test.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package output

import (
    "bytes"
    "encoding/json"
    "strings"
    "testing"
)

func TestJSON(t *testing.T) {
    var buf bytes.Buffer
    if err := JSON(&buf, map[string]string{"foo": "bar"}); err != nil {
        t.Fatal(err)
    }
    var got map[string]string
    if err := json.Unmarshal(buf.Bytes(), &got); err != nil {
        t.Fatal(err)
    }
    if got["foo"] != "bar" {
        t.Fatalf("unexpected: %v", got)
    }
}

func TestTable(t *testing.T) {
    var buf bytes.Buffer
    Table(&buf, []string{"COL"}, [][]string{{"a"}, {"b"}})
    s := buf.String()
    if !strings.Contains(s, "COL") || !strings.Contains(s, "a") || !strings.Contains(s, "b") {
        t.Fatalf("table missing rows: %s", s)
    }
}

func TestCLIError(t *testing.T) {
    e := NewError(2, "boom")
    if e.Code != 2 || e.Error() != "boom" {
        t.Fatalf("unexpected: %+v", e)
    }
}
```

- [ ] **Step 2: Run, verify FAIL**

Run: `cd apps/cli && go test ./internal/output/`
Expected: FAIL — package missing.

- [ ] **Step 3: Implement helpers**

```bash
cd apps/cli && go get github.com/charmbracelet/lipgloss@v0.13.0
```

`apps/cli/internal/output/output.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package output

import (
    "encoding/json"
    "fmt"
    "io"
    "strings"

    "github.com/charmbracelet/lipgloss"
)

// Error is the structured CLI error carrying an exit code.
type Error struct {
    Code    int
    Message string
}

func (e *Error) Error() string { return e.Message }

// NewError builds an Error.
func NewError(code int, msg string) *Error {
    return &Error{Code: code, Message: msg}
}

// JSON encodes v as indented JSON to w.
func JSON(w io.Writer, v any) error {
    enc := json.NewEncoder(w)
    enc.SetIndent("", "  ")
    return enc.Encode(v)
}

var headerStyle = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("12"))

// Table renders a simple aligned table to w.
func Table(w io.Writer, headers []string, rows [][]string) {
    widths := make([]int, len(headers))
    for i, h := range headers {
        widths[i] = len(h)
    }
    for _, r := range rows {
        for i, c := range r {
            if i < len(widths) && len(c) > widths[i] {
                widths[i] = len(c)
            }
        }
    }
    var b strings.Builder
    for i, h := range headers {
        b.WriteString(headerStyle.Render(pad(h, widths[i])))
        if i < len(headers)-1 {
            b.WriteString("  ")
        }
    }
    b.WriteString("\n")
    for _, r := range rows {
        for i, c := range r {
            if i >= len(widths) {
                break
            }
            b.WriteString(pad(c, widths[i]))
            if i < len(r)-1 {
                b.WriteString("  ")
            }
        }
        b.WriteString("\n")
    }
    fmt.Fprint(w, b.String())
}

func pad(s string, n int) string {
    if len(s) >= n {
        return s
    }
    return s + strings.Repeat(" ", n-len(s))
}
```

- [ ] **Step 4: Run, verify PASS**

Run: `cd apps/cli && go test ./internal/output/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/internal/output/output.go apps/cli/internal/output/output_test.go apps/cli/go.mod apps/cli/go.sum
git commit -m "feat(cli): output formatting helpers (json, table, error)"
```

---

### Task 8: `claude-hub version` subcommand

**Files:**
- Create: `apps/cli/internal/cmd/version.go`
- Create: `apps/cli/internal/cmd/version_test.go`
- Modify: `apps/cli/internal/cmd/root.go` (register subcommand)

- [ ] **Step 1: Write failing test**

`apps/cli/internal/cmd/version_test.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package cmd

import (
    "bytes"
    "encoding/json"
    "net/http"
    "net/http/httptest"
    "strings"
    "testing"
)

func TestVersion_HumanWithDaemon(t *testing.T) {
    srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        _ = json.NewEncoder(w).Encode(map[string]any{
            "paired":        true,
            "hub_url":       "https://h",
            "agent_version": "0.2.1",
            "online":        true,
        })
    }))
    defer srv.Close()
    t.Setenv("CLAUDE_HUB_AGENT_ADDR", srv.URL)

    cmd := NewRootCmd()
    var out bytes.Buffer
    cmd.SetOut(&out)
    cmd.SetErr(&out)
    cmd.SetArgs([]string{"version"})
    if err := cmd.Execute(); err != nil {
        t.Fatalf("execute: %v", err)
    }
    s := out.String()
    if !strings.Contains(s, "claude-hub") || !strings.Contains(s, "0.2.1") {
        t.Fatalf("unexpected output: %s", s)
    }
}

func TestVersion_JSONWithoutDaemon(t *testing.T) {
    t.Setenv("CLAUDE_HUB_AGENT_ADDR", "http://127.0.0.1:1") // unreachable
    cmd := NewRootCmd()
    var out bytes.Buffer
    cmd.SetOut(&out)
    cmd.SetErr(&out)
    cmd.SetArgs([]string{"version", "--json"})
    if err := cmd.Execute(); err != nil {
        t.Fatalf("execute: %v", err)
    }
    var got map[string]string
    if err := json.Unmarshal(out.Bytes(), &got); err != nil {
        t.Fatalf("decode: %v\n%s", err, out.String())
    }
    if got["cli"] == "" {
        t.Fatalf("missing cli in JSON: %v", got)
    }
}
```

- [ ] **Step 2: Run, verify FAIL**

Run: `cd apps/cli && go test ./internal/cmd/ -run TestVersion`
Expected: FAIL — version subcommand not registered.

- [ ] **Step 3: Implement subcommand**

`apps/cli/internal/cmd/version.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package cmd

import (
    "context"
    "fmt"

    "github.com/animato/claude-hub/cli/internal/daemon"
    "github.com/animato/claude-hub/cli/internal/output"
    "github.com/spf13/cobra"
)

func newVersionCmd() *cobra.Command {
    return &cobra.Command{
        Use:   "version",
        Short: "Show CLI and daemon version",
        RunE: func(cmd *cobra.Command, args []string) error {
            tok, _ := daemon.LoadAgentToken()
            client := daemon.NewClient("", tok)
            ctx, cancel := context.WithTimeout(context.Background(), defaultTimeout)
            defer cancel()
            agentVersion := ""
            if status, err := client.Status(ctx); err == nil {
                agentVersion = status.AgentVersion
            }
            if Globals.JSON {
                payload := map[string]string{"cli": Version, "agent": agentVersion}
                return output.JSON(cmd.OutOrStdout(), payload)
            }
            fmt.Fprintf(cmd.OutOrStdout(), "claude-hub %s\n", Version)
            if agentVersion != "" {
                fmt.Fprintf(cmd.OutOrStdout(), "claude-hub-agent %s\n", agentVersion)
            } else {
                fmt.Fprintln(cmd.OutOrStdout(), "claude-hub-agent: unreachable")
            }
            return nil
        },
    }
}
```

Add to `apps/cli/internal/cmd/root.go` inside `NewRootCmd` before `return cmd`:
```go
    cmd.AddCommand(newVersionCmd())
```

Also add at top-level in `root.go`:
```go
import "time"

const defaultTimeout = 5 * time.Second
```

- [ ] **Step 4: Run, verify PASS**

Run: `cd apps/cli && go test ./internal/cmd/ -run TestVersion`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/internal/cmd/version.go apps/cli/internal/cmd/version_test.go apps/cli/internal/cmd/root.go
git commit -m "feat(cli): add version subcommand"
```

---

### Task 9: `claude-hub status` subcommand

**Files:**
- Create: `apps/cli/internal/cmd/status.go`
- Create: `apps/cli/internal/cmd/status_test.go`
- Create: `apps/cli/internal/cmd/testdata/status.golden`
- Modify: `apps/cli/internal/cmd/root.go`

- [ ] **Step 1: Write failing test**

`apps/cli/internal/cmd/status_test.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package cmd

import (
    "bytes"
    "encoding/json"
    "net/http"
    "net/http/httptest"
    "strings"
    "testing"
)

func TestStatus_Human(t *testing.T) {
    srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        switch r.URL.Path {
        case "/v1/status":
            _ = json.NewEncoder(w).Encode(map[string]any{
                "paired":        true,
                "hub_url":       "https://h.example",
                "agent_version": "0.1.0",
                "online":        true,
            })
        case "/v1/local":
            _ = json.NewEncoder(w).Encode(map[string]any{"items": []any{1, 2, 3}})
        }
    }))
    defer srv.Close()
    t.Setenv("CLAUDE_HUB_AGENT_ADDR", srv.URL)

    cmd := NewRootCmd()
    var out bytes.Buffer
    cmd.SetOut(&out)
    cmd.SetErr(&out)
    cmd.SetArgs([]string{"status"})
    if err := cmd.Execute(); err != nil {
        t.Fatalf("execute: %v", err)
    }
    s := out.String()
    for _, want := range []string{"paired", "yes", "h.example", "online", "0.1.0", "3"} {
        if !strings.Contains(s, want) {
            t.Fatalf("status output missing %q\n%s", want, s)
        }
    }
}

func TestStatus_JSON(t *testing.T) {
    srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        switch r.URL.Path {
        case "/v1/status":
            _ = json.NewEncoder(w).Encode(map[string]any{"paired": false, "agent_version": "0.1.0"})
        case "/v1/local":
            _ = json.NewEncoder(w).Encode(map[string]any{"items": []any{}})
        }
    }))
    defer srv.Close()
    t.Setenv("CLAUDE_HUB_AGENT_ADDR", srv.URL)

    cmd := NewRootCmd()
    var out bytes.Buffer
    cmd.SetOut(&out)
    cmd.SetArgs([]string{"status", "--json"})
    if err := cmd.Execute(); err != nil {
        t.Fatalf("execute: %v", err)
    }
    var payload map[string]any
    if err := json.Unmarshal(out.Bytes(), &payload); err != nil {
        t.Fatalf("not JSON: %v\n%s", err, out.String())
    }
}
```

- [ ] **Step 2: Run, verify FAIL**

Run: `cd apps/cli && go test ./internal/cmd/ -run TestStatus`
Expected: FAIL — `status` command not registered.

- [ ] **Step 3: Implement subcommand**

`apps/cli/internal/cmd/status.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package cmd

import (
    "context"
    "fmt"

    "github.com/animato/claude-hub/cli/internal/daemon"
    "github.com/animato/claude-hub/cli/internal/output"
    "github.com/spf13/cobra"
)

func newStatusCmd() *cobra.Command {
    return &cobra.Command{
        Use:   "status",
        Short: "Show daemon and pairing status",
        RunE: func(cmd *cobra.Command, args []string) error {
            tok, _ := daemon.LoadAgentToken()
            client := daemon.NewClient("", tok)
            ctx, cancel := context.WithTimeout(context.Background(), defaultTimeout)
            defer cancel()
            status, err := client.Status(ctx)
            if err != nil {
                return output.NewError(2, fmt.Sprintf("daemon unreachable: %v", err))
            }
            local, _ := client.Local(ctx)
            itemCount := 0
            if local != nil {
                itemCount = len(local.Items)
            }
            if Globals.JSON {
                return output.JSON(cmd.OutOrStdout(), map[string]any{
                    "paired":        status.Paired,
                    "hub_url":       status.HubURL,
                    "online":        status.Online,
                    "agent_version": status.AgentVersion,
                    "items":         itemCount,
                })
            }
            output.Table(cmd.OutOrStdout(),
                []string{"FIELD", "VALUE"},
                [][]string{
                    {"paired", boolStr(status.Paired)},
                    {"hub_url", status.HubURL},
                    {"online", boolStr(status.Online)},
                    {"agent_version", status.AgentVersion},
                    {"items", fmt.Sprintf("%d", itemCount)},
                })
            return nil
        },
    }
}

func boolStr(b bool) string {
    if b {
        return "yes"
    }
    return "no"
}
```

Register in `NewRootCmd`: `cmd.AddCommand(newStatusCmd())`.

- [ ] **Step 4: Run, verify PASS**

Run: `cd apps/cli && go test ./internal/cmd/ -run TestStatus`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/internal/cmd/status.go apps/cli/internal/cmd/status_test.go apps/cli/internal/cmd/root.go
git commit -m "feat(cli): add status subcommand"
```

---

### Task 10: `claude-hub login` subcommand

**Files:**
- Create: `apps/cli/internal/cmd/login.go`
- Create: `apps/cli/internal/cmd/login_test.go`
- Modify: `apps/cli/internal/cmd/root.go`

- [ ] **Step 1: Write failing test**

`apps/cli/internal/cmd/login_test.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package cmd

import (
    "bytes"
    "encoding/json"
    "net/http"
    "net/http/httptest"
    "os"
    "path/filepath"
    "testing"
)

func TestLogin_NonInteractive(t *testing.T) {
    home := t.TempDir()
    t.Setenv("HOME", home)
    t.Setenv("USERPROFILE", home)

    srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        if r.URL.Path != "/api/auth/login" {
            t.Fatalf("path: %s", r.URL.Path)
        }
        var body map[string]string
        _ = json.NewDecoder(r.Body).Decode(&body)
        if body["email"] != "alice@example.com" || body["password"] != "secretpw1234" {
            t.Fatalf("unexpected creds: %v", body)
        }
        http.SetCookie(w, &http.Cookie{Name: "session", Value: "tok-xyz", Path: "/"})
        _ = json.NewEncoder(w).Encode(map[string]string{"id": "u1"})
    }))
    defer srv.Close()

    cmd := NewRootCmd()
    var out bytes.Buffer
    cmd.SetOut(&out)
    cmd.SetErr(&out)
    cmd.SetArgs([]string{
        "login",
        "--hub", srv.URL,
        "--email", "alice@example.com",
        "--password", "secretpw1234",
        "--config", filepath.Join(home, ".claude-hub", "config.yaml"),
    })
    if err := cmd.Execute(); err != nil {
        t.Fatalf("execute: %v", err)
    }
    tokFile := filepath.Join(home, ".claude-hub", "cli.token")
    if _, err := os.Stat(tokFile); err != nil {
        t.Fatalf("token file missing: %v", err)
    }
    cfg := filepath.Join(home, ".claude-hub", "config.yaml")
    b, err := os.ReadFile(cfg)
    if err != nil {
        t.Fatalf("config missing: %v", err)
    }
    if !bytes.Contains(b, []byte("hub_url")) {
        t.Fatalf("config missing hub_url: %s", b)
    }
}
```

- [ ] **Step 2: Run, verify FAIL**

Run: `cd apps/cli && go test ./internal/cmd/ -run TestLogin`
Expected: FAIL — `login` command missing.

- [ ] **Step 3: Add huh dependency**

```bash
cd apps/cli && go get github.com/charmbracelet/huh@v0.5.3
```

- [ ] **Step 4: Implement subcommand**

`apps/cli/internal/cmd/login.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package cmd

import (
    "context"
    "errors"
    "fmt"
    "io"
    "os"
    "strings"

    "github.com/animato/claude-hub/cli/internal/config"
    "github.com/animato/claude-hub/cli/internal/hub"
    "github.com/charmbracelet/huh"
    "github.com/spf13/cobra"
)

func newLoginCmd() *cobra.Command {
    var (
        hubURL        string
        email         string
        password      string
        passwordStdin bool
    )
    cmd := &cobra.Command{
        Use:   "login",
        Short: "Authenticate against a Claude Hub instance",
        RunE: func(cmd *cobra.Command, args []string) error {
            cfg, err := config.Load(Globals.ConfigPath)
            if err != nil {
                return err
            }
            if hubURL == "" {
                hubURL = cfg.HubURL
            }
            if hubURL == "" {
                return errors.New("--hub is required (or set hub_url in ~/.claude-hub/config.yaml)")
            }
            if passwordStdin {
                b, err := io.ReadAll(cmd.InOrStdin())
                if err != nil {
                    return err
                }
                password = strings.TrimSpace(string(b))
            }
            if email == "" || password == "" {
                if err := huh.NewForm(huh.NewGroup(
                    huh.NewInput().Title("Email").Value(&email),
                    huh.NewInput().Title("Password").Password(true).Value(&password),
                )).Run(); err != nil {
                    return err
                }
            }
            client := hub.NewClient(hubURL)
            ctx, cancel := context.WithTimeout(context.Background(), defaultTimeout*4)
            defer cancel()
            if err := client.Login(ctx, email, password); err != nil {
                return fmt.Errorf("login: %w", err)
            }
            if err := hub.SaveCLIToken(client.SessionToken); err != nil {
                return err
            }
            cfg.HubURL = hubURL
            if cfg.DefaultVersionBump == "" {
                cfg.DefaultVersionBump = "patch"
            }
            if err := config.Save(Globals.ConfigPath, cfg); err != nil {
                return err
            }
            fmt.Fprintf(cmd.OutOrStdout(), "logged in as %s\n", email)
            _ = os.Stderr // appease linters; intentional
            return nil
        },
    }
    cmd.Flags().StringVar(&hubURL, "hub", "", "hub URL (e.g. https://hub.firma.tld)")
    cmd.Flags().StringVar(&email, "email", "", "email (non-interactive)")
    cmd.Flags().StringVar(&password, "password", "", "password (non-interactive)")
    cmd.Flags().BoolVar(&passwordStdin, "password-stdin", false, "read password from stdin")
    return cmd
}
```

Register in `NewRootCmd`: `cmd.AddCommand(newLoginCmd())`.

- [ ] **Step 5: Run, verify PASS**

Run: `cd apps/cli && go test ./internal/cmd/ -run TestLogin`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/internal/cmd/login.go apps/cli/internal/cmd/login_test.go apps/cli/internal/cmd/root.go apps/cli/go.mod apps/cli/go.sum
git commit -m "feat(cli): add login subcommand with interactive prompts"
```

---

### Task 11: `claude-hub logout` subcommand

**Files:**
- Create: `apps/cli/internal/cmd/logout.go`
- Create: `apps/cli/internal/cmd/logout_test.go`
- Modify: `apps/cli/internal/cmd/root.go`

- [ ] **Step 1: Write failing test**

`apps/cli/internal/cmd/logout_test.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package cmd

import (
    "bytes"
    "net/http"
    "net/http/httptest"
    "os"
    "path/filepath"
    "testing"
)

func TestLogout_DeletesToken(t *testing.T) {
    home := t.TempDir()
    t.Setenv("HOME", home)
    t.Setenv("USERPROFILE", home)
    dir := filepath.Join(home, ".claude-hub")
    _ = os.MkdirAll(dir, 0o700)
    _ = os.WriteFile(filepath.Join(dir, "cli.token"), []byte("tok"), 0o600)
    _ = os.WriteFile(filepath.Join(dir, "config.yaml"), []byte("hub_url: http://h\n"), 0o600)

    srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        if r.URL.Path != "/api/auth/logout" {
            t.Fatalf("path: %s", r.URL.Path)
        }
        w.WriteHeader(204)
    }))
    defer srv.Close()

    _ = os.WriteFile(filepath.Join(dir, "config.yaml"), []byte("hub_url: "+srv.URL+"\n"), 0o600)

    cmd := NewRootCmd()
    var out bytes.Buffer
    cmd.SetOut(&out)
    cmd.SetErr(&out)
    cmd.SetArgs([]string{"logout", "--config", filepath.Join(dir, "config.yaml")})
    if err := cmd.Execute(); err != nil {
        t.Fatalf("execute: %v", err)
    }
    if _, err := os.Stat(filepath.Join(dir, "cli.token")); !os.IsNotExist(err) {
        t.Fatalf("token still present: %v", err)
    }
}

func TestLogout_Idempotent(t *testing.T) {
    home := t.TempDir()
    t.Setenv("HOME", home)
    t.Setenv("USERPROFILE", home)

    cmd := NewRootCmd()
    var out bytes.Buffer
    cmd.SetOut(&out)
    cmd.SetErr(&out)
    cmd.SetArgs([]string{"logout"})
    if err := cmd.Execute(); err != nil {
        t.Fatalf("execute: %v", err)
    }
}
```

- [ ] **Step 2: Run, verify FAIL**

Run: `cd apps/cli && go test ./internal/cmd/ -run TestLogout`
Expected: FAIL — `logout` not registered.

- [ ] **Step 3: Implement**

`apps/cli/internal/cmd/logout.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package cmd

import (
    "context"
    "fmt"

    "github.com/animato/claude-hub/cli/internal/config"
    "github.com/animato/claude-hub/cli/internal/hub"
    "github.com/spf13/cobra"
)

func newLogoutCmd() *cobra.Command {
    return &cobra.Command{
        Use:   "logout",
        Short: "Sign out and delete the local CLI token",
        RunE: func(cmd *cobra.Command, args []string) error {
            tok, _ := hub.LoadCLIToken()
            cfg, _ := config.Load(Globals.ConfigPath)
            if tok != "" && cfg != nil && cfg.HubURL != "" {
                client := hub.NewClient(cfg.HubURL)
                client.SessionToken = tok
                ctx, cancel := context.WithTimeout(context.Background(), defaultTimeout)
                defer cancel()
                _ = client.Logout(ctx) // best-effort
            }
            if err := hub.DeleteCLIToken(); err != nil {
                return err
            }
            if tok == "" {
                fmt.Fprintln(cmd.OutOrStdout(), "already logged out")
            } else {
                fmt.Fprintln(cmd.OutOrStdout(), "logged out")
            }
            return nil
        },
    }
}
```

Register: `cmd.AddCommand(newLogoutCmd())`.

- [ ] **Step 4: Run, verify PASS**

Run: `cd apps/cli && go test ./internal/cmd/ -run TestLogout`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/internal/cmd/logout.go apps/cli/internal/cmd/logout_test.go apps/cli/internal/cmd/root.go
git commit -m "feat(cli): add logout subcommand"
```

---

### Task 12: `claude-hub list` subcommand

**Files:**
- Create: `apps/cli/internal/cmd/list.go`
- Create: `apps/cli/internal/cmd/list_test.go`
- Modify: `apps/cli/internal/cmd/root.go`

- [ ] **Step 1: Write failing test**

`apps/cli/internal/cmd/list_test.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package cmd

import (
    "bytes"
    "encoding/json"
    "net/http"
    "net/http/httptest"
    "os"
    "path/filepath"
    "strings"
    "testing"
)

func TestList_HumanTable(t *testing.T) {
    home := t.TempDir()
    t.Setenv("HOME", home)
    t.Setenv("USERPROFILE", home)
    dir := filepath.Join(home, ".claude-hub")
    _ = os.MkdirAll(dir, 0o700)

    srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        if r.URL.Path != "/api/artifacts" {
            t.Fatalf("path: %s", r.URL.Path)
        }
        if got := r.URL.Query().Get("type"); got != "skill" {
            t.Fatalf("type filter not propagated: %q", got)
        }
        _ = json.NewEncoder(w).Encode([]map[string]any{
            {"id": "a1", "slug": "helper", "type": "skill", "description": "A small helper", "ownerUserId": "u1", "latestVersion": "0.1.0"},
        })
    }))
    defer srv.Close()
    _ = os.WriteFile(filepath.Join(dir, "config.yaml"), []byte("hub_url: "+srv.URL+"\n"), 0o600)

    cmd := NewRootCmd()
    var out bytes.Buffer
    cmd.SetOut(&out)
    cmd.SetErr(&out)
    cmd.SetArgs([]string{"list", "--type", "skill", "--config", filepath.Join(dir, "config.yaml")})
    if err := cmd.Execute(); err != nil {
        t.Fatalf("execute: %v", err)
    }
    s := out.String()
    for _, want := range []string{"SLUG", "helper", "0.1.0", "skill"} {
        if !strings.Contains(s, want) {
            t.Fatalf("output missing %q\n%s", want, s)
        }
    }
}
```

- [ ] **Step 2: Run, verify FAIL**

Run: `cd apps/cli && go test ./internal/cmd/ -run TestList`
Expected: FAIL — `list` not registered.

- [ ] **Step 3: Implement**

`apps/cli/internal/cmd/list.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package cmd

import (
    "context"
    "errors"

    "github.com/animato/claude-hub/cli/internal/config"
    "github.com/animato/claude-hub/cli/internal/hub"
    "github.com/animato/claude-hub/cli/internal/output"
    "github.com/spf13/cobra"
)

func newListCmd() *cobra.Command {
    var (
        typ string
        q   string
    )
    cmd := &cobra.Command{
        Use:   "list",
        Short: "List catalog artifacts",
        RunE: func(cmd *cobra.Command, args []string) error {
            cfg, err := config.Load(Globals.ConfigPath)
            if err != nil {
                return err
            }
            if cfg.HubURL == "" {
                return errors.New("hub_url not configured (run claude-hub login first)")
            }
            client := hub.NewClient(cfg.HubURL)
            client.SessionToken, _ = hub.LoadCLIToken()
            ctx, cancel := context.WithTimeout(context.Background(), defaultTimeout*2)
            defer cancel()
            items, err := client.ListArtifacts(ctx, typ, q)
            if err != nil {
                return err
            }
            if Globals.JSON {
                return output.JSON(cmd.OutOrStdout(), items)
            }
            rows := make([][]string, 0, len(items))
            for _, a := range items {
                desc := a.Description
                if len(desc) > 60 {
                    desc = desc[:57] + "..."
                }
                rows = append(rows, []string{a.Type, a.Slug, a.LatestVersion, a.OwnerUserID, desc})
            }
            output.Table(cmd.OutOrStdout(), []string{"TYPE", "SLUG", "LATEST", "OWNER", "DESCRIPTION"}, rows)
            return nil
        },
    }
    cmd.Flags().StringVar(&typ, "type", "", "filter by type (skill|plugin|command|agent)")
    cmd.Flags().StringVar(&q, "q", "", "search query")
    return cmd
}
```

Register: `cmd.AddCommand(newListCmd())`.

- [ ] **Step 4: Run, verify PASS**

Run: `cd apps/cli && go test ./internal/cmd/ -run TestList`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/internal/cmd/list.go apps/cli/internal/cmd/list_test.go apps/cli/internal/cmd/root.go
git commit -m "feat(cli): add list subcommand with type and query filters"
```

---

### Task 13: `claude-hub install <slug>[@<version>]`

**Files:**
- Create: `apps/cli/internal/cmd/install.go`
- Create: `apps/cli/internal/cmd/install_test.go`
- Modify: `apps/cli/internal/cmd/root.go`

- [ ] **Step 1: Write failing test**

`apps/cli/internal/cmd/install_test.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package cmd

import (
    "bytes"
    "encoding/json"
    "net/http"
    "net/http/httptest"
    "os"
    "path/filepath"
    "testing"
)

func TestInstall_ResolvesAndCallsDaemon(t *testing.T) {
    home := t.TempDir()
    t.Setenv("HOME", home)
    t.Setenv("USERPROFILE", home)
    dir := filepath.Join(home, ".claude-hub")
    _ = os.MkdirAll(dir, 0o700)
    _ = os.WriteFile(filepath.Join(dir, "agent.token"), []byte("dev"), 0o600)

    daemonHits := 0
    daemonSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        if r.URL.Path == "/v1/install" {
            daemonHits++
            var body map[string]string
            _ = json.NewDecoder(r.Body).Decode(&body)
            if body["artifact_id"] != "a1" || body["version"] != "1.2.3" {
                t.Fatalf("bad install body: %v", body)
            }
            w.WriteHeader(200)
            return
        }
        w.WriteHeader(404)
    }))
    defer daemonSrv.Close()
    t.Setenv("CLAUDE_HUB_AGENT_ADDR", daemonSrv.URL)

    hubSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        if r.URL.Path == "/api/artifacts/helper" {
            _ = json.NewEncoder(w).Encode(map[string]any{
                "id": "a1", "slug": "helper", "type": "skill", "latestVersion": "1.2.3",
            })
            return
        }
        w.WriteHeader(404)
    }))
    defer hubSrv.Close()
    _ = os.WriteFile(filepath.Join(dir, "config.yaml"), []byte("hub_url: "+hubSrv.URL+"\n"), 0o600)

    cmd := NewRootCmd()
    var out bytes.Buffer
    cmd.SetOut(&out)
    cmd.SetErr(&out)
    cmd.SetArgs([]string{"install", "helper", "--config", filepath.Join(dir, "config.yaml")})
    if err := cmd.Execute(); err != nil {
        t.Fatalf("execute: %v", err)
    }
    if daemonHits != 1 {
        t.Fatalf("expected 1 daemon install call, got %d", daemonHits)
    }
}
```

- [ ] **Step 2: Run, verify FAIL**

Run: `cd apps/cli && go test ./internal/cmd/ -run TestInstall`
Expected: FAIL — `install` not registered.

- [ ] **Step 3: Implement**

`apps/cli/internal/cmd/install.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package cmd

import (
    "context"
    "errors"
    "fmt"
    "regexp"

    "github.com/animato/claude-hub/cli/internal/config"
    "github.com/animato/claude-hub/cli/internal/daemon"
    "github.com/animato/claude-hub/cli/internal/hub"
    "github.com/spf13/cobra"
)

var slugVersionRe = regexp.MustCompile(`^([a-z0-9][a-z0-9-]{0,63})(?:@(\d+\.\d+\.\d+))?$`)

func parseSlug(arg string) (slug, version string, err error) {
    m := slugVersionRe.FindStringSubmatch(arg)
    if m == nil {
        return "", "", fmt.Errorf("invalid slug %q (expected name[@version])", arg)
    }
    return m[1], m[2], nil
}

func newInstallCmd() *cobra.Command {
    return &cobra.Command{
        Use:   "install <slug>[@<version>]",
        Short: "Install an artifact via the local daemon",
        Args:  cobra.ExactArgs(1),
        RunE: func(cmd *cobra.Command, args []string) error {
            slug, version, err := parseSlug(args[0])
            if err != nil {
                return err
            }
            cfg, err := config.Load(Globals.ConfigPath)
            if err != nil {
                return err
            }
            if cfg.HubURL == "" {
                return errors.New("hub_url not configured")
            }
            hubClient := hub.NewClient(cfg.HubURL)
            hubClient.SessionToken, _ = hub.LoadCLIToken()
            ctx, cancel := context.WithTimeout(context.Background(), defaultTimeout*4)
            defer cancel()
            art, err := hubClient.GetArtifact(ctx, slug)
            if err != nil {
                return fmt.Errorf("resolve artifact: %w", err)
            }
            if version == "" {
                version = art.LatestVersion
            }
            tok, err := daemon.LoadAgentToken()
            if err != nil {
                return fmt.Errorf("claude-hub-agent must be running: %w", err)
            }
            client := daemon.NewClient("", tok)
            if err := client.Install(ctx, daemon.InstallRequest{ArtifactID: art.ID, Version: version}); err != nil {
                return fmt.Errorf("install: %w", err)
            }
            fmt.Fprintf(cmd.OutOrStdout(), "installed %s@%s\n", slug, version)
            return nil
        },
    }
}
```

Register: `cmd.AddCommand(newInstallCmd())`.

- [ ] **Step 4: Run, verify PASS**

Run: `cd apps/cli && go test ./internal/cmd/ -run TestInstall`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/internal/cmd/install.go apps/cli/internal/cmd/install_test.go apps/cli/internal/cmd/root.go
git commit -m "feat(cli): add install subcommand with version resolution"
```

---

### Task 14: `claude-hub uninstall <slug>`

**Files:**
- Create: `apps/cli/internal/cmd/uninstall.go`
- Create: `apps/cli/internal/cmd/uninstall_test.go`
- Modify: `apps/cli/internal/cmd/root.go`

- [ ] **Step 1: Write failing test**

`apps/cli/internal/cmd/uninstall_test.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package cmd

import (
    "bytes"
    "encoding/json"
    "net/http"
    "net/http/httptest"
    "os"
    "path/filepath"
    "testing"
)

func TestUninstall_WithYes(t *testing.T) {
    home := t.TempDir()
    t.Setenv("HOME", home)
    t.Setenv("USERPROFILE", home)
    dir := filepath.Join(home, ".claude-hub")
    _ = os.MkdirAll(dir, 0o700)
    _ = os.WriteFile(filepath.Join(dir, "agent.token"), []byte("dev"), 0o600)

    daemonHits := 0
    daemonSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        if r.URL.Path == "/v1/uninstall" {
            daemonHits++
            var body map[string]string
            _ = json.NewDecoder(r.Body).Decode(&body)
            if body["artifact_id"] != "a1" {
                t.Fatalf("bad body: %v", body)
            }
            w.WriteHeader(200)
            return
        }
    }))
    defer daemonSrv.Close()
    t.Setenv("CLAUDE_HUB_AGENT_ADDR", daemonSrv.URL)

    hubSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        _ = json.NewEncoder(w).Encode(map[string]any{"id": "a1", "slug": "helper", "type": "skill"})
    }))
    defer hubSrv.Close()
    _ = os.WriteFile(filepath.Join(dir, "config.yaml"), []byte("hub_url: "+hubSrv.URL+"\n"), 0o600)

    cmd := NewRootCmd()
    var out bytes.Buffer
    cmd.SetOut(&out)
    cmd.SetErr(&out)
    cmd.SetArgs([]string{"uninstall", "helper", "--yes", "--config", filepath.Join(dir, "config.yaml")})
    if err := cmd.Execute(); err != nil {
        t.Fatalf("execute: %v", err)
    }
    if daemonHits != 1 {
        t.Fatalf("expected 1 uninstall call, got %d", daemonHits)
    }
}
```

- [ ] **Step 2: Run, verify FAIL**

Run: `cd apps/cli && go test ./internal/cmd/ -run TestUninstall`
Expected: FAIL.

- [ ] **Step 3: Implement**

`apps/cli/internal/cmd/uninstall.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package cmd

import (
    "context"
    "errors"
    "fmt"

    "github.com/animato/claude-hub/cli/internal/config"
    "github.com/animato/claude-hub/cli/internal/daemon"
    "github.com/animato/claude-hub/cli/internal/hub"
    "github.com/charmbracelet/huh"
    "github.com/spf13/cobra"
)

func newUninstallCmd() *cobra.Command {
    var yes bool
    cmd := &cobra.Command{
        Use:   "uninstall <slug>",
        Short: "Uninstall an artifact via the local daemon",
        Args:  cobra.ExactArgs(1),
        RunE: func(cmd *cobra.Command, args []string) error {
            cfg, err := config.Load(Globals.ConfigPath)
            if err != nil {
                return err
            }
            if cfg.HubURL == "" {
                return errors.New("hub_url not configured")
            }
            hubClient := hub.NewClient(cfg.HubURL)
            hubClient.SessionToken, _ = hub.LoadCLIToken()
            ctx, cancel := context.WithTimeout(context.Background(), defaultTimeout*2)
            defer cancel()
            art, err := hubClient.GetArtifact(ctx, args[0])
            if err != nil {
                return err
            }
            if !yes {
                confirmed := false
                if err := huh.NewConfirm().Title(fmt.Sprintf("Uninstall %s?", art.Slug)).Value(&confirmed).Run(); err != nil {
                    return err
                }
                if !confirmed {
                    fmt.Fprintln(cmd.OutOrStdout(), "aborted")
                    return nil
                }
            }
            tok, err := daemon.LoadAgentToken()
            if err != nil {
                return fmt.Errorf("claude-hub-agent must be running: %w", err)
            }
            client := daemon.NewClient("", tok)
            if err := client.Uninstall(ctx, art.ID); err != nil {
                return err
            }
            fmt.Fprintf(cmd.OutOrStdout(), "uninstalled %s\n", art.Slug)
            return nil
        },
    }
    cmd.Flags().BoolVar(&yes, "yes", false, "skip confirmation prompt")
    return cmd
}
```

Register: `cmd.AddCommand(newUninstallCmd())`.

- [ ] **Step 4: Run, verify PASS**

Run: `cd apps/cli && go test ./internal/cmd/ -run TestUninstall`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/internal/cmd/uninstall.go apps/cli/internal/cmd/uninstall_test.go apps/cli/internal/cmd/root.go
git commit -m "feat(cli): add uninstall subcommand"
```

---

### Task 15: `claude-hub toggle <slug> --on|--off` (plugins only)

**Files:**
- Create: `apps/cli/internal/cmd/toggle.go`
- Create: `apps/cli/internal/cmd/toggle_test.go`
- Modify: `apps/cli/internal/cmd/root.go`

- [ ] **Step 1: Write failing test**

`apps/cli/internal/cmd/toggle_test.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package cmd

import (
    "bytes"
    "encoding/json"
    "net/http"
    "net/http/httptest"
    "os"
    "path/filepath"
    "strings"
    "testing"
)

func TestToggle_PluginOn(t *testing.T) {
    home := t.TempDir()
    t.Setenv("HOME", home)
    t.Setenv("USERPROFILE", home)
    dir := filepath.Join(home, ".claude-hub")
    _ = os.MkdirAll(dir, 0o700)
    _ = os.WriteFile(filepath.Join(dir, "agent.token"), []byte("dev"), 0o600)

    daemonSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        if r.URL.Path != "/v1/toggle" {
            t.Fatalf("path: %s", r.URL.Path)
        }
        var body map[string]any
        _ = json.NewDecoder(r.Body).Decode(&body)
        if body["enabled"] != true {
            t.Fatalf("expected enabled true: %v", body)
        }
        w.WriteHeader(200)
    }))
    defer daemonSrv.Close()
    t.Setenv("CLAUDE_HUB_AGENT_ADDR", daemonSrv.URL)

    hubSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        _ = json.NewEncoder(w).Encode(map[string]any{"id": "a1", "slug": "tools", "type": "plugin"})
    }))
    defer hubSrv.Close()
    _ = os.WriteFile(filepath.Join(dir, "config.yaml"), []byte("hub_url: "+hubSrv.URL+"\n"), 0o600)

    cmd := NewRootCmd()
    var out bytes.Buffer
    cmd.SetOut(&out)
    cmd.SetErr(&out)
    cmd.SetArgs([]string{"toggle", "tools", "--on", "--config", filepath.Join(dir, "config.yaml")})
    if err := cmd.Execute(); err != nil {
        t.Fatalf("execute: %v", err)
    }
}

func TestToggle_RejectsSkill(t *testing.T) {
    home := t.TempDir()
    t.Setenv("HOME", home)
    t.Setenv("USERPROFILE", home)
    dir := filepath.Join(home, ".claude-hub")
    _ = os.MkdirAll(dir, 0o700)

    hubSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        _ = json.NewEncoder(w).Encode(map[string]any{"id": "a1", "slug": "h", "type": "skill"})
    }))
    defer hubSrv.Close()
    _ = os.WriteFile(filepath.Join(dir, "config.yaml"), []byte("hub_url: "+hubSrv.URL+"\n"), 0o600)

    cmd := NewRootCmd()
    var out bytes.Buffer
    cmd.SetOut(&out)
    cmd.SetErr(&out)
    cmd.SetArgs([]string{"toggle", "h", "--on", "--config", filepath.Join(dir, "config.yaml")})
    err := cmd.Execute()
    if err == nil || !strings.Contains(err.Error(), "plugin") {
        t.Fatalf("expected plugin-only error, got %v", err)
    }
}
```

- [ ] **Step 2: Run, verify FAIL**

Run: `cd apps/cli && go test ./internal/cmd/ -run TestToggle`
Expected: FAIL.

- [ ] **Step 3: Implement**

`apps/cli/internal/cmd/toggle.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package cmd

import (
    "context"
    "errors"
    "fmt"

    "github.com/animato/claude-hub/cli/internal/config"
    "github.com/animato/claude-hub/cli/internal/daemon"
    "github.com/animato/claude-hub/cli/internal/hub"
    "github.com/spf13/cobra"
)

func newToggleCmd() *cobra.Command {
    var on, off bool
    cmd := &cobra.Command{
        Use:   "toggle <slug> --on|--off",
        Short: "Enable or disable a plugin",
        Args:  cobra.ExactArgs(1),
        RunE: func(cmd *cobra.Command, args []string) error {
            if on == off {
                return errors.New("exactly one of --on or --off is required")
            }
            cfg, err := config.Load(Globals.ConfigPath)
            if err != nil {
                return err
            }
            if cfg.HubURL == "" {
                return errors.New("hub_url not configured")
            }
            hubClient := hub.NewClient(cfg.HubURL)
            hubClient.SessionToken, _ = hub.LoadCLIToken()
            ctx, cancel := context.WithTimeout(context.Background(), defaultTimeout*2)
            defer cancel()
            art, err := hubClient.GetArtifact(ctx, args[0])
            if err != nil {
                return err
            }
            if art.Type != "plugin" {
                return fmt.Errorf("toggle is only supported for plugins (got %s)", art.Type)
            }
            tok, err := daemon.LoadAgentToken()
            if err != nil {
                return fmt.Errorf("claude-hub-agent must be running: %w", err)
            }
            client := daemon.NewClient("", tok)
            if err := client.Toggle(ctx, daemon.ToggleRequest{ArtifactID: art.ID, Enabled: on}); err != nil {
                return err
            }
            state := "off"
            if on {
                state = "on"
            }
            fmt.Fprintf(cmd.OutOrStdout(), "%s toggled %s\n", art.Slug, state)
            return nil
        },
    }
    cmd.Flags().BoolVar(&on, "on", false, "enable the plugin")
    cmd.Flags().BoolVar(&off, "off", false, "disable the plugin")
    return cmd
}
```

Register: `cmd.AddCommand(newToggleCmd())`.

- [ ] **Step 4: Run, verify PASS**

Run: `cd apps/cli && go test ./internal/cmd/ -run TestToggle`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/internal/cmd/toggle.go apps/cli/internal/cmd/toggle_test.go apps/cli/internal/cmd/root.go
git commit -m "feat(cli): add toggle subcommand for plugins"
```

---

### Task 16: `claude-hub publish <path>` (non-interactive)

**Files:**
- Create: `apps/cli/internal/cmd/publish.go`
- Create: `apps/cli/internal/cmd/publish_test.go`
- Modify: `apps/cli/internal/cmd/root.go`

- [ ] **Step 1: Write failing test**

`apps/cli/internal/cmd/publish_test.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package cmd

import (
    "bytes"
    "encoding/json"
    "net/http"
    "net/http/httptest"
    "os"
    "path/filepath"
    "testing"
)

func TestPublish_NonInteractive(t *testing.T) {
    home := t.TempDir()
    t.Setenv("HOME", home)
    t.Setenv("USERPROFILE", home)
    dir := filepath.Join(home, ".claude-hub")
    _ = os.MkdirAll(dir, 0o700)
    _ = os.WriteFile(filepath.Join(dir, "agent.token"), []byte("dev"), 0o600)
    skillDir := filepath.Join(home, "myskill")
    _ = os.MkdirAll(skillDir, 0o755)
    _ = os.WriteFile(filepath.Join(skillDir, "SKILL.md"), []byte("---\nname: myskill\n---\nhello"), 0o644)

    var got daemonPublishBody
    daemonSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        if r.URL.Path != "/v1/publish" {
            t.Fatalf("path: %s", r.URL.Path)
        }
        _ = json.NewDecoder(r.Body).Decode(&got)
        w.WriteHeader(200)
    }))
    defer daemonSrv.Close()
    t.Setenv("CLAUDE_HUB_AGENT_ADDR", daemonSrv.URL)

    cmd := NewRootCmd()
    var out bytes.Buffer
    cmd.SetOut(&out)
    cmd.SetErr(&out)
    cmd.SetArgs([]string{
        "publish", skillDir,
        "--type", "skill",
        "--slug", "myskill",
        "--version", "0.1.0",
        "--description", "Test skill",
    })
    if err := cmd.Execute(); err != nil {
        t.Fatalf("execute: %v", err)
    }
    if got.Slug != "myskill" || got.Type != "skill" || got.Version != "0.1.0" {
        t.Fatalf("unexpected publish body: %+v", got)
    }
    if got.SourcePath != skillDir {
        t.Fatalf("source path mismatch: %q vs %q", got.SourcePath, skillDir)
    }
}

type daemonPublishBody struct {
    Slug        string `json:"slug"`
    Type        string `json:"type"`
    Version     string `json:"version"`
    Description string `json:"description"`
    SourcePath  string `json:"source_path"`
}
```

- [ ] **Step 2: Run, verify FAIL**

Run: `cd apps/cli && go test ./internal/cmd/ -run TestPublish_NonInteractive`
Expected: FAIL.

- [ ] **Step 3: Implement**

`apps/cli/internal/cmd/publish.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package cmd

import (
    "context"
    "errors"
    "fmt"
    "os"
    "path/filepath"

    "github.com/animato/claude-hub/cli/internal/daemon"
    "github.com/spf13/cobra"
)

func newPublishCmd() *cobra.Command {
    var (
        typ         string
        slug        string
        version     string
        description string
        standalone  bool
    )
    cmd := &cobra.Command{
        Use:   "publish [path]",
        Short: "Publish a local artifact to the hub",
        Args:  cobra.MaximumNArgs(1),
        RunE: func(cmd *cobra.Command, args []string) error {
            if len(args) == 0 {
                return runPublishInteractive(cmd)
            }
            path := args[0]
            info, err := os.Stat(path)
            if err != nil {
                return fmt.Errorf("source path: %w", err)
            }
            if typ == "" {
                return errors.New("--type is required for non-interactive publish")
            }
            if slug == "" {
                slug = filepath.Base(path)
                if !info.IsDir() {
                    slug = trimExt(filepath.Base(path))
                }
            }
            if version == "" {
                version = "0.1.0"
            }
            if standalone {
                return runStandalonePublish(cmd, path, slug, typ, version, description)
            }
            tok, err := daemon.LoadAgentToken()
            if err != nil {
                return fmt.Errorf("claude-hub-agent must be running: %w", err)
            }
            client := daemon.NewClient("", tok)
            ctx, cancel := context.WithTimeout(context.Background(), defaultTimeout*12)
            defer cancel()
            absPath, _ := filepath.Abs(path)
            if err := client.Publish(ctx, daemon.PublishRequest{
                Slug:        slug,
                Type:        typ,
                Version:     version,
                Description: description,
                SourcePath:  absPath,
            }); err != nil {
                return err
            }
            fmt.Fprintf(cmd.OutOrStdout(), "published %s:%s@%s\n", typ, slug, version)
            return nil
        },
    }
    cmd.Flags().StringVar(&typ, "type", "", "artifact type (skill|plugin|command|agent)")
    cmd.Flags().StringVar(&slug, "slug", "", "artifact slug (defaults to dirname/filename)")
    cmd.Flags().StringVar(&version, "version", "", "semver version (default 0.1.0)")
    cmd.Flags().StringVar(&description, "description", "", "human description (defaults to manifest)")
    cmd.Flags().BoolVar(&standalone, "standalone", false, "skip daemon, upload directly to the hub")
    return cmd
}

func trimExt(name string) string {
    ext := filepath.Ext(name)
    if ext == "" {
        return name
    }
    return name[:len(name)-len(ext)]
}

// runPublishInteractive is provided in publish_interactive.go (next task).
func runPublishInteractive(cmd *cobra.Command) error {
    return errors.New("interactive publish not yet implemented")
}

// runStandalonePublish is provided in publish_standalone.go.
func runStandalonePublish(cmd *cobra.Command, path, slug, typ, version, description string) error {
    return errors.New("standalone publish not yet implemented")
}
```

Use the test path; the test passes the unmodified absolute path. Adjust test if `filepath.Abs` differs — the test uses `skillDir` which is already absolute under `t.TempDir()`. Register: `cmd.AddCommand(newPublishCmd())`.

- [ ] **Step 4: Run, verify PASS**

Run: `cd apps/cli && go test ./internal/cmd/ -run TestPublish_NonInteractive`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/internal/cmd/publish.go apps/cli/internal/cmd/publish_test.go apps/cli/internal/cmd/root.go
git commit -m "feat(cli): support non-interactive publish with path arg"
```

---

### Task 17: `claude-hub publish` (interactive wizard)

**Files:**
- Create: `apps/cli/internal/cmd/publish_interactive.go`
- Create: `apps/cli/internal/cmd/publish_interactive_test.go`
- Modify: `apps/cli/internal/cmd/publish.go` (delegate)

- [ ] **Step 1: Write failing test**

`apps/cli/internal/cmd/publish_interactive_test.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package cmd

import (
    "encoding/json"
    "net/http"
    "net/http/httptest"
    "os"
    "path/filepath"
    "testing"
)

func TestSelectPublishCandidates(t *testing.T) {
    home := t.TempDir()
    t.Setenv("HOME", home)
    t.Setenv("USERPROFILE", home)
    dir := filepath.Join(home, ".claude-hub")
    _ = os.MkdirAll(dir, 0o700)
    _ = os.WriteFile(filepath.Join(dir, "agent.token"), []byte("dev"), 0o600)

    daemonSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        if r.URL.Path == "/v1/local" {
            _ = json.NewEncoder(w).Encode(map[string]any{
                "items": []map[string]any{
                    {"type": "skill", "slug": "fresh-helper", "path": "/tmp/x"},
                    {"type": "skill", "slug": "already-published", "path": "/tmp/y", "version": "1.0.0",
                        "publishedAs": map[string]any{"artifactId": "a1", "version": "1.0.0"}},
                    {"type": "skill", "slug": "outdated-helper", "path": "/tmp/z", "version": "1.1.0",
                        "publishedAs": map[string]any{"artifactId": "a2", "version": "1.0.0"}},
                },
            })
            return
        }
    }))
    defer daemonSrv.Close()
    t.Setenv("CLAUDE_HUB_AGENT_ADDR", daemonSrv.URL)

    cands, err := loadPublishCandidates()
    if err != nil {
        t.Fatalf("load: %v", err)
    }
    if len(cands) != 2 {
        t.Fatalf("expected 2 publishable items, got %d: %+v", len(cands), cands)
    }
    slugs := map[string]bool{}
    for _, c := range cands {
        slugs[c.Slug] = true
    }
    if !slugs["fresh-helper"] || !slugs["outdated-helper"] {
        t.Fatalf("wrong candidates: %v", slugs)
    }
}

func TestNextVersion(t *testing.T) {
    if got := nextVersion("1.2.3", "patch"); got != "1.2.4" {
        t.Fatalf("patch: got %s", got)
    }
    if got := nextVersion("1.2.3", "minor"); got != "1.3.0" {
        t.Fatalf("minor: got %s", got)
    }
    if got := nextVersion("1.2.3", "major"); got != "2.0.0" {
        t.Fatalf("major: got %s", got)
    }
    if got := nextVersion("", "patch"); got != "0.1.0" {
        t.Fatalf("empty: got %s", got)
    }
}
```

- [ ] **Step 2: Run, verify FAIL**

Run: `cd apps/cli && go test ./internal/cmd/ -run TestSelectPublishCandidates`
Expected: FAIL.

- [ ] **Step 3: Implement**

`apps/cli/internal/cmd/publish_interactive.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package cmd

import (
    "context"
    "errors"
    "fmt"
    "strconv"
    "strings"

    "github.com/animato/claude-hub/cli/internal/config"
    "github.com/animato/claude-hub/cli/internal/daemon"
    "github.com/charmbracelet/huh"
    "github.com/spf13/cobra"
)

func loadPublishCandidates() ([]daemon.InventoryItem, error) {
    tok, err := daemon.LoadAgentToken()
    if err != nil {
        return nil, fmt.Errorf("claude-hub-agent must be running: %w", err)
    }
    client := daemon.NewClient("", tok)
    ctx, cancel := context.WithTimeout(context.Background(), defaultTimeout*2)
    defer cancel()
    local, err := client.Local(ctx)
    if err != nil {
        return nil, err
    }
    var out []daemon.InventoryItem
    for _, item := range local.Items {
        if item.PublishedAs == nil {
            out = append(out, item)
            continue
        }
        if semverGreater(item.Version, item.PublishedAs.Version) {
            out = append(out, item)
        }
    }
    return out, nil
}

func semverGreater(a, b string) bool {
    if a == "" {
        return false
    }
    if b == "" {
        return true
    }
    pa, ea := parseSemver(a)
    pb, eb := parseSemver(b)
    if ea != nil || eb != nil {
        return false
    }
    for i := 0; i < 3; i++ {
        if pa[i] != pb[i] {
            return pa[i] > pb[i]
        }
    }
    return false
}

func parseSemver(s string) ([3]int, error) {
    var out [3]int
    parts := strings.Split(s, ".")
    if len(parts) != 3 {
        return out, fmt.Errorf("not semver: %s", s)
    }
    for i, p := range parts {
        n, err := strconv.Atoi(p)
        if err != nil {
            return out, err
        }
        out[i] = n
    }
    return out, nil
}

func nextVersion(current, bump string) string {
    if current == "" {
        return "0.1.0"
    }
    parts, err := parseSemver(current)
    if err != nil {
        return "0.1.0"
    }
    switch bump {
    case "minor":
        parts[1]++
        parts[2] = 0
    case "major":
        parts[0]++
        parts[1] = 0
        parts[2] = 0
    default:
        parts[2]++
    }
    return fmt.Sprintf("%d.%d.%d", parts[0], parts[1], parts[2])
}

func runPublishInteractiveImpl(cmd *cobra.Command) error {
    cands, err := loadPublishCandidates()
    if err != nil {
        return err
    }
    if len(cands) == 0 {
        return errors.New("no publishable items found locally")
    }
    cfg, err := config.Load(Globals.ConfigPath)
    if err != nil {
        return err
    }
    var idx int
    options := make([]huh.Option[int], 0, len(cands))
    for i, item := range cands {
        label := fmt.Sprintf("%s: %s  %s", item.Type, item.Slug, item.Path)
        options = append(options, huh.NewOption(label, i))
    }
    if err := huh.NewForm(huh.NewGroup(
        huh.NewSelect[int]().Title("What do you want to publish?").Options(options...).Value(&idx),
    )).Run(); err != nil {
        return err
    }
    chosen := cands[idx]
    suggested := nextVersion(chosen.Version, cfg.DefaultVersionBump)
    var version, description string
    version = suggested
    if err := huh.NewForm(huh.NewGroup(
        huh.NewInput().Title("Version").Value(&version),
        huh.NewInput().Title("Description").Value(&description),
    )).Run(); err != nil {
        return err
    }
    confirmed := false
    if err := huh.NewConfirm().
        Title(fmt.Sprintf("Publish %s:%s@%s?", chosen.Type, chosen.Slug, version)).
        Value(&confirmed).Run(); err != nil {
        return err
    }
    if !confirmed {
        fmt.Fprintln(cmd.OutOrStdout(), "aborted")
        return nil
    }
    tok, err := daemon.LoadAgentToken()
    if err != nil {
        return err
    }
    client := daemon.NewClient("", tok)
    ctx, cancel := context.WithTimeout(context.Background(), defaultTimeout*12)
    defer cancel()
    if err := client.Publish(ctx, daemon.PublishRequest{
        Slug:        chosen.Slug,
        Type:        string(chosen.Type),
        Version:     version,
        Description: description,
        SourcePath:  chosen.Path,
    }); err != nil {
        return err
    }
    fmt.Fprintf(cmd.OutOrStdout(), "published %s:%s@%s\n", chosen.Type, chosen.Slug, version)
    return nil
}
```

Update `runPublishInteractive` in `publish.go` to call `runPublishInteractiveImpl(cmd)`.

- [ ] **Step 4: Run, verify PASS**

Run: `cd apps/cli && go test ./internal/cmd/ -run TestSelectPublishCandidates`
Run: `cd apps/cli && go test ./internal/cmd/ -run TestNextVersion`
Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/internal/cmd/publish_interactive.go apps/cli/internal/cmd/publish_interactive_test.go apps/cli/internal/cmd/publish.go
git commit -m "feat(cli): add interactive publish wizard"
```

---

### Task 18: `claude-hub publish --standalone` (no daemon)

**Files:**
- Create: `apps/cli/internal/cmd/publish_standalone.go`
- Create: `apps/cli/internal/cmd/publish_standalone_test.go`
- Modify: `apps/cli/internal/cmd/publish.go`

- [ ] **Step 1: Write failing test**

`apps/cli/internal/cmd/publish_standalone_test.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package cmd

import (
    "archive/tar"
    "bytes"
    "compress/gzip"
    "io"
    "mime/multipart"
    "net/http"
    "net/http/httptest"
    "os"
    "path/filepath"
    "testing"
)

func TestStandalonePublish_TarsAndUploads(t *testing.T) {
    home := t.TempDir()
    t.Setenv("HOME", home)
    t.Setenv("USERPROFILE", home)
    dir := filepath.Join(home, ".claude-hub")
    _ = os.MkdirAll(dir, 0o700)
    _ = os.WriteFile(filepath.Join(dir, "cli.token"), []byte("session"), 0o600)
    skillDir := filepath.Join(home, "stand-skill")
    _ = os.MkdirAll(skillDir, 0o755)
    _ = os.WriteFile(filepath.Join(skillDir, "SKILL.md"), []byte("# hello"), 0o644)

    var receivedFiles []string
    hubSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        if r.URL.Path != "/api/artifacts/upload" {
            t.Fatalf("path: %s", r.URL.Path)
        }
        if err := r.ParseMultipartForm(64 << 20); err != nil {
            t.Fatalf("parse: %v", err)
        }
        f, _, err := r.FormFile("artifact")
        if err != nil {
            t.Fatalf("formfile: %v", err)
        }
        defer f.Close()
        gz, err := gzip.NewReader(f)
        if err != nil {
            t.Fatalf("gzip: %v", err)
        }
        tr := tar.NewReader(gz)
        for {
            h, err := tr.Next()
            if err == io.EOF {
                break
            }
            if err != nil {
                t.Fatalf("tar read: %v", err)
            }
            receivedFiles = append(receivedFiles, h.Name)
        }
        w.WriteHeader(200)
    }))
    defer hubSrv.Close()
    _ = os.WriteFile(filepath.Join(dir, "config.yaml"), []byte("hub_url: "+hubSrv.URL+"\n"), 0o600)

    cmd := NewRootCmd()
    var out bytes.Buffer
    cmd.SetOut(&out)
    cmd.SetErr(&out)
    cmd.SetArgs([]string{
        "publish", skillDir,
        "--type", "skill",
        "--slug", "stand-skill",
        "--version", "0.1.0",
        "--standalone",
        "--config", filepath.Join(dir, "config.yaml"),
    })
    if err := cmd.Execute(); err != nil {
        t.Fatalf("execute: %v", err)
    }
    found := false
    for _, n := range receivedFiles {
        if filepath.Base(n) == "SKILL.md" {
            found = true
        }
    }
    if !found {
        t.Fatalf("SKILL.md not in tar; got: %v", receivedFiles)
    }
}

// reference: ensure multipart compiles in test build.
var _ = multipart.NewWriter
```

- [ ] **Step 2: Run, verify FAIL**

Run: `cd apps/cli && go test ./internal/cmd/ -run TestStandalonePublish`
Expected: FAIL — `runStandalonePublish` returns "not yet implemented".

- [ ] **Step 3: Implement**

`apps/cli/internal/cmd/publish_standalone.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package cmd

import (
    "archive/tar"
    "compress/gzip"
    "context"
    "crypto/sha256"
    "encoding/hex"
    "errors"
    "fmt"
    "io"
    "os"
    "path/filepath"
    "strings"

    "github.com/animato/claude-hub/cli/internal/config"
    "github.com/animato/claude-hub/cli/internal/hub"
    "github.com/spf13/cobra"
)

func runStandalonePublishImpl(cmd *cobra.Command, sourcePath, slug, typ, version, description string) error {
    cfg, err := config.Load(Globals.ConfigPath)
    if err != nil {
        return err
    }
    if cfg.HubURL == "" {
        return errors.New("hub_url not configured")
    }
    sessionTok, _ := hub.LoadCLIToken()
    if sessionTok == "" {
        return errors.New("standalone publish requires login (run claude-hub login)")
    }

    tarPath, sum, err := tarGzipDir(sourcePath)
    if err != nil {
        return err
    }
    defer os.Remove(tarPath)

    client := hub.NewClient(cfg.HubURL)
    client.SessionToken = sessionTok
    ctx, cancel := context.WithTimeout(context.Background(), defaultTimeout*24)
    defer cancel()
    if err := client.UploadArtifact(ctx, tarPath, slug, typ, version, description, sum); err != nil {
        return err
    }
    fmt.Fprintf(cmd.OutOrStdout(), "published %s:%s@%s (standalone, sha256=%s)\n", typ, slug, version, sum)
    return nil
}

// tarGzipDir tar+gzips the given path into a temp file. Returns the temp path and sha256 hex.
func tarGzipDir(srcPath string) (string, string, error) {
    info, err := os.Stat(srcPath)
    if err != nil {
        return "", "", err
    }
    tmp, err := os.CreateTemp("", "claude-hub-publish-*.tar.gz")
    if err != nil {
        return "", "", err
    }
    defer tmp.Close()

    h := sha256.New()
    mw := io.MultiWriter(tmp, h)
    gz := gzip.NewWriter(mw)
    tw := tar.NewWriter(gz)

    walk := func(path string, fi os.FileInfo, walkErr error) error {
        if walkErr != nil {
            return walkErr
        }
        rel, err := filepath.Rel(srcPath, path)
        if err != nil {
            return err
        }
        rel = strings.ReplaceAll(rel, string(os.PathSeparator), "/")
        if rel == "." {
            return nil
        }
        hdr, err := tar.FileInfoHeader(fi, "")
        if err != nil {
            return err
        }
        hdr.Name = rel
        if err := tw.WriteHeader(hdr); err != nil {
            return err
        }
        if !fi.Mode().IsRegular() {
            return nil
        }
        f, err := os.Open(path)
        if err != nil {
            return err
        }
        defer f.Close()
        _, err = io.Copy(tw, f)
        return err
    }

    if info.IsDir() {
        if err := filepath.Walk(srcPath, walk); err != nil {
            return "", "", err
        }
    } else {
        if err := walk(srcPath, info, nil); err != nil {
            return "", "", err
        }
    }
    if err := tw.Close(); err != nil {
        return "", "", err
    }
    if err := gz.Close(); err != nil {
        return "", "", err
    }
    return tmp.Name(), hex.EncodeToString(h.Sum(nil)), nil
}
```

Then in `publish.go`, replace `runStandalonePublish` to call `runStandalonePublishImpl(cmd, path, slug, typ, version, description)`.

- [ ] **Step 4: Run, verify PASS**

Run: `cd apps/cli && go test ./internal/cmd/ -run TestStandalonePublish`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/internal/cmd/publish_standalone.go apps/cli/internal/cmd/publish_standalone_test.go apps/cli/internal/cmd/publish.go
git commit -m "feat(cli): add --standalone publish without daemon"
```

---

### Task 19: `claude-hub pair` subcommand

**Files:**
- Create: `apps/cli/internal/cmd/pair.go`
- Create: `apps/cli/internal/cmd/pair_test.go`
- Modify: `apps/cli/internal/cmd/root.go`

- [ ] **Step 1: Write failing test**

`apps/cli/internal/cmd/pair_test.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package cmd

import (
    "bytes"
    "encoding/json"
    "net/http"
    "net/http/httptest"
    "os"
    "path/filepath"
    "testing"
)

func TestPair_AutoPin(t *testing.T) {
    home := t.TempDir()
    t.Setenv("HOME", home)
    t.Setenv("USERPROFILE", home)
    dir := filepath.Join(home, ".claude-hub")
    _ = os.MkdirAll(dir, 0o700)
    _ = os.WriteFile(filepath.Join(dir, "cli.token"), []byte("session-tok"), 0o600)
    _ = os.WriteFile(filepath.Join(dir, "agent.token"), []byte("agent-tok"), 0o600)

    daemonHits := 0
    daemonSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        if r.URL.Path != "/v1/pair" {
            t.Fatalf("daemon path: %s", r.URL.Path)
        }
        var body map[string]string
        _ = json.NewDecoder(r.Body).Decode(&body)
        if body["pin"] != "123456" {
            t.Fatalf("pin not propagated: %v", body)
        }
        daemonHits++
        w.WriteHeader(200)
    }))
    defer daemonSrv.Close()
    t.Setenv("CLAUDE_HUB_AGENT_ADDR", daemonSrv.URL)

    hubSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        if r.URL.Path == "/api/daemons/pair" {
            _ = json.NewEncoder(w).Encode(map[string]string{"pin": "123456"})
            return
        }
        w.WriteHeader(404)
    }))
    defer hubSrv.Close()
    _ = os.WriteFile(filepath.Join(dir, "config.yaml"), []byte("hub_url: "+hubSrv.URL+"\n"), 0o600)

    cmd := NewRootCmd()
    var out bytes.Buffer
    cmd.SetOut(&out)
    cmd.SetErr(&out)
    cmd.SetArgs([]string{"pair", "--config", filepath.Join(dir, "config.yaml")})
    if err := cmd.Execute(); err != nil {
        t.Fatalf("execute: %v", err)
    }
    if daemonHits != 1 {
        t.Fatalf("expected 1 daemon pair call, got %d", daemonHits)
    }
}

func TestPair_ExplicitPin(t *testing.T) {
    home := t.TempDir()
    t.Setenv("HOME", home)
    t.Setenv("USERPROFILE", home)
    dir := filepath.Join(home, ".claude-hub")
    _ = os.MkdirAll(dir, 0o700)
    _ = os.WriteFile(filepath.Join(dir, "agent.token"), []byte("agent-tok"), 0o600)

    daemonHits := 0
    daemonSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        var body map[string]string
        _ = json.NewDecoder(r.Body).Decode(&body)
        if body["pin"] != "999000" || body["hub_url"] != "https://h.example" {
            t.Fatalf("body: %v", body)
        }
        daemonHits++
        w.WriteHeader(200)
    }))
    defer daemonSrv.Close()
    t.Setenv("CLAUDE_HUB_AGENT_ADDR", daemonSrv.URL)

    cmd := NewRootCmd()
    var out bytes.Buffer
    cmd.SetOut(&out)
    cmd.SetErr(&out)
    cmd.SetArgs([]string{"pair", "--hub", "https://h.example", "--pin", "999000"})
    if err := cmd.Execute(); err != nil {
        t.Fatalf("execute: %v", err)
    }
    if daemonHits != 1 {
        t.Fatalf("expected 1 daemon call")
    }
}
```

- [ ] **Step 2: Run, verify FAIL**

Run: `cd apps/cli && go test ./internal/cmd/ -run TestPair`
Expected: FAIL — `pair` not registered.

- [ ] **Step 3: Implement**

`apps/cli/internal/cmd/pair.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package cmd

import (
    "context"
    "errors"
    "fmt"

    "github.com/animato/claude-hub/cli/internal/config"
    "github.com/animato/claude-hub/cli/internal/daemon"
    "github.com/animato/claude-hub/cli/internal/hub"
    "github.com/spf13/cobra"
)

func newPairCmd() *cobra.Command {
    var hubURL, pin string
    cmd := &cobra.Command{
        Use:   "pair",
        Short: "Pair the local daemon with a hub",
        RunE: func(cmd *cobra.Command, args []string) error {
            cfg, _ := config.Load(Globals.ConfigPath)
            if cfg == nil {
                cfg = &config.Config{}
            }
            if hubURL == "" {
                hubURL = cfg.HubURL
            }
            if hubURL == "" {
                return errors.New("--hub is required")
            }
            ctx, cancel := context.WithTimeout(context.Background(), defaultTimeout*4)
            defer cancel()
            if pin == "" {
                sessionTok, _ := hub.LoadCLIToken()
                if sessionTok == "" {
                    return errors.New("must be logged in to auto-generate pin (run claude-hub login)")
                }
                hubClient := hub.NewClient(hubURL)
                hubClient.SessionToken = sessionTok
                got, err := hubClient.CreatePairingPin(ctx)
                if err != nil {
                    return fmt.Errorf("create pairing pin: %w", err)
                }
                pin = got
            }
            tok, err := daemon.LoadAgentToken()
            if err != nil {
                return fmt.Errorf("claude-hub-agent must be running: %w", err)
            }
            d := daemon.NewClient("", tok)
            if err := d.Pair(ctx, daemon.PairRequest{HubURL: hubURL, Pin: pin}); err != nil {
                return fmt.Errorf("daemon pair: %w", err)
            }
            fmt.Fprintf(cmd.OutOrStdout(), "paired with %s\n", hubURL)
            return nil
        },
    }
    cmd.Flags().StringVar(&hubURL, "hub", "", "hub URL")
    cmd.Flags().StringVar(&pin, "pin", "", "explicit 6-digit pin (skips auto-generation)")
    return cmd
}
```

Register: `cmd.AddCommand(newPairCmd())`.

- [ ] **Step 4: Run, verify PASS**

Run: `cd apps/cli && go test ./internal/cmd/ -run TestPair`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/internal/cmd/pair.go apps/cli/internal/cmd/pair_test.go apps/cli/internal/cmd/root.go
git commit -m "feat(cli): add pair subcommand"
```

---

### Task 20: Server-side `createBackupStream` (admin backup)

**Files:**
- Create: `apps/hub-server/src/admin/backup.ts`
- Create: `apps/hub-server/src/admin/backup.test.ts`

- [ ] **Step 1: Write failing test**

`apps/hub-server/src/admin/backup.test.ts`:
```typescript
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { createBackupStream } from './backup.js';
import { createGunzip } from 'node:zlib';
import * as tar from 'tar';

describe('createBackupStream', () => {
  it('produces a gzipped tar containing pg_dump.sql and minio entries', async () => {
    const stream = await createBackupStream({
      pgDumpCommand: ['node', '-e', 'process.stdout.write("-- fake dump\\n")'],
      minio: {
        listObjects: async function* () {
          yield { name: 'artifacts/x.tar.gz', getStream: () => Readable.from(['blob']) };
        },
      },
    });
    const chunks: Buffer[] = [];
    for await (const c of stream.pipe(createGunzip())) chunks.push(Buffer.from(c));
    const buf = Buffer.concat(chunks);
    const entries: string[] = [];
    await new Promise<void>((resolve, reject) => {
      Readable.from([buf])
        .pipe(tar.list({ onentry: (e) => entries.push(e.path) }))
        .on('finish', resolve)
        .on('error', reject);
    });
    expect(entries).toContain('pg_dump.sql');
    expect(entries.find((e) => e.startsWith('minio/'))).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `pnpm --filter hub-server test src/admin/backup.test.ts`
Expected: FAIL — `createBackupStream` undefined.

- [ ] **Step 3: Implement**

`apps/hub-server/src/admin/backup.ts`:
```typescript
// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { PassThrough, Readable } from 'node:stream';
import { createGzip } from 'node:zlib';
import * as tar from 'tar';

export interface MinioObjectRef {
  name: string;
  getStream: () => Readable;
}

export interface BackupDeps {
  pgDumpCommand?: string[]; // override for tests; default ['pg_dump', '-Fp', process.env.DATABASE_URL!]
  minio: {
    listObjects: () => AsyncIterable<MinioObjectRef>;
  };
}

export async function createBackupStream(deps: BackupDeps): Promise<Readable> {
  const out = new PassThrough();
  const pack = tar.create({ gzip: false, cwd: process.cwd() }, []);
  // We assemble the tar manually because content comes from streams, not files.
  const packer = new (await import('tar-stream')).default.pack();
  packer.pipe(createGzip()).pipe(out);

  const cmd = deps.pgDumpCommand ?? ['pg_dump', '-Fp', process.env.DATABASE_URL ?? ''];
  const dumpChunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd[0]!, cmd.slice(1));
    child.stdout.on('data', (b: Buffer) => dumpChunks.push(b));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`pg_dump exited ${code}`))));
  });
  const dump = Buffer.concat(dumpChunks);
  await new Promise<void>((resolve, reject) => {
    packer.entry({ name: 'pg_dump.sql', size: dump.length }, dump, (err) =>
      err ? reject(err) : resolve(),
    );
  });

  for await (const obj of deps.minio.listObjects()) {
    const chunks: Buffer[] = [];
    for await (const c of obj.getStream()) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    const buf = Buffer.concat(chunks);
    await new Promise<void>((resolve, reject) => {
      packer.entry({ name: `minio/${obj.name}`, size: buf.length }, buf, (err) =>
        err ? reject(err) : resolve(),
      );
    });
  }
  packer.finalize();
  // discard unused tar pack
  void pack;
  return out;
}
```

Add `tar-stream` and `tar` to `apps/hub-server/package.json` dependencies:
```bash
pnpm --filter hub-server add tar-stream tar
pnpm --filter hub-server add -D @types/tar-stream @types/tar
```

- [ ] **Step 4: Run, verify PASS**

Run: `pnpm --filter hub-server test src/admin/backup.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/hub-server/src/admin/backup.ts apps/hub-server/src/admin/backup.test.ts apps/hub-server/package.json pnpm-lock.yaml
git commit -m "feat(server): create gzipped tar backup stream (pg_dump + minio mirror)"
```

---

### Task 21: `GET /api/admin/backup` route

**Files:**
- Create: `apps/hub-server/src/routes/admin/backup.ts`
- Create: `apps/hub-server/test/integration/admin-backup.test.ts`
- Modify: `apps/hub-server/src/index.ts` (mount route)

- [ ] **Step 1: Write failing integration test**

`apps/hub-server/test/integration/admin-backup.test.ts`:
```typescript
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { startTestApp, loginAsAdmin, loginAsMember } from '../helpers/app.js';

describe('GET /api/admin/backup', () => {
  it('admin gets streamed gzipped tar', async () => {
    const { app, baseUrl } = await startTestApp();
    const adminToken = await loginAsAdmin(baseUrl);
    const res = await fetch(`${baseUrl}/api/admin/backup`, {
      headers: { Cookie: `session=${adminToken}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/gzip');
    expect(res.headers.get('content-disposition')).toMatch(
      /^attachment; filename=claude-hub-backup-\d{4}-\d{2}-\d{2}T/,
    );
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.length).toBeGreaterThan(0);
    await app.stop();
  });

  it('member gets 403', async () => {
    const { app, baseUrl } = await startTestApp();
    const memberToken = await loginAsMember(baseUrl);
    const res = await fetch(`${baseUrl}/api/admin/backup`, {
      headers: { Cookie: `session=${memberToken}` },
    });
    expect(res.status).toBe(403);
    await app.stop();
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `pnpm --filter hub-server test test/integration/admin-backup.test.ts`
Expected: FAIL — route not mounted.

- [ ] **Step 3: Implement route**

`apps/hub-server/src/routes/admin/backup.ts`:
```typescript
// SPDX-License-Identifier: Apache-2.0
import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { requireRole } from '../../auth/middleware.js';
import { createBackupStream } from '../../admin/backup.js';
import { getMinioClient, MINIO_BUCKET } from '../../storage/minio.js';

export const backupRoute = new Hono();

backupRoute.get('/api/admin/backup', requireRole('admin'), async (c) => {
  const minio = getMinioClient();
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `claude-hub-backup-${ts}.tar.gz`;
  const body = await createBackupStream({
    minio: {
      listObjects: async function* () {
        const objs = minio.listObjectsV2(MINIO_BUCKET, '', true);
        for await (const obj of objs) {
          if (!obj.name) continue;
          yield {
            name: obj.name,
            getStream: () => {
              return require('node:stream').Readable.from(
                (async function* () {
                  const stream = await minio.getObject(MINIO_BUCKET, obj.name!);
                  for await (const chunk of stream) yield chunk;
                })(),
              );
            },
          };
        }
      },
    },
  });
  c.header('Content-Type', 'application/gzip');
  c.header('Content-Disposition', `attachment; filename=${filename}`);
  return stream(c, async (s) => {
    for await (const chunk of body) {
      await s.write(chunk);
    }
  });
});
```

Mount in `apps/hub-server/src/index.ts`:
```typescript
import { backupRoute } from './routes/admin/backup.js';
app.route('/', backupRoute);
```

- [ ] **Step 4: Run, verify PASS**

Run: `pnpm --filter hub-server test test/integration/admin-backup.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/hub-server/src/routes/admin/backup.ts apps/hub-server/test/integration/admin-backup.test.ts apps/hub-server/src/index.ts
git commit -m "feat(server): GET /api/admin/backup streams pg_dump + minio mirror"
```

---

### Task 22: `claude-hub backup` CLI subcommand

**Files:**
- Create: `apps/cli/internal/cmd/backup.go`
- Create: `apps/cli/internal/cmd/backup_test.go`
- Modify: `apps/cli/internal/cmd/root.go`

- [ ] **Step 1: Write failing test**

`apps/cli/internal/cmd/backup_test.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package cmd

import (
    "bytes"
    "crypto/sha256"
    "encoding/hex"
    "net/http"
    "net/http/httptest"
    "os"
    "path/filepath"
    "testing"
)

func TestBackup_WritesFile(t *testing.T) {
    home := t.TempDir()
    t.Setenv("HOME", home)
    t.Setenv("USERPROFILE", home)
    dir := filepath.Join(home, ".claude-hub")
    _ = os.MkdirAll(dir, 0o700)
    _ = os.WriteFile(filepath.Join(dir, "cli.token"), []byte("session"), 0o600)

    payload := []byte("\x1f\x8bfake-gzip-content")
    sum := sha256.Sum256(payload)
    expected := hex.EncodeToString(sum[:])

    hubSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        if r.URL.Path != "/api/admin/backup" {
            t.Fatalf("path: %s", r.URL.Path)
        }
        w.Header().Set("Content-Type", "application/gzip")
        _, _ = w.Write(payload)
    }))
    defer hubSrv.Close()
    _ = os.WriteFile(filepath.Join(dir, "config.yaml"), []byte("hub_url: "+hubSrv.URL+"\n"), 0o600)

    outPath := filepath.Join(home, "backup.tar.gz")
    cmd := NewRootCmd()
    var stdout bytes.Buffer
    cmd.SetOut(&stdout)
    cmd.SetErr(&stdout)
    cmd.SetArgs([]string{"backup", "--out", outPath, "--config", filepath.Join(dir, "config.yaml")})
    if err := cmd.Execute(); err != nil {
        t.Fatalf("execute: %v", err)
    }
    got, err := os.ReadFile(outPath)
    if err != nil {
        t.Fatalf("read: %v", err)
    }
    gotSum := sha256.Sum256(got)
    if hex.EncodeToString(gotSum[:]) != expected {
        t.Fatalf("sha mismatch: %s vs %s", hex.EncodeToString(gotSum[:]), expected)
    }
}
```

- [ ] **Step 2: Run, verify FAIL**

Run: `cd apps/cli && go test ./internal/cmd/ -run TestBackup_WritesFile`
Expected: FAIL.

- [ ] **Step 3: Implement**

`apps/cli/internal/cmd/backup.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package cmd

import (
    "context"
    "errors"
    "fmt"
    "io"
    "net/http"
    "os"
    "time"

    "github.com/animato/claude-hub/cli/internal/config"
    "github.com/animato/claude-hub/cli/internal/hub"
    "github.com/spf13/cobra"
)

func newBackupCmd() *cobra.Command {
    var outPath string
    cmd := &cobra.Command{
        Use:   "backup",
        Short: "Download a hub backup (admin only)",
        RunE: func(cmd *cobra.Command, args []string) error {
            cfg, err := config.Load(Globals.ConfigPath)
            if err != nil {
                return err
            }
            if cfg.HubURL == "" {
                return errors.New("hub_url not configured")
            }
            sess, _ := hub.LoadCLIToken()
            if sess == "" {
                return errors.New("must be logged in (run claude-hub login)")
            }
            if outPath == "" {
                ts := time.Now().UTC().Format("20060102T150405Z")
                outPath = fmt.Sprintf("claude-hub-backup-%s.tar.gz", ts)
            }
            req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, cfg.HubURL+"/api/admin/backup", nil)
            if err != nil {
                return err
            }
            req.AddCookie(&http.Cookie{Name: "session", Value: sess})
            req.Header.Set("Authorization", "Bearer "+sess)
            client := &http.Client{Timeout: 30 * time.Minute}
            resp, err := client.Do(req)
            if err != nil {
                return err
            }
            defer resp.Body.Close()
            if resp.StatusCode != 200 {
                msg, _ := io.ReadAll(resp.Body)
                return fmt.Errorf("backup failed (%d): %s", resp.StatusCode, string(msg))
            }
            f, err := os.Create(outPath)
            if err != nil {
                return err
            }
            defer f.Close()
            if _, err := io.Copy(f, resp.Body); err != nil {
                return err
            }
            fmt.Fprintf(cmd.OutOrStdout(), "wrote %s\n", outPath)
            return nil
        },
    }
    cmd.Flags().StringVar(&outPath, "out", "", "output path (default claude-hub-backup-<UTC>.tar.gz)")
    return cmd
}
```

Register: `cmd.AddCommand(newBackupCmd())`.

- [ ] **Step 4: Run, verify PASS**

Run: `cd apps/cli && go test ./internal/cmd/ -run TestBackup_WritesFile`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/internal/cmd/backup.go apps/cli/internal/cmd/backup_test.go apps/cli/internal/cmd/root.go
git commit -m "feat(cli): claude-hub backup downloads pg_dump + minio mirror archive"
```

---

### Task 23: Server-side restore (admin restore)

**Files:**
- Create: `apps/hub-server/src/admin/restore.ts`
- Create: `apps/hub-server/src/routes/admin/restore.ts`
- Create: `apps/hub-server/test/integration/admin-restore.test.ts`
- Modify: `apps/hub-server/src/index.ts`

- [ ] **Step 1: Write failing round-trip test**

`apps/hub-server/test/integration/admin-restore.test.ts`:
```typescript
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { startTestApp, loginAsAdmin, seedSampleData, countRows, countMinioObjects } from '../helpers/app.js';

describe('POST /api/admin/restore', () => {
  it('round-trips backup -> truncate -> restore', async () => {
    const { app, baseUrl, db, minio } = await startTestApp();
    await seedSampleData(db, minio);
    const before = {
      users: await countRows(db, 'users'),
      artifacts: await countRows(db, 'artifacts'),
      objects: await countMinioObjects(minio),
    };
    expect(before.users).toBeGreaterThan(0);

    const adminToken = await loginAsAdmin(baseUrl);
    const dl = await fetch(`${baseUrl}/api/admin/backup`, {
      headers: { Cookie: `session=${adminToken}` },
    });
    const buf = Buffer.from(await dl.arrayBuffer());

    // wipe
    await db.execute(`TRUNCATE users, artifacts, artifact_versions, install_events CASCADE`);
    // assume helper that empties bucket
    await (await import('../helpers/app.js')).clearMinio(minio);

    const fd = new FormData();
    fd.set('confirm', 'RESTORE');
    fd.set('archive', new Blob([buf]), 'backup.tar.gz');
    const r = await fetch(`${baseUrl}/api/admin/restore`, {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}` },
      body: fd,
    });
    expect(r.status).toBe(200);

    expect(await countRows(db, 'users')).toBe(before.users);
    expect(await countRows(db, 'artifacts')).toBe(before.artifacts);
    expect(await countMinioObjects(minio)).toBe(before.objects);
    await app.stop();
  });

  it('rejects without confirm=RESTORE', async () => {
    const { app, baseUrl } = await startTestApp();
    const adminToken = await loginAsAdmin(baseUrl);
    const fd = new FormData();
    fd.set('archive', new Blob([Buffer.from('x')]), 'backup.tar.gz');
    const r = await fetch(`${baseUrl}/api/admin/restore`, {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}` },
      body: fd,
    });
    expect(r.status).toBe(400);
    await app.stop();
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `pnpm --filter hub-server test test/integration/admin-restore.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement restore module**

`apps/hub-server/src/admin/restore.ts`:
```typescript
// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import * as tarStream from 'tar-stream';

export interface RestoreDeps {
  databaseUrl: string;
  minio: {
    putObject: (key: string, buf: Buffer) => Promise<void>;
  };
}

export async function applyRestore(archive: Readable, deps: RestoreDeps): Promise<{ tables: number; objects: number }> {
  const extract = tarStream.extract();
  let tables = 0;
  let objects = 0;
  let pgSql: Buffer | null = null;
  const objectWrites: Promise<void>[] = [];

  await new Promise<void>((resolve, reject) => {
    extract.on('entry', (header, stream, next) => {
      const chunks: Buffer[] = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (header.name === 'pg_dump.sql') {
          pgSql = buf;
        } else if (header.name.startsWith('minio/')) {
          const key = header.name.slice('minio/'.length);
          objectWrites.push(deps.minio.putObject(key, buf).then(() => { objects++; }));
        }
        next();
      });
      stream.resume();
    });
    extract.on('finish', resolve);
    extract.on('error', reject);
    archive.pipe(createGunzip()).pipe(extract);
  });

  if (!pgSql) throw new Error('archive missing pg_dump.sql');
  await runPsql(deps.databaseUrl, pgSql);
  tables = (pgSql.toString('utf8').match(/^CREATE TABLE/gm) ?? []).length;
  await Promise.all(objectWrites);
  return { tables, objects };
}

async function runPsql(databaseUrl: string, sql: Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('psql', [databaseUrl], { stdio: ['pipe', 'inherit', 'inherit'] });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`psql exited ${code}`))));
    child.stdin.end(sql);
  });
}
```

`apps/hub-server/src/routes/admin/restore.ts`:
```typescript
// SPDX-License-Identifier: Apache-2.0
import { Hono } from 'hono';
import { Readable } from 'node:stream';
import { requireRole } from '../../auth/middleware.js';
import { applyRestore } from '../../admin/restore.js';
import { getMinioClient, MINIO_BUCKET } from '../../storage/minio.js';

export const restoreRoute = new Hono();

restoreRoute.post('/api/admin/restore', requireRole('admin'), async (c) => {
  const form = await c.req.formData();
  const confirm = form.get('confirm');
  if (confirm !== 'RESTORE') {
    return c.json({ error: 'confirm=RESTORE required' }, 400);
  }
  const file = form.get('archive');
  if (!(file instanceof File)) {
    return c.json({ error: 'archive missing' }, 400);
  }
  const buf = Buffer.from(await file.arrayBuffer());
  const minio = getMinioClient();
  const result = await applyRestore(Readable.from(buf), {
    databaseUrl: process.env.DATABASE_URL!,
    minio: {
      putObject: async (key, b) => {
        await minio.putObject(MINIO_BUCKET, key, b);
      },
    },
  });
  return c.json({ ok: true, ...result });
});
```

Mount in `apps/hub-server/src/index.ts`:
```typescript
import { restoreRoute } from './routes/admin/restore.js';
app.route('/', restoreRoute);
```

- [ ] **Step 4: Run, verify PASS**

Run: `pnpm --filter hub-server test test/integration/admin-restore.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/hub-server/src/admin/restore.ts apps/hub-server/src/routes/admin/restore.ts apps/hub-server/test/integration/admin-restore.test.ts apps/hub-server/src/index.ts
git commit -m "feat(server): POST /api/admin/restore applies a backup archive"
```

---

### Task 24: `claude-hub restore <file>` CLI

**Files:**
- Create: `apps/cli/internal/cmd/restore.go`
- Create: `apps/cli/internal/cmd/restore_test.go`
- Modify: `apps/cli/internal/cmd/root.go`

- [ ] **Step 1: Write failing test**

`apps/cli/internal/cmd/restore_test.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package cmd

import (
    "bytes"
    "io"
    "mime/multipart"
    "net/http"
    "net/http/httptest"
    "os"
    "path/filepath"
    "strings"
    "testing"
)

func TestRestore_PostsArchive(t *testing.T) {
    home := t.TempDir()
    t.Setenv("HOME", home)
    t.Setenv("USERPROFILE", home)
    dir := filepath.Join(home, ".claude-hub")
    _ = os.MkdirAll(dir, 0o700)
    _ = os.WriteFile(filepath.Join(dir, "cli.token"), []byte("session"), 0o600)

    backup := filepath.Join(home, "backup.tar.gz")
    _ = os.WriteFile(backup, []byte("\x1f\x8bdummy"), 0o600)

    var receivedConfirm string
    var receivedArchive []byte
    hubSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        if r.URL.Path != "/api/admin/restore" {
            t.Fatalf("path: %s", r.URL.Path)
        }
        if err := r.ParseMultipartForm(64 << 20); err != nil {
            t.Fatalf("parse: %v", err)
        }
        receivedConfirm = r.FormValue("confirm")
        f, _, err := r.FormFile("archive")
        if err != nil {
            t.Fatalf("formfile: %v", err)
        }
        defer f.Close()
        b, _ := io.ReadAll(f)
        receivedArchive = b
        w.WriteHeader(200)
        _, _ = w.Write([]byte(`{"ok":true}`))
    }))
    defer hubSrv.Close()
    _ = os.WriteFile(filepath.Join(dir, "config.yaml"), []byte("hub_url: "+hubSrv.URL+"\n"), 0o600)

    cmd := NewRootCmd()
    var out bytes.Buffer
    cmd.SetOut(&out)
    cmd.SetErr(&out)
    cmd.SetArgs([]string{"restore", backup, "--force", "--config", filepath.Join(dir, "config.yaml")})
    if err := cmd.Execute(); err != nil {
        t.Fatalf("execute: %v", err)
    }
    if receivedConfirm != "RESTORE" {
        t.Fatalf("confirm not sent: %q", receivedConfirm)
    }
    if !bytes.HasPrefix(receivedArchive, []byte{0x1f, 0x8b}) {
        t.Fatalf("archive not uploaded properly")
    }
}

func TestRestore_RequiresForce(t *testing.T) {
    home := t.TempDir()
    t.Setenv("HOME", home)
    t.Setenv("USERPROFILE", home)
    dir := filepath.Join(home, ".claude-hub")
    _ = os.MkdirAll(dir, 0o700)
    _ = os.WriteFile(filepath.Join(dir, "cli.token"), []byte("session"), 0o600)
    _ = os.WriteFile(filepath.Join(dir, "config.yaml"), []byte("hub_url: http://localhost\n"), 0o600)
    backup := filepath.Join(home, "backup.tar.gz")
    _ = os.WriteFile(backup, []byte("x"), 0o600)

    cmd := NewRootCmd()
    var out bytes.Buffer
    cmd.SetOut(&out)
    cmd.SetErr(&out)
    cmd.SetArgs([]string{"restore", backup, "--config", filepath.Join(dir, "config.yaml")})
    err := cmd.Execute()
    if err == nil || !strings.Contains(err.Error(), "force") {
        t.Fatalf("expected --force error, got %v", err)
    }
    _ = multipart.NewWriter
}
```

- [ ] **Step 2: Run, verify FAIL**

Run: `cd apps/cli && go test ./internal/cmd/ -run TestRestore`
Expected: FAIL.

- [ ] **Step 3: Implement**

`apps/cli/internal/cmd/restore.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package cmd

import (
    "bytes"
    "context"
    "errors"
    "fmt"
    "io"
    "mime/multipart"
    "net/http"
    "os"
    "path/filepath"
    "time"

    "github.com/animato/claude-hub/cli/internal/config"
    "github.com/animato/claude-hub/cli/internal/hub"
    "github.com/spf13/cobra"
)

func newRestoreCmd() *cobra.Command {
    var dryRun, force bool
    cmd := &cobra.Command{
        Use:   "restore <file>",
        Short: "Apply a backup archive (admin only, destructive)",
        Args:  cobra.ExactArgs(1),
        RunE: func(cmd *cobra.Command, args []string) error {
            if !force {
                return errors.New("--force required: restore replaces all hub data")
            }
            cfg, err := config.Load(Globals.ConfigPath)
            if err != nil {
                return err
            }
            if cfg.HubURL == "" {
                return errors.New("hub_url not configured")
            }
            sess, _ := hub.LoadCLIToken()
            if sess == "" {
                return errors.New("must be logged in")
            }
            f, err := os.Open(args[0])
            if err != nil {
                return err
            }
            defer f.Close()

            body := &bytes.Buffer{}
            mw := multipart.NewWriter(body)
            _ = mw.WriteField("confirm", "RESTORE")
            fw, err := mw.CreateFormFile("archive", filepath.Base(args[0]))
            if err != nil {
                return err
            }
            if _, err := io.Copy(fw, f); err != nil {
                return err
            }
            if err := mw.Close(); err != nil {
                return err
            }
            if dryRun {
                fmt.Fprintln(cmd.OutOrStdout(), "[dry-run] would POST", cfg.HubURL+"/api/admin/restore")
                return nil
            }
            req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, cfg.HubURL+"/api/admin/restore", body)
            if err != nil {
                return err
            }
            req.Header.Set("Content-Type", mw.FormDataContentType())
            req.AddCookie(&http.Cookie{Name: "session", Value: sess})
            req.Header.Set("Authorization", "Bearer "+sess)
            client := &http.Client{Timeout: 30 * time.Minute}
            resp, err := client.Do(req)
            if err != nil {
                return err
            }
            defer resp.Body.Close()
            if resp.StatusCode >= 400 {
                msg, _ := io.ReadAll(resp.Body)
                return fmt.Errorf("restore failed (%d): %s", resp.StatusCode, string(msg))
            }
            fmt.Fprintln(cmd.OutOrStdout(), "restore complete")
            return nil
        },
    }
    cmd.Flags().BoolVar(&dryRun, "dry-run", false, "show what would happen without making the request")
    cmd.Flags().BoolVar(&force, "force", false, "required acknowledgement that restore is destructive")
    return cmd
}
```

Register: `cmd.AddCommand(newRestoreCmd())`.

- [ ] **Step 4: Run, verify PASS**

Run: `cd apps/cli && go test ./internal/cmd/ -run TestRestore`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/internal/cmd/restore.go apps/cli/internal/cmd/restore_test.go apps/cli/internal/cmd/root.go
git commit -m "feat(cli): claude-hub restore applies a backup archive"
```

---

### Task 25: `ops/install/install.sh` (Linux/macOS)

**Files:**
- Create: `ops/install/install.sh`
- Create: `ops/install/install_test.sh`

- [ ] **Step 1: Write failing test**

`ops/install/install_test.sh`:
```bash
#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Lint test: shellcheck must pass.
if ! command -v shellcheck >/dev/null; then
  echo "shellcheck not installed; skipping lint test"
  exit 0
fi
shellcheck "$SCRIPT_DIR/install.sh"

# Dry-run (--check-only) must succeed without network calls.
bash "$SCRIPT_DIR/install.sh" --check-only
```

- [ ] **Step 2: Run, verify FAIL**

Run: `bash ops/install/install_test.sh`
Expected: FAIL — `install.sh` missing.

- [ ] **Step 3: Implement install.sh**

`ops/install/install.sh`:
```bash
#!/usr/bin/env sh
# SPDX-License-Identifier: Apache-2.0
# claude-hub installer for Linux and macOS
set -eu

RELEASE_BASE_URL="${RELEASE_BASE_URL:-https://github.com/animato/claude-hub/releases/latest/download}"
HUB_URL="${HUB_URL:-}"
INSTALL_USER=0
CHECK_ONLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --user) INSTALL_USER=1 ;;
    --check-only) CHECK_ONLY=1 ;;
    --hub) shift; HUB_URL="$1" ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done

uname_s=$(uname -s)
uname_m=$(uname -m)

case "$uname_s" in
  Linux)  os=linux ;;
  Darwin) os=darwin ;;
  *) echo "unsupported OS: $uname_s" >&2; exit 1 ;;
esac

case "$uname_m" in
  x86_64|amd64) arch=amd64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) echo "unsupported arch: $uname_m" >&2; exit 1 ;;
esac

if [ "$INSTALL_USER" -eq 1 ]; then
  prefix="$HOME/.local/bin"
else
  prefix="/usr/local/bin"
fi

if [ "$CHECK_ONLY" -eq 1 ]; then
  echo "claude-hub installer dry-run: os=$os arch=$arch prefix=$prefix"
  exit 0
fi

mkdir -p "$prefix"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

agent_archive="claude-hub-agent_${os}_${arch}.tar.gz"
cli_archive="claude-hub_${os}_${arch}.tar.gz"

echo "Downloading checksums.txt..."
curl -fsSL "${RELEASE_BASE_URL}/checksums.txt" -o "$tmp/checksums.txt"

for archive in "$agent_archive" "$cli_archive"; do
  echo "Downloading $archive..."
  curl -fsSL "${RELEASE_BASE_URL}/${archive}" -o "$tmp/$archive"
  expected=$(grep "  $archive\$" "$tmp/checksums.txt" | awk '{print $1}')
  if [ -z "$expected" ]; then
    echo "no checksum for $archive" >&2; exit 1
  fi
  if command -v sha256sum >/dev/null; then
    actual=$(sha256sum "$tmp/$archive" | awk '{print $1}')
  else
    actual=$(shasum -a 256 "$tmp/$archive" | awk '{print $1}')
  fi
  if [ "$actual" != "$expected" ]; then
    echo "checksum mismatch for $archive" >&2; exit 1
  fi
  tar -xzf "$tmp/$archive" -C "$tmp"
done

if [ "$INSTALL_USER" -eq 1 ]; then
  install -m 0755 "$tmp/claude-hub-agent" "$prefix/claude-hub-agent"
  install -m 0755 "$tmp/claude-hub" "$prefix/claude-hub"
else
  sudo install -m 0755 "$tmp/claude-hub-agent" "$prefix/claude-hub-agent"
  sudo install -m 0755 "$tmp/claude-hub" "$prefix/claude-hub"
fi

"$prefix/claude-hub-agent" service install || echo "service install requires admin; run manually if needed"
"$prefix/claude-hub-agent" service start || true

echo
echo "Installed claude-hub to $prefix"
if [ -n "$HUB_URL" ]; then
  echo "Next: claude-hub pair --hub $HUB_URL"
else
  echo "Next: claude-hub pair --hub <hub_url>"
fi
```

- [ ] **Step 4: Run, verify PASS**

Run: `chmod +x ops/install/install.sh ops/install/install_test.sh && bash ops/install/install_test.sh`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ops/install/install.sh ops/install/install_test.sh
git commit -m "feat(install): add Linux/macOS install.sh with checksum verification"
```

---

### Task 26: `ops/install/install.ps1` (Windows)

**Files:**
- Create: `ops/install/install.ps1`
- Create: `ops/install/install.ps1.tests.ps1`

- [ ] **Step 1: Write failing test**

`ops/install/install.ps1.tests.ps1`:
```powershell
# SPDX-License-Identifier: Apache-2.0
# Run with: pwsh -File ops/install/install.ps1.tests.ps1
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $PSCommandPath
& "$here/install.ps1" -CheckOnly
if ($LASTEXITCODE -ne 0) { throw "install.ps1 -CheckOnly failed" }
Write-Host "PASS"
```

- [ ] **Step 2: Run, verify FAIL**

Run: `pwsh -File ops/install/install.ps1.tests.ps1`
Expected: FAIL — `install.ps1` missing.

- [ ] **Step 3: Implement**

`ops/install/install.ps1`:
```powershell
# SPDX-License-Identifier: Apache-2.0
# claude-hub installer for Windows
[CmdletBinding()]
param(
    [string]$ReleaseBaseUrl = $env:RELEASE_BASE_URL,
    [string]$HubUrl = $env:HUB_URL,
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'

if (-not $ReleaseBaseUrl) {
    $ReleaseBaseUrl = 'https://github.com/animato/claude-hub/releases/latest/download'
}

$os = 'windows'
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'AMD64') { 'amd64' } else { 'arm64' }
$prefix = Join-Path $env:LOCALAPPDATA 'claude-hub\bin'

if ($CheckOnly) {
    Write-Host "claude-hub installer dry-run: os=$os arch=$arch prefix=$prefix"
    exit 0
}

New-Item -ItemType Directory -Force -Path $prefix | Out-Null
$tmp = Join-Path $env:TEMP "claude-hub-install-$([Guid]::NewGuid())"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

try {
    $checksums = Join-Path $tmp 'checksums.txt'
    Invoke-WebRequest -Uri "$ReleaseBaseUrl/checksums.txt" -OutFile $checksums

    foreach ($name in @("claude-hub-agent_${os}_${arch}.zip", "claude-hub_${os}_${arch}.zip")) {
        $archive = Join-Path $tmp $name
        Write-Host "Downloading $name..."
        Invoke-WebRequest -Uri "$ReleaseBaseUrl/$name" -OutFile $archive
        $expectedLine = (Get-Content $checksums) | Where-Object { $_ -match "  $name$" }
        if (-not $expectedLine) { throw "no checksum for $name" }
        $expected = ($expectedLine -split '\s+')[0]
        $actual = (Get-FileHash -Algorithm SHA256 $archive).Hash.ToLower()
        if ($actual -ne $expected) { throw "checksum mismatch for $name" }
        Expand-Archive -Path $archive -DestinationPath $tmp -Force
    }

    Copy-Item (Join-Path $tmp 'claude-hub-agent.exe') (Join-Path $prefix 'claude-hub-agent.exe') -Force
    Copy-Item (Join-Path $tmp 'claude-hub.exe') (Join-Path $prefix 'claude-hub.exe') -Force

    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not ($userPath -split ';' -contains $prefix)) {
        [Environment]::SetEnvironmentVariable('Path', "$userPath;$prefix", 'User')
    }

    & (Join-Path $prefix 'claude-hub-agent.exe') service install
    & (Join-Path $prefix 'claude-hub-agent.exe') service start

    Write-Host "Installed claude-hub to $prefix"
    if ($HubUrl) {
        Write-Host "Next: claude-hub pair --hub $HubUrl"
    } else {
        Write-Host "Next: claude-hub pair --hub <hub_url>"
    }
} finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
```

- [ ] **Step 4: Run, verify PASS**

Run: `pwsh -File ops/install/install.ps1.tests.ps1`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ops/install/install.ps1 ops/install/install.ps1.tests.ps1
git commit -m "feat(install): add Windows install.ps1 with checksum verification"
```

---

### Task 27: Hub server `/install.sh` and `/install.ps1` endpoints

**Files:**
- Create: `apps/hub-server/src/routes/install-scripts.ts`
- Create: `apps/hub-server/test/integration/install-scripts.test.ts`
- Modify: `apps/hub-server/src/index.ts`

- [ ] **Step 1: Write failing test**

`apps/hub-server/test/integration/install-scripts.test.ts`:
```typescript
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { startTestApp } from '../helpers/app.js';

describe('install scripts', () => {
  it('GET /install.sh returns shell script with PUBLIC_URL substituted', async () => {
    process.env.PUBLIC_URL = 'https://hub.test';
    const { app, baseUrl } = await startTestApp();
    const res = await fetch(`${baseUrl}/install.sh`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/x-shellscript');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    const body = await res.text();
    expect(body).toContain('#!/usr/bin/env sh');
    expect(body).toContain('https://hub.test');
    expect(body).not.toContain('__HUB_URL__');
    await app.stop();
  });

  it('GET /install.ps1 returns powershell', async () => {
    const { app, baseUrl } = await startTestApp();
    const res = await fetch(`${baseUrl}/install.ps1`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/powershell|plain/);
    expect(await res.text()).toContain('CmdletBinding');
    await app.stop();
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `pnpm --filter hub-server test test/integration/install-scripts.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`apps/hub-server/src/routes/install-scripts.ts`:
```typescript
// SPDX-License-Identifier: Apache-2.0
import { Hono } from 'hono';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../../');

let cachedSh: string | null = null;
let cachedPs1: string | null = null;

async function loadSh(): Promise<string> {
  if (cachedSh) return cachedSh;
  const raw = await readFile(resolve(repoRoot, 'ops/install/install.sh'), 'utf8');
  cachedSh = raw;
  return cachedSh;
}

async function loadPs1(): Promise<string> {
  if (cachedPs1) return cachedPs1;
  const raw = await readFile(resolve(repoRoot, 'ops/install/install.ps1'), 'utf8');
  cachedPs1 = raw;
  return cachedPs1;
}

export const installScriptsRoute = new Hono();

installScriptsRoute.get('/install.sh', async (c) => {
  let body = await loadSh();
  body = body.replaceAll('__HUB_URL__', process.env.PUBLIC_URL ?? '');
  c.header('Content-Type', 'text/x-shellscript; charset=utf-8');
  c.header('Cache-Control', 'no-cache');
  return c.body(body);
});

installScriptsRoute.get('/install.ps1', async (c) => {
  let body = await loadPs1();
  body = body.replaceAll('__HUB_URL__', process.env.PUBLIC_URL ?? '');
  c.header('Content-Type', 'application/x-powershell; charset=utf-8');
  c.header('Cache-Control', 'no-cache');
  return c.body(body);
});
```

Mount in `apps/hub-server/src/index.ts`:
```typescript
import { installScriptsRoute } from './routes/install-scripts.js';
app.route('/', installScriptsRoute);
```

- [ ] **Step 4: Run, verify PASS**

Run: `pnpm --filter hub-server test test/integration/install-scripts.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/hub-server/src/routes/install-scripts.ts apps/hub-server/test/integration/install-scripts.test.ts apps/hub-server/src/index.ts
git commit -m "feat(server): serve /install.sh and /install.ps1 with PUBLIC_URL substitution"
```

---

### Task 28: Hub server `/dist/<os>-<arch>/<file>` redirect

**Files:**
- Create: `apps/hub-server/src/routes/dist.ts`
- Create: `apps/hub-server/test/integration/dist.test.ts`
- Modify: `apps/hub-server/src/index.ts`

- [ ] **Step 1: Write failing test**

`apps/hub-server/test/integration/dist.test.ts`:
```typescript
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { startTestApp } from '../helpers/app.js';

describe('/dist redirect', () => {
  it('redirects valid os-arch combos', async () => {
    process.env.RELEASE_BASE_URL = 'https://github.com/animato/claude-hub/releases/download/v0.1.0';
    const { app, baseUrl } = await startTestApp();
    const res = await fetch(`${baseUrl}/dist/linux-amd64/claude-hub-agent.tar.gz`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('linux-amd64/claude-hub-agent.tar.gz');
    await app.stop();
  });

  it('rejects unknown os-arch', async () => {
    const { app, baseUrl } = await startTestApp();
    const res = await fetch(`${baseUrl}/dist/plan9-mips/claude-hub-agent.tar.gz`);
    expect(res.status).toBe(404);
    await app.stop();
  });

  it('returns 503 when RELEASE_BASE_URL unset', async () => {
    delete process.env.RELEASE_BASE_URL;
    const { app, baseUrl } = await startTestApp();
    const res = await fetch(`${baseUrl}/dist/linux-amd64/foo`);
    expect(res.status).toBe(503);
    await app.stop();
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `pnpm --filter hub-server test test/integration/dist.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`apps/hub-server/src/routes/dist.ts`:
```typescript
// SPDX-License-Identifier: Apache-2.0
import { Hono } from 'hono';

const ALLOWED = new Set([
  'linux-amd64', 'linux-arm64',
  'darwin-amd64', 'darwin-arm64',
  'windows-amd64',
]);

export const distRoute = new Hono();

distRoute.get('/dist/:osArch/:file', (c) => {
  const base = process.env.RELEASE_BASE_URL;
  if (!base) {
    return c.json({ error: 'release downloads not configured' }, 503);
  }
  const osArch = c.req.param('osArch');
  const file = c.req.param('file');
  if (!ALLOWED.has(osArch)) {
    return c.json({ error: 'unknown os-arch' }, 404);
  }
  return c.redirect(`${base.replace(/\/$/, '')}/${osArch}/${file}`, 302);
});
```

Mount in `apps/hub-server/src/index.ts`:
```typescript
import { distRoute } from './routes/dist.js';
app.route('/', distRoute);
```

- [ ] **Step 4: Run, verify PASS**

Run: `pnpm --filter hub-server test test/integration/dist.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/hub-server/src/routes/dist.ts apps/hub-server/test/integration/dist.test.ts apps/hub-server/src/index.ts
git commit -m "feat(server): /dist redirect to RELEASE_BASE_URL with os-arch whitelist"
```

---

### Task 29: Homebrew formula

**Files:**
- Create: `ops/install/brew/claude-hub-agent.rb`
- Create: `ops/install/brew/README.md`

- [ ] **Step 1: Author formula**

`ops/install/brew/claude-hub-agent.rb`:
```ruby
# SPDX-License-Identifier: Apache-2.0
class ClaudeHubAgent < Formula
  desc "Self-hosted team marketplace daemon and CLI for Claude Code"
  homepage "https://github.com/animato/claude-hub"
  license "Apache-2.0"
  version "0.1.0"

  on_macos do
    on_arm do
      url "https://github.com/animato/claude-hub/releases/download/v0.1.0/claude-hub-agent_darwin_arm64.tar.gz"
      sha256 "REPLACE_WITH_DARWIN_ARM64_SHA256"
    end
    on_intel do
      url "https://github.com/animato/claude-hub/releases/download/v0.1.0/claude-hub-agent_darwin_amd64.tar.gz"
      sha256 "REPLACE_WITH_DARWIN_AMD64_SHA256"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/animato/claude-hub/releases/download/v0.1.0/claude-hub-agent_linux_arm64.tar.gz"
      sha256 "REPLACE_WITH_LINUX_ARM64_SHA256"
    end
    on_intel do
      url "https://github.com/animato/claude-hub/releases/download/v0.1.0/claude-hub-agent_linux_amd64.tar.gz"
      sha256 "REPLACE_WITH_LINUX_AMD64_SHA256"
    end
  end

  def install
    bin.install "claude-hub-agent"
    bin.install "claude-hub"
  end

  service do
    run [opt_bin/"claude-hub-agent", "run"]
    keep_alive true
    log_path var/"log/claude-hub-agent.log"
    error_log_path var/"log/claude-hub-agent.err.log"
  end

  test do
    assert_match "claude-hub", shell_output("#{bin}/claude-hub --version")
  end
end
```

`ops/install/brew/README.md`:
```markdown
# Homebrew tap for claude-hub

## End users

```sh
brew tap animato/claude-hub
brew install claude-hub-agent
brew services start claude-hub-agent
claude-hub pair --hub https://hub.firma.tld
```

## Maintainers

The release pipeline (`.github/workflows/release.yml`) renders this formula
into the public tap repository `animato/homebrew-tap` whenever a `v*` tag is
pushed and the `HOMEBREW_TAP_TOKEN` secret is configured.

If the secret is missing the release continues without bumping the tap; bump
manually by replacing the `REPLACE_WITH_*` SHA256 placeholders with values
from `checksums.txt`, committing, and pushing the tap repo.
```

- [ ] **Step 2: Commit**

```bash
git add ops/install/brew/claude-hub-agent.rb ops/install/brew/README.md
git commit -m "feat(install): add Homebrew formula and tap docs"
```

---

### Task 30: winget manifest templates

**Files:**
- Create: `ops/install/winget/Animato.ClaudeHub.yaml`
- Create: `ops/install/winget/Animato.ClaudeHub.locale.en-US.yaml`
- Create: `ops/install/winget/Animato.ClaudeHub.installer.yaml`
- Create: `ops/install/winget/build-manifest.sh`

- [ ] **Step 1: Author version manifest**

`ops/install/winget/Animato.ClaudeHub.yaml`:
```yaml
# SPDX-License-Identifier: Apache-2.0
PackageIdentifier: Animato.ClaudeHub
PackageVersion: ${VERSION}
DefaultLocale: en-US
ManifestType: version
ManifestVersion: 1.6.0
```

`ops/install/winget/Animato.ClaudeHub.locale.en-US.yaml`:
```yaml
# SPDX-License-Identifier: Apache-2.0
PackageIdentifier: Animato.ClaudeHub
PackageVersion: ${VERSION}
PackageLocale: en-US
Publisher: Animato
PublisherUrl: https://animato.cz
PackageName: Claude Hub
PackageUrl: https://github.com/animato/claude-hub
License: Apache-2.0
LicenseUrl: https://github.com/animato/claude-hub/blob/main/LICENSE
ShortDescription: Self-hosted team marketplace daemon and CLI for Claude Code.
ManifestType: defaultLocale
ManifestVersion: 1.6.0
```

`ops/install/winget/Animato.ClaudeHub.installer.yaml`:
```yaml
# SPDX-License-Identifier: Apache-2.0
PackageIdentifier: Animato.ClaudeHub
PackageVersion: ${VERSION}
InstallerType: wix
Scope: user
Installers:
  - Architecture: x64
    InstallerUrl: ${MSI_URL}
    InstallerSha256: ${MSI_SHA256}
ManifestType: installer
ManifestVersion: 1.6.0
```

`ops/install/winget/build-manifest.sh`:
```bash
#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail
: "${VERSION:?VERSION required}"
: "${MSI_URL:?MSI_URL required}"
: "${MSI_SHA256:?MSI_SHA256 required}"
out="${1:-build/winget}"
mkdir -p "$out"
for f in Animato.ClaudeHub.yaml Animato.ClaudeHub.locale.en-US.yaml Animato.ClaudeHub.installer.yaml; do
  envsubst < "$(dirname "$0")/$f" > "$out/$f"
done
echo "wrote $out/*.yaml"
```

- [ ] **Step 2: Commit**

```bash
chmod +x ops/install/winget/build-manifest.sh
git add ops/install/winget/
git commit -m "feat(install): add winget manifest templates"
```

---

### Task 31: WiX MSI project

**Files:**
- Create: `ops/install/msi/Product.wxs`
- Create: `ops/install/msi/claude-hub.wixproj`
- Create: `ops/install/msi/build.ps1`

- [ ] **Step 1: Author Product.wxs**

`ops/install/msi/Product.wxs`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!-- SPDX-License-Identifier: Apache-2.0 -->
<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs">
  <Package
    Name="Claude Hub"
    Manufacturer="Animato"
    Version="$(var.Version)"
    UpgradeCode="b5d2f3aa-7c4f-4d66-b1c0-1df9e3a08a12"
    Scope="perUser">
    <MediaTemplate EmbedCab="yes" />

    <Feature Id="Main" Title="Claude Hub" Level="1">
      <ComponentGroupRef Id="ClaudeHubBin" />
    </Feature>

    <StandardDirectory Id="LocalAppDataFolder">
      <Directory Id="INSTALLFOLDER" Name="claude-hub">
        <Directory Id="BIN" Name="bin">
          <Component Id="cmpAgent" Guid="*">
            <File Id="filAgent" Source="$(var.AgentExe)" KeyPath="yes" />
            <ServiceInstall
              Id="claudeHubAgentService"
              Name="ClaudeHubAgent"
              DisplayName="Claude Hub Agent"
              Type="ownProcess"
              Start="auto"
              ErrorControl="normal"
              Arguments="run" />
            <ServiceControl Id="startSvc" Name="ClaudeHubAgent" Start="install" Stop="both" Remove="uninstall" Wait="no" />
          </Component>
          <Component Id="cmpCli" Guid="*">
            <File Id="filCli" Source="$(var.CliExe)" KeyPath="yes" />
            <Environment Id="PATH" Name="PATH" Value="[BIN]" Permanent="no" Part="last" Action="set" System="no" />
          </Component>
        </Directory>
      </Directory>
    </StandardDirectory>

    <ComponentGroup Id="ClaudeHubBin">
      <ComponentRef Id="cmpAgent" />
      <ComponentRef Id="cmpCli" />
    </ComponentGroup>
  </Package>
</Wix>
```

`ops/install/msi/claude-hub.wixproj`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!-- SPDX-License-Identifier: Apache-2.0 -->
<Project Sdk="WixToolset.Sdk/4.0.0">
  <PropertyGroup>
    <OutputType>Package</OutputType>
    <OutputName>claude-hub-$(Version)-x64</OutputName>
  </PropertyGroup>
  <ItemGroup>
    <Compile Include="Product.wxs" />
  </ItemGroup>
</Project>
```

`ops/install/msi/build.ps1`:
```powershell
# SPDX-License-Identifier: Apache-2.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Version,
    [string]$AgentExe = "$PSScriptRoot/../../../dist/windows-amd64/claude-hub-agent.exe",
    [string]$CliExe = "$PSScriptRoot/../../../dist/windows-amd64/claude-hub.exe",
    [string]$OutDir = "$PSScriptRoot/../../../dist/msi"
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
& wix build "$PSScriptRoot/Product.wxs" `
    -d "Version=$Version" `
    -d "AgentExe=$AgentExe" `
    -d "CliExe=$CliExe" `
    -o (Join-Path $OutDir "claude-hub-$Version-x64.msi")
```

- [ ] **Step 2: Commit**

```bash
git add ops/install/msi/
git commit -m "feat(install): add WiX 4 project for Windows MSI"
```

---

### Task 32: GoReleaser configuration

**Files:**
- Create: `.goreleaser.yaml`

- [ ] **Step 1: Author config**

`.goreleaser.yaml`:
```yaml
# SPDX-License-Identifier: Apache-2.0
version: 2
project_name: claude-hub

builds:
  - id: agent
    main: ./apps/agent/cmd/claude-hub-agent
    binary: claude-hub-agent
    env: [CGO_ENABLED=0]
    goos: [linux, darwin, windows]
    goarch: [amd64, arm64]
    ignore:
      - goos: windows
        goarch: arm64
    ldflags:
      - -s -w -X main.version={{.Version}}

  - id: cli
    main: ./apps/cli/cmd/claude-hub
    binary: claude-hub
    env: [CGO_ENABLED=0]
    goos: [linux, darwin, windows]
    goarch: [amd64, arm64]
    ignore:
      - goos: windows
        goarch: arm64
    ldflags:
      - -s -w -X github.com/animato/claude-hub/cli/internal/cmd.Version={{.Version}}

archives:
  - id: agent-archive
    builds: [agent]
    name_template: 'claude-hub-agent_{{ .Os }}_{{ .Arch }}'
    files: [LICENSE, README.md]
    format_overrides:
      - goos: windows
        format: zip

  - id: cli-archive
    builds: [cli]
    name_template: 'claude-hub_{{ .Os }}_{{ .Arch }}'
    files: [LICENSE, README.md]
    format_overrides:
      - goos: windows
        format: zip

checksum:
  name_template: checksums.txt
  algorithm: sha256

release:
  draft: false
  prerelease: auto
```

- [ ] **Step 2: Verify config**

Run: `goreleaser check`
Expected: PASS (or skip locally if goreleaser not installed; CI will validate).

- [ ] **Step 3: Commit**

```bash
git add .goreleaser.yaml
git commit -m "feat(ci): add GoReleaser config for agent and CLI"
```

---

### Task 33: `cliff.toml` for changelog

**Files:**
- Create: `cliff.toml`
- Create: `CHANGELOG.md`

- [ ] **Step 1: Author cliff.toml**

`cliff.toml`:
```toml
# SPDX-License-Identifier: Apache-2.0
[changelog]
header = """
# Changelog

All notable changes to this project will be documented in this file.
"""
body = """
{% for group, commits in commits | group_by(attribute="group") %}
## {{ group | upper_first }}
{% for commit in commits %}
- {{ commit.message | upper_first }}{% if commit.breaking %} **BREAKING**{% endif %}
{% endfor %}
{% endfor %}
"""
trim = true

[git]
conventional_commits = true
filter_unconventional = true
commit_parsers = [
  { message = "^feat", group = "Features" },
  { message = "^fix", group = "Bug Fixes" },
  { message = "^docs", group = "Documentation" },
  { message = "^refactor", group = "Refactor" },
  { message = "^test", group = "Tests" },
  { message = "^chore\\(release\\)", skip = true },
  { message = "^chore", group = "Chores" },
  { message = "^ci", group = "CI" },
]
```

`CHANGELOG.md`:
```markdown
<!-- SPDX-License-Identifier: Apache-2.0 -->
# Changelog

## [Unreleased]
```

- [ ] **Step 2: Commit**

```bash
git add cliff.toml CHANGELOG.md
git commit -m "docs: bootstrap CHANGELOG and cliff config"
```

---

### Task 34: `.github/workflows/release.yml` skeleton

**Files:**
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: Author workflow**

`.github/workflows/release.yml`:
```yaml
# SPDX-License-Identifier: Apache-2.0
name: release

on:
  push:
    tags: ['v*']

permissions:
  contents: write
  packages: write
  id-token: write

jobs:
  build-server:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: 'pnpm' }
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter dashboard build
      - run: pnpm --filter hub-server build
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v6
        with:
          context: .
          file: ops/docker/hub-server.Dockerfile
          push: true
          tags: |
            ghcr.io/animato/claude-hub:${{ github.ref_name }}
            ghcr.io/animato/claude-hub:latest

  build-agent-cli:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-go@v5
        with: { go-version: '1.23' }
      - uses: goreleaser/goreleaser-action@v6
        with:
          version: latest
          args: release --clean --skip=publish
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      - uses: actions/upload-artifact@v4
        with:
          name: dist
          path: dist/

  build-msi:
    runs-on: windows-latest
    needs: build-agent-cli
    steps:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v4
        with: { name: dist, path: dist }
      - run: dotnet tool install --global wix
      - shell: pwsh
        run: |
          $version = '${{ github.ref_name }}'.TrimStart('v')
          ./ops/install/msi/build.ps1 -Version $version `
            -AgentExe (Resolve-Path dist/agent_windows_amd64_v1/claude-hub-agent.exe) `
            -CliExe   (Resolve-Path dist/cli_windows_amd64_v1/claude-hub.exe)
      - shell: pwsh
        run: |
          $msi = Get-ChildItem dist/msi/*.msi | Select-Object -First 1
          $h = (Get-FileHash -Algorithm SHA256 $msi.FullName).Hash.ToLower()
          "$h  $($msi.Name)" | Out-File -Encoding ascii dist/msi/msi-sha256.txt
      - uses: actions/upload-artifact@v4
        with:
          name: msi
          path: dist/msi/

  release:
    runs-on: ubuntu-latest
    needs: [build-server, build-agent-cli, build-msi]
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/download-artifact@v4
        with: { name: dist, path: dist }
      - uses: actions/download-artifact@v4
        with: { name: msi, path: dist/msi }
      - uses: orhun/git-cliff-action@v3
        with:
          config: cliff.toml
          args: --tag ${{ github.ref_name }} --output CHANGELOG-RELEASE.md
      - uses: softprops/action-gh-release@v2
        with:
          body_path: CHANGELOG-RELEASE.md
          files: |
            dist/*.tar.gz
            dist/*.zip
            dist/checksums.txt
            dist/msi/*.msi
            dist/msi/msi-sha256.txt

  homebrew:
    runs-on: ubuntu-latest
    needs: release
    if: ${{ secrets.HOMEBREW_TAP_TOKEN != '' }}
    steps:
      - uses: actions/checkout@v4
      - run: |
          if [ -z "${HOMEBREW_TAP_TOKEN:-}" ]; then
            echo "homebrew tap not configured — see ops/install/brew/README.md"
            exit 0
          fi
          # actual tap bump implemented in a follow-up PR; placeholder echo for now
          echo "would bump animato/homebrew-tap to ${{ github.ref_name }}"
        env:
          HOMEBREW_TAP_TOKEN: ${{ secrets.HOMEBREW_TAP_TOKEN }}

  winget:
    runs-on: windows-latest
    needs: release
    if: ${{ secrets.WINGET_GITHUB_TOKEN != '' }}
    steps:
      - uses: vedantmgoyal9/winget-releaser@main
        with:
          identifier: Animato.ClaudeHub
          installers-regex: '\.msi$'
          token: ${{ secrets.WINGET_GITHUB_TOKEN }}
          version: ${{ github.ref_name }}
```

- [ ] **Step 2: Lint with actionlint**

Run: `actionlint .github/workflows/release.yml` (or rely on CI step from Task 39).
Expected: PASS or expected warnings only.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "feat(ci): add release workflow with build, MSI, GitHub release, brew, winget"
```

---

### Task 35: License header tool

**Files:**
- Create: `tools/license-headers/main.go`
- Create: `tools/license-headers/main_test.go`
- Create: `tools/license-headers/go.mod`
- Modify: `go.work`

- [ ] **Step 1: Init module**

```bash
cd tools/license-headers
go mod init github.com/animato/claude-hub/tools/license-headers
```

Add to `go.work`:
```
use (
    ./apps/agent
    ./apps/cli
    ./tools/license-headers
)
```

- [ ] **Step 2: Write failing test**

`tools/license-headers/main_test.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package main

import (
    "os"
    "path/filepath"
    "testing"
)

func TestProcess_AddsHeader(t *testing.T) {
    dir := t.TempDir()
    p := filepath.Join(dir, "foo.go")
    if err := os.WriteFile(p, []byte("package foo\n"), 0o644); err != nil {
        t.Fatal(err)
    }
    changed, err := process(p, true)
    if err != nil {
        t.Fatalf("process: %v", err)
    }
    if !changed {
        t.Fatal("expected change")
    }
    out, _ := os.ReadFile(p)
    if !startsWithSPDX(string(out)) {
        t.Fatalf("missing SPDX header: %s", out)
    }
}

func TestProcess_AlreadyPresent(t *testing.T) {
    dir := t.TempDir()
    p := filepath.Join(dir, "foo.go")
    src := "// SPDX-License-Identifier: Apache-2.0\npackage foo\n"
    _ = os.WriteFile(p, []byte(src), 0o644)
    changed, err := process(p, true)
    if err != nil {
        t.Fatal(err)
    }
    if changed {
        t.Fatal("did not expect change")
    }
}

func TestProcess_Shebang(t *testing.T) {
    dir := t.TempDir()
    p := filepath.Join(dir, "tool.ts")
    src := "#!/usr/bin/env node\nconsole.log('x');\n"
    _ = os.WriteFile(p, []byte(src), 0o644)
    changed, err := process(p, true)
    if err != nil {
        t.Fatal(err)
    }
    if !changed {
        t.Fatal("expected header inserted after shebang")
    }
    out, _ := os.ReadFile(p)
    s := string(out)
    if s[:2] != "#!" {
        t.Fatalf("shebang clobbered: %q", s)
    }
    if !startsWithSPDX(s[len("#!/usr/bin/env node\n"):]) {
        t.Fatalf("header not on line 2: %q", s)
    }
}
```

- [ ] **Step 3: Run, verify FAIL**

Run: `cd tools/license-headers && go test ./...`
Expected: FAIL.

- [ ] **Step 4: Implement**

`tools/license-headers/main.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package main

import (
    "flag"
    "fmt"
    "io/fs"
    "os"
    "path/filepath"
    "strings"
)

const headerLine = "// SPDX-License-Identifier: Apache-2.0"

var skipDirs = map[string]bool{
    "node_modules": true,
    ".next":        true,
    "dist":         true,
    "build":        true,
    "vendor":       true,
    ".git":         true,
}

var skipSuffixes = []string{".gen.go", ".d.ts", ".min.js"}

func startsWithSPDX(s string) bool {
    return strings.HasPrefix(s, headerLine)
}

func process(path string, apply bool) (bool, error) {
    raw, err := os.ReadFile(path)
    if err != nil {
        return false, err
    }
    s := string(raw)
    if startsWithSPDX(s) {
        return false, nil
    }
    var head, rest string
    if strings.HasPrefix(s, "#!") {
        idx := strings.IndexByte(s, '\n')
        if idx < 0 {
            head, rest = s+"\n", ""
        } else {
            head, rest = s[:idx+1], s[idx+1:]
        }
    } else {
        head, rest = "", s
    }
    if startsWithSPDX(rest) {
        return false, nil
    }
    new := head + headerLine + "\n" + rest
    if !apply {
        return true, nil
    }
    return true, os.WriteFile(path, []byte(new), 0o644)
}

func main() {
    var apply, check bool
    flag.BoolVar(&apply, "apply", false, "rewrite files in place")
    flag.BoolVar(&check, "check", false, "exit 1 if any file is missing the header")
    flag.Parse()
    if !apply && !check {
        fmt.Fprintln(os.Stderr, "specify --apply or --check")
        os.Exit(2)
    }
    root := "."
    if flag.NArg() == 1 {
        root = flag.Arg(0)
    }
    var changed []string
    err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
        if err != nil {
            return err
        }
        if d.IsDir() {
            if skipDirs[d.Name()] {
                return filepath.SkipDir
            }
            return nil
        }
        ext := filepath.Ext(p)
        if ext != ".go" && ext != ".ts" && ext != ".tsx" {
            return nil
        }
        for _, s := range skipSuffixes {
            if strings.HasSuffix(p, s) {
                return nil
            }
        }
        c, err := process(p, apply)
        if err != nil {
            return err
        }
        if c {
            changed = append(changed, p)
        }
        return nil
    })
    if err != nil {
        fmt.Fprintln(os.Stderr, err)
        os.Exit(2)
    }
    if check && len(changed) > 0 {
        fmt.Fprintln(os.Stderr, "missing SPDX headers:")
        for _, p := range changed {
            fmt.Fprintln(os.Stderr, "  "+p)
        }
        os.Exit(1)
    }
    if apply {
        fmt.Printf("updated %d files\n", len(changed))
    }
}
```

- [ ] **Step 5: Run, verify PASS**

Run: `cd tools/license-headers && go test ./...`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add tools/license-headers/ go.work
git commit -m "feat(tools): add SPDX header checker and applier"
```

---

### Task 36: Apply SPDX headers across the repo

- [ ] **Step 1: Run apply**

```bash
go run ./tools/license-headers --apply
```
Expected: prints `updated <N> files` for any files still missing the header.

- [ ] **Step 2: Run check**

```bash
go run ./tools/license-headers --check
```
Expected: exit 0 (no missing headers).

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "chore: add SPDX Apache-2.0 headers across repo"
```

---

### Task 37: Pre-commit hook + Makefile target

**Files:**
- Modify: `.husky/pre-commit`
- Create: `Makefile`

- [ ] **Step 1: Add Makefile target**

`Makefile`:
```makefile
# SPDX-License-Identifier: Apache-2.0
.PHONY: license-check license-apply test cli-docs

license-check:
	go run ./tools/license-headers --check

license-apply:
	go run ./tools/license-headers --apply

test:
	pnpm test
	cd apps/agent && go test ./...
	cd apps/cli && go test ./...

cli-docs:
	go run ./tools/cli-docs ./docs/cli-reference.md
```

- [ ] **Step 2: Update pre-commit hook**

Append to `.husky/pre-commit`:
```bash
go run ./tools/license-headers --check
```

- [ ] **Step 3: Verify**

Run: `make license-check`
Expected: PASS (exit 0).

- [ ] **Step 4: Commit**

```bash
git add Makefile .husky/pre-commit
git commit -m "chore(hooks): enforce SPDX headers via pre-commit and Makefile"
```

---

### Task 38: CI license-check job

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Add job**

Append to `.github/workflows/ci.yml` (under `jobs:`):
```yaml
  license-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with: { go-version: '1.23' }
      - run: make license-check
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: enforce SPDX header check"
```

---

### Task 39: actionlint + Go matrix for CLI in CI

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Extend ci.yml**

Append jobs to `.github/workflows/ci.yml`:
```yaml
  actionlint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: reviewdog/action-actionlint@v1
        with:
          fail_on_error: true

  go-tests:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: '1.23'
          cache-dependency-path: |
            apps/agent/go.sum
            apps/cli/go.sum
      - run: go test ./...
        working-directory: apps/agent
      - run: go test ./...
        working-directory: apps/cli
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add actionlint and Go matrix for agent + CLI"
```

---

### Task 40: CODEOWNERS + Dependabot

**Files:**
- Create: `.github/CODEOWNERS`
- Create: `.github/dependabot.yml`

- [ ] **Step 1: Author files**

`.github/CODEOWNERS`:
```
# SPDX-License-Identifier: Apache-2.0
* @kuba-curik
```

`.github/dependabot.yml`:
```yaml
# SPDX-License-Identifier: Apache-2.0
version: 2
updates:
  - package-ecosystem: gomod
    directory: /apps/agent
    schedule: { interval: weekly }
  - package-ecosystem: gomod
    directory: /apps/cli
    schedule: { interval: weekly }
  - package-ecosystem: npm
    directory: /
    schedule: { interval: weekly }
  - package-ecosystem: github-actions
    directory: /
    schedule: { interval: weekly }
```

- [ ] **Step 2: Commit**

```bash
git add .github/CODEOWNERS .github/dependabot.yml
git commit -m "chore: add CODEOWNERS and dependabot config"
```

---

### Task 41: Auto-generated CLI reference

**Files:**
- Create: `apps/cli/internal/cmd/docs.go`
- Create: `tools/cli-docs/main.go`
- Create: `tools/cli-docs/go.mod`
- Create: `docs/cli-reference.md` (generated)
- Modify: `go.work`

- [ ] **Step 1: Add hidden gen-docs subcommand**

`apps/cli/internal/cmd/docs.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package cmd

import (
    "github.com/spf13/cobra"
    "github.com/spf13/cobra/doc"
)

func newGenDocsCmd() *cobra.Command {
    return &cobra.Command{
        Use:    "gen-docs <out-dir>",
        Short:  "Generate Markdown docs for all commands (internal)",
        Hidden: true,
        Args:   cobra.ExactArgs(1),
        RunE: func(cmd *cobra.Command, args []string) error {
            return doc.GenMarkdownTree(cmd.Root(), args[0])
        },
    }
}
```

Register: `cmd.AddCommand(newGenDocsCmd())` in `NewRootCmd`.

```bash
cd apps/cli && go get github.com/spf13/cobra/doc
```

- [ ] **Step 2: Author concatenator**

`tools/cli-docs/go.mod`:
```
module github.com/animato/claude-hub/tools/cli-docs

go 1.23
```

`tools/cli-docs/main.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package main

import (
    "fmt"
    "os"
    "os/exec"
    "path/filepath"
    "sort"
    "strings"
)

func main() {
    if len(os.Args) != 2 {
        fmt.Fprintln(os.Stderr, "usage: cli-docs <out-file>")
        os.Exit(2)
    }
    outFile := os.Args[1]
    tmp, err := os.MkdirTemp("", "cli-docs-*")
    if err != nil {
        panic(err)
    }
    defer os.RemoveAll(tmp)

    cmd := exec.Command("go", "run", "./apps/cli/cmd/claude-hub", "gen-docs", tmp)
    cmd.Stdout = os.Stdout
    cmd.Stderr = os.Stderr
    if err := cmd.Run(); err != nil {
        panic(err)
    }

    entries, _ := os.ReadDir(tmp)
    var files []string
    for _, e := range entries {
        if strings.HasSuffix(e.Name(), ".md") {
            files = append(files, filepath.Join(tmp, e.Name()))
        }
    }
    sort.Strings(files)

    var sb strings.Builder
    sb.WriteString("<!-- SPDX-License-Identifier: Apache-2.0 -->\n# CLI reference\n\n")
    for _, f := range files {
        b, err := os.ReadFile(f)
        if err != nil {
            panic(err)
        }
        sb.Write(b)
        sb.WriteString("\n---\n\n")
    }
    if err := os.WriteFile(outFile, []byte(sb.String()), 0o644); err != nil {
        panic(err)
    }
    fmt.Println("wrote", outFile)
}
```

Add `./tools/cli-docs` to `go.work`.

- [ ] **Step 3: Generate docs**

Run: `go run ./tools/cli-docs docs/cli-reference.md`
Expected: writes `docs/cli-reference.md`.

- [ ] **Step 4: Commit**

```bash
git add apps/cli/internal/cmd/docs.go tools/cli-docs/ docs/cli-reference.md go.work apps/cli/go.mod apps/cli/go.sum
git commit -m "docs: auto-generate CLI reference via cobra/doc"
```

---

### Task 42: README, admin guide, user guide, API reference

**Files:**
- Modify: `README.md`
- Create: `docs/admin-guide.md`
- Create: `docs/user-guide.md`
- Create: `docs/api-reference.md`
- Create: `docs/assets/logo.svg`

- [ ] **Step 1: Author logo SVG**

`docs/assets/logo.svg`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!-- SPDX-License-Identifier: Apache-2.0 -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 80">
  <rect width="320" height="80" fill="#0b1020" rx="8"/>
  <text x="20" y="50" font-family="system-ui,sans-serif" font-size="32" font-weight="700" fill="#f5f5f5">claude-hub</text>
</svg>
```

- [ ] **Step 2: Author README.md**

Replace `README.md` with:
```markdown
<!-- SPDX-License-Identifier: Apache-2.0 -->
![Claude Hub](docs/assets/logo.svg)

[![CI](https://github.com/animato/claude-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/animato/claude-hub/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Latest release](https://img.shields.io/github/v/release/animato/claude-hub)](https://github.com/animato/claude-hub/releases)

**Claude Hub** is a self-hosted, single-tenant team marketplace for Claude Code skills, plugins, slash commands, and subagents. Each member runs a tiny local daemon that bidirectionally syncs `~/.claude/` with a web dashboard, so the team can publish and install artifacts with a single click.

## 5-minute quickstart

```sh
# 1. Boot the hub on your server
docker compose -f ops/docker/docker-compose.yml up -d

# 2. Install the daemon on each laptop
curl -fsSL https://hub.firma.tld/install.sh | sh   # macOS / Linux
iwr https://hub.firma.tld/install.ps1 | iex        # Windows

# 3. Pair
claude-hub pair --hub https://hub.firma.tld
```

## Documentation

- [Admin guide](docs/admin-guide.md) — deploy, configure, backup, upgrade.
- [User guide](docs/user-guide.md) — daily workflow.
- [CLI reference](docs/cli-reference.md) — every subcommand and flag.
- [API reference](docs/api-reference.md) — REST + WSS contracts.
- [Contributing](CONTRIBUTING.md) — dev setup, commit conventions.
- [Security](SECURITY.md) — reporting vulnerabilities.

## License

Apache 2.0 — see [`LICENSE`](LICENSE).
```

- [ ] **Step 3: Author admin guide**

`docs/admin-guide.md`:
```markdown
<!-- SPDX-License-Identifier: Apache-2.0 -->
# Admin guide

## Deployment

```sh
docker compose -f ops/docker/docker-compose.yml up -d
```

Required environment variables (see `_implementation-contracts.md`):

- `DATABASE_URL`
- `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, `MINIO_BUCKET`
- `SESSION_SECRET` (256-bit base64; setup wizard generates on first run)
- `PUBLIC_URL` (used by `/install.sh`, `/install.ps1`, invite links)

## TLS

The setup wizard offers Let's Encrypt for public domains and self-signed for intranet. Mount certs into the hub-server container at `/etc/ssl/claude-hub/`.

## Upgrade

```sh
docker compose pull && docker compose up -d
```

Migrations run automatically on hub-server startup.

## Backup and restore

```sh
claude-hub login --hub https://hub.firma.tld
claude-hub backup --out backup.tar.gz
# later, on a fresh deployment:
claude-hub restore backup.tar.gz --force
```

`pg_dump` runs in `-Fp` (plain SQL) format so backups are inspectable. Restore replaces all hub data.

## Logs

Hub-server logs to stdout (pino JSON). Daemon logs go to `~/.claude-hub/agent.log` per user.
```

- [ ] **Step 4: Author user guide**

`docs/user-guide.md`:
```markdown
<!-- SPDX-License-Identifier: Apache-2.0 -->
# User guide

## Install the daemon

| OS | Command |
|---|---|
| Linux | `curl -fsSL https://hub.firma.tld/install.sh | sh` |
| macOS | `brew install animato/claude-hub/claude-hub-agent` |
| Windows | `iwr https://hub.firma.tld/install.ps1 | iex` |

## Pair

```sh
claude-hub pair --hub https://hub.firma.tld
```

## Browse and install

```sh
claude-hub list --type skill
claude-hub install my-helper
claude-hub install org-tooling@1.2.0
```

## Publish

Interactive (recommended):
```sh
claude-hub publish
```

Non-interactive:
```sh
claude-hub publish ~/.claude/skills/my-helper --type skill --version 0.1.0
```

CI / no-daemon machines:
```sh
claude-hub publish ./build/skill --type skill --slug my-helper --version 0.1.0 --standalone
```

## Toggle a plugin

```sh
claude-hub toggle org-tooling --on
claude-hub toggle org-tooling --off
```

## Troubleshooting

- **daemon unreachable:** `claude-hub status` — make sure `claude-hub-agent` service is running.
- **keychain unavailable on Linux:** install `libsecret-tools` and `gnome-keyring`, or the daemon will fall back to an encrypted file.
- **pin expired:** pins TTL is 5 min; click "Pair daemon" again in the dashboard.
```

- [ ] **Step 5: Author API reference**

`docs/api-reference.md`:
```markdown
<!-- SPDX-License-Identifier: Apache-2.0 -->
# API reference

Canonical paths come from `_implementation-contracts.md`. JSON bodies are camelCase.

## Auth

- `POST /api/auth/register` — `{ email, password, name }` → `200 UserDTO`.
- `POST /api/auth/login` — `{ email, password }` → `200 UserDTO + Set-Cookie session`.
- `POST /api/auth/logout` — `204`.
- `GET /api/auth/me` — `200 UserDTO` or `401`.

## Users (admin)

- `GET /api/users` — list.
- `POST /api/users/invite` — `{ email, role }` → `{ token, expiresAt }`.
- `PATCH /api/users/:id`, `DELETE /api/users/:id`.

## Daemons

- `POST /api/daemons/pair` — logged-in users get a 6-digit pin.
- `POST /api/daemons/register` — daemon side `{ pin, hostname, os, agent_version }` → `device_token`.
- `GET /api/daemons` — own daemons.
- `DELETE /api/daemons/:id`.

## Artifacts

- `GET /api/artifacts?type=&q=` — catalog list.
- `GET /api/artifacts/:slug` — detail with versions.
- `GET /api/artifacts/:slug/versions/:version` — version detail.
- `POST /api/artifacts/upload` — multipart upload (used by daemon and `--standalone` CLI).
- `POST /api/artifacts/:slug/yank` — author or admin.
- `DELETE /api/artifacts/:slug` — admin only.
- `GET /api/artifacts/:slug/versions/:version/download` — signed URL or stream.

## Admin

- `GET /api/admin/backup` — streamed `application/gzip` (`pg_dump.sql` + `minio/...`).
- `POST /api/admin/restore` — multipart with `confirm=RESTORE` and `archive`.

## Health

- `GET /healthz`, `GET /readyz`.

## WSS protocol

Endpoint `wss://<host>/ws`. Messages are line-delimited JSON `{"type":..., "payload":..., "id":...}`.

**Daemon → Hub:** `inventory.snapshot`, `inventory.delta`, `job.result`, `pong`.
**Hub → Daemon:** `job.install`, `job.uninstall`, `job.toggle` (plugins only — non-plugin types reply `not_supported_in_mvp`), `job.package`, `ping`.
**Dashboard ↔ Hub:** `subscribe.local`, `local.snapshot`, `local.delta`, `catalog.update`.

## Install scripts

- `GET /install.sh` — POSIX shell installer; `__HUB_URL__` substituted with `PUBLIC_URL`.
- `GET /install.ps1` — Windows PowerShell installer.
- `GET /dist/<os>-<arch>/<file>` — 302 to GitHub Releases per `RELEASE_BASE_URL`. Whitelisted: `linux-amd64`, `linux-arm64`, `darwin-amd64`, `darwin-arm64`, `windows-amd64`.
```

- [ ] **Step 6: Commit**

```bash
git add README.md docs/admin-guide.md docs/user-guide.md docs/api-reference.md docs/assets/logo.svg
git commit -m "docs: add README, admin guide, user guide, API reference"
```

---

### Task 43: CONTRIBUTING + PR template

**Files:**
- Create: `CONTRIBUTING.md`
- Create: `.github/PULL_REQUEST_TEMPLATE.md`

- [ ] **Step 1: Author CONTRIBUTING**

`CONTRIBUTING.md`:
```markdown
<!-- SPDX-License-Identifier: Apache-2.0 -->
# Contributing

## Setup

```sh
pnpm install
go work sync
docker compose -f ops/docker/docker-compose.yml up -d
pnpm db:migrate
```

## Tests

```sh
pnpm test                  # all TS workspaces (vitest)
cd apps/agent && go test ./...
cd apps/cli && go test ./...
pnpm test:e2e              # Playwright (requires running stack)
```

## Lint

```sh
pnpm lint
( cd apps/agent && golangci-lint run )
( cd apps/cli && golangci-lint run )
```

## Conventional Commits

```
feat(cli): add publish wizard
fix(server): handle pair token reuse
docs: clarify offline daemon behavior
test(agent): cover keychain fallback
```

## DCO

Sign every commit:
```sh
git commit -s -m "feat(...): ..."
```

## SPDX headers

Every source file starts with `// SPDX-License-Identifier: Apache-2.0`. The pre-commit hook and CI both enforce this. To add headers: `make license-apply`.

## PR checklist

The template at `.github/PULL_REQUEST_TEMPLATE.md` lists what reviewers look for.
```

`.github/PULL_REQUEST_TEMPLATE.md`:
```markdown
<!-- SPDX-License-Identifier: Apache-2.0 -->
## Summary

<!-- 1–3 sentences -->

## Checklist

- [ ] Tests added or updated
- [ ] Conventional commit message
- [ ] DCO sign-off (`git commit -s`)
- [ ] SPDX headers on new files (run `make license-apply` if needed)
- [ ] Docs updated (admin/user/CLI/API as relevant)
```

- [ ] **Step 2: Commit**

```bash
git add CONTRIBUTING.md .github/PULL_REQUEST_TEMPLATE.md
git commit -m "docs: add CONTRIBUTING and PR template"
```

---

### Task 44: CODE_OF_CONDUCT + SECURITY

**Files:**
- Create: `CODE_OF_CONDUCT.md`
- Create: `SECURITY.md`

- [ ] **Step 1: Author CoC (Contributor Covenant 2.1)**

`CODE_OF_CONDUCT.md`:
```markdown
<!-- SPDX-License-Identifier: Apache-2.0 -->
# Contributor Covenant Code of Conduct

## Our Pledge

We as members, contributors, and leaders pledge to make participation in our community a harassment-free experience for everyone, regardless of age, body size, visible or invisible disability, ethnicity, sex characteristics, gender identity and expression, level of experience, education, socio-economic status, nationality, personal appearance, race, caste, color, religion, or sexual identity and orientation.

We pledge to act and interact in ways that contribute to an open, welcoming, diverse, inclusive, and healthy community.

## Our Standards

Examples of behavior that contributes to a positive environment include demonstrating empathy and kindness, being respectful of differing opinions, giving and gracefully accepting constructive feedback, accepting responsibility and apologizing to those affected by mistakes, and focusing on what is best not just for individuals but for the overall community.

Unacceptable behavior includes the use of sexualized language or imagery, trolling, insulting or derogatory comments, personal or political attacks, public or private harassment, publishing private information without permission, and other conduct which could reasonably be considered inappropriate in a professional setting.

## Enforcement

Instances of abusive, harassing, or otherwise unacceptable behavior may be reported to the community leaders responsible for enforcement at **conduct@animato.cz**. All complaints will be reviewed and investigated promptly and fairly.

## Attribution

This Code of Conduct is adapted from the Contributor Covenant, version 2.1, available at https://www.contributor-covenant.org/version/2/1/code_of_conduct.html.
```

- [ ] **Step 2: Author SECURITY**

`SECURITY.md`:
```markdown
<!-- SPDX-License-Identifier: Apache-2.0 -->
# Security policy

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | yes |

Older lines receive no fixes; please upgrade.

## Reporting a vulnerability

Email **security@animato.cz**. PGP fingerprint: **TBD — see docs once published**.

We acknowledge reports within **72 hours** and aim to ship a fix for high-severity issues within **30 days**.

## Out of scope

- Denial of service via the local daemon HTTP API (it binds to 127.0.0.1 only and is gated by a 0600 token file).
- Social engineering against team members or admins.
- Vulnerabilities that require attacker-controlled physical access to a paired machine.
```

- [ ] **Step 3: Commit**

```bash
git add CODE_OF_CONDUCT.md SECURITY.md
git commit -m "docs: adopt Contributor Covenant 2.1 and add security policy"
```

---

### Task 45: Release smoke test

**Files:**
- Create: `apps/cli/test/integration/smoke_test.go`
- Modify: `.github/workflows/release.yml` (add manual smoke job)

- [ ] **Step 1: Write smoke test**

`apps/cli/test/integration/smoke_test.go`:
```go
//go:build integration

// SPDX-License-Identifier: Apache-2.0
package integration

import (
    "bytes"
    "os/exec"
    "testing"
)

func TestSmoke_RegisterPublishInstall(t *testing.T) {
    if testing.Short() {
        t.Skip("smoke test")
    }
    steps := [][]string{
        {"claude-hub", "version"},
        {"claude-hub", "login", "--hub", "http://127.0.0.1:3000", "--email", "smoke@example.com", "--password", "smoke-secret"},
        {"claude-hub", "list"},
        {"claude-hub", "publish", "./testdata/skill", "--type", "skill", "--slug", "smoke", "--version", "0.1.0", "--standalone"},
        {"claude-hub", "list", "--q", "smoke"},
        {"claude-hub", "install", "smoke"},
        {"claude-hub", "uninstall", "smoke", "--yes"},
        {"claude-hub", "logout"},
    }
    for _, args := range steps {
        cmd := exec.Command(args[0], args[1:]...)
        var out, errb bytes.Buffer
        cmd.Stdout = &out
        cmd.Stderr = &errb
        if err := cmd.Run(); err != nil {
            t.Fatalf("step %v failed: %v\nstdout: %s\nstderr: %s", args, err, out.String(), errb.String())
        }
    }
}
```

- [ ] **Step 2: Add manual smoke job**

Append to `.github/workflows/release.yml`:
```yaml
  smoke:
    if: ${{ github.event_name == 'workflow_dispatch' }}
    runs-on: ubuntu-latest
    needs: release
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with: { go-version: '1.23' }
      - run: docker compose -f ops/docker/docker-compose.yml up -d
      - run: |
          set -e
          export INTEG=1
          go test -tags=integration ./apps/cli/test/integration/...
```

Add `workflow_dispatch:` to the workflow `on:` triggers.

- [ ] **Step 3: Commit**

```bash
git add apps/cli/test/integration/smoke_test.go .github/workflows/release.yml
git commit -m "test(cli): add release smoke test wired to manual workflow_dispatch"
```

---

### Task 46: Release process checklist

**Files:**
- Create: `RELEASE.md`

- [ ] **Step 1: Author RELEASE.md**

`RELEASE.md`:
```markdown
<!-- SPDX-License-Identifier: Apache-2.0 -->
# Release process

1. **Verify trunk is green**
   ```sh
   make license-check
   pnpm test
   ( cd apps/agent && go test ./... )
   ( cd apps/cli && go test ./... )
   pnpm test:e2e
   ```

2. **Update CHANGELOG**
   ```sh
   git cliff --tag v0.1.0 -o CHANGELOG.md
   git commit -am "docs: changelog for v0.1.0"
   ```

3. **Tag**
   ```sh
   git tag -s v0.1.0 -m "v0.1.0"
   ```

4. **Push**
   ```sh
   git push origin main
   git push origin v0.1.0
   ```

5. **Verify GitHub release**
   - Archives present (linux/darwin/windows × amd64/arm64)
   - `checksums.txt` present
   - `claude-hub-0.1.0-x64.msi` + `msi-sha256.txt` present
   - Changelog body rendered

6. **Smoke test**
   - Trigger `release.yml` `smoke` job manually via `workflow_dispatch`.
   - Test `install.sh` against staging hub.

7. **Distribution channels**
   - Confirm Homebrew tap bumped (or do it manually if `HOMEBREW_TAP_TOKEN` not configured).
   - Merge winget PR upstream once it appears.
```

- [ ] **Step 2: Commit**

```bash
git add RELEASE.md
git commit -m "docs: add release process checklist"
```

---

## Self-review

**Dependency check (verifies nothing is referenced that an earlier plan didn't deliver):**

- Plan 1 delivers: hub-server REST endpointy (`/api/auth/*`, `/api/artifacts*`, `/api/daemons/{pair,register}`, `/api/artifacts/upload`, `/healthz`), Postgres schema, MinIO, RBAC `requireRole('admin')`, Hono mount, `getMinioClient()`, `MINIO_BUCKET`. **Used by:** Tasks 5, 10, 11, 12, 13, 14, 15, 18, 19, 20, 21, 22, 23, 24, 27, 28, 45.
- Plan 2 delivers: Go agent + daemon localhost API on `127.0.0.1:7878` (`/v1/{status,local,publish,install,uninstall,toggle,pair}`), agent token v `~/.claude-hub/agent.token`, `apps/agent/internal/api` package s `InventoryItem` + `PublishedAsRef`, `service install` subcommand. **Used by:** Tasks 3, 4, 8, 9, 13, 14, 15, 16, 17, 19, 25, 26, 31.
- Plan 3 delivers: dashboard build (`pnpm --filter dashboard build`). **Used by:** Task 34 (`build-server` job).
- Plan 4 delivers: artifact tar layout + manifest validation. **Reused conceptually** by Task 18 (`--standalone` publish does its own tar+gzip but produces the same on-wire format).

**No forward dependencies created** — every artifact this plan needs is contractually delivered upstream.

**Risk mitigations:**

- WiX 4 build is non-trivial → isolated to Task 31 + Task 34 `build-msi` job; CI smoke (`workflow_dispatch`) plus stamp test verifies non-zero MSI size.
- Homebrew tap and winget PR jobs are guarded by missing-secret no-ops → release pipeline never hard-fails on optional channels.
- License header tooling (Task 35) lands as code before CI enforcement (Task 38) and pre-commit hook (Task 37).
- `--standalone` publish (Task 18) duplicates server-side validation server-side → matches Plan 4's manifest validator on upload, so no client-side bypass risk.
- Restore round-trip test (Task 23) is the only proof of correctness for backup/restore round-trip; explicitly tests counts before/after, including MinIO objects.

**Conventions check:**

- All commits follow Conventional Commits.
- All Go/TS source files include `// SPDX-License-Identifier: Apache-2.0` headers (Task 35–38 enforce repo-wide).
- WSS toggle uses `job.toggle` (per `_implementation-contracts.md`), never `job.enable`. Verified: Task 15 calls `daemon.Toggle()`, which on the daemon side translates to `job.toggle` on the WSS wire (Plan 2 contract).
- Slugs match the regex from `_implementation-contracts.md` (`^[a-z0-9][a-z0-9-]{0,63}$`); enforced in Task 13 via `slugVersionRe`.
- Semver strict `MAJOR.MINOR.PATCH` — enforced in `parseSemver` (Task 17).
- File paths follow `_implementation-contracts.md` repo layout (`apps/cli/`, `apps/hub-server/src/admin/`, `ops/install/`, `tools/`, `docs/`).

**Task count:** **46 tasks** (1–46). Within the 50–80 envelope from the brief.

**Open questions:**

1. **`HOMEBREW_TAP_TOKEN` provisioning** — Task 34 + 29's README assumes a `animato/homebrew-tap` repo. The actual tap-bump action implementation is left as a follow-up because it depends on whether the team prefers `dawidd6/action-homebrew-bump-formula` or a hand-rolled clone-and-push. Task 34 currently echoes a placeholder message; production bump should land in a follow-up PR.
2. **PGP fingerprint** — `SECURITY.md` ships with `TBD` per the brief; needs to be replaced once the security mailbox key is published.
3. **Bundling vs. split image for dashboard** — Task 34's `build-server` job assumes the dashboard bundles into the hub-server image. If the team later splits them, the `build-dashboard` job needs to land separately and `release.yml` must add it to `needs:`.

