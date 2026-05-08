# Plan 2 — Daemon Foundation + Pairing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Postavit cross-platform Go daemon `claude-hub-agent`, který se přes 6-digit pin spáruje s hub-serverem, drží persistentní WSS spojení s ping/pong keepalive, a zobrazí se v dashboardu jako online/offline. Tím se zamkne kontrakt mezi daemonem a serverem pro Plan 3 (inventory + jobs).

**Architecture:** Go binary `apps/agent/` postavený na `kardianos/service` pro autostart na Win/Mac/Linux, `gorilla/websocket` pro WSS, `zalando/go-keyring` pro OS keychain (s file-encryption fallbackem na Linuxu bez libsecret), `zerolog` pro structured logging. Hub-server (Hono) získá `pairings` tabulku, `/api/daemons/*` endpointy, in-memory `Map<daemonId, WebSocket>` connection manager a Hono WebSocket handler na `/ws`. Dashboard dostane "Pair daemon" wizard a online/offline badge přes 5s HTTP polling.

**Tech Stack:** Go 1.23, `github.com/kardianos/service`, `github.com/gorilla/websocket`, `github.com/zalando/go-keyring`, `github.com/rs/zerolog`, `github.com/spf13/cobra`. Server: Hono `@hono/node-ws`, `drizzle-orm`, `nanoid` pro pin/token. Frontend: Next.js 14 App Router, shadcn/ui Dialog, TanStack Query.

---

## File Structure

**New files (Go agent — `apps/agent/`):**
- `go.mod`, `go.sum` — Go module `github.com/animato/claude-hub/agent`
- `cmd/claude-hub-agent/main.go` — entrypoint, cobra root
- `cmd/claude-hub-agent/run.go` — `run` subcommand (default, foreground)
- `cmd/claude-hub-agent/pair.go` — `pair --hub --pin` subcommand
- `cmd/claude-hub-agent/service.go` — `service install/uninstall/start/stop`
- `cmd/claude-hub-agent/status.go` — `status` subcommand
- `internal/config/config.go` — paths, env (`HUB_URL`, `AGENT_BIND_ADDR`, `CLAUDE_HOME`)
- `internal/storage/keychain/keychain.go` — interface `Store`
- `internal/storage/keychain/keyring_default.go` — `go-keyring` impl (build tag: not linux-no-libsecret)
- `internal/storage/keychain/file_fallback.go` — encrypted file impl (Linux fallback)
- `internal/storage/keychain/keychain_test.go`
- `internal/storage/agenttoken/token.go` — local API bearer token at `~/.claude-hub/agent.token` (mode 0600)
- `internal/api/local/server.go` — Hono-equivalent: `net/http` localhost server
- `internal/api/local/handlers.go` — `/v1/status`, `/v1/pair`
- `internal/api/local/middleware.go` — bearer auth, CORS deny
- `internal/api/local/server_test.go`
- `internal/wss/client.go` — persistent WSS, reconnect, keepalive
- `internal/wss/router.go` — message router (extensible for Plan 3)
- `internal/wss/messages.go` — JSON message structs (mirrors `packages/wss-protocol`)
- `internal/wss/client_test.go`
- `internal/manifest/parser.go` — interface `Parser` (skeleton, returns nil error)
- `internal/scanner/scanner.go` — interface `Scanner` (skeleton, returns `[]InventoryItem{}`)
- `internal/api/types.go` — Go mirror of `InventoryItem`, `DaemonOS`, etc.
- `internal/logging/logger.go` — zerolog setup, file + stderr
- `internal/runtime/runtime.go` — service.Service implementation glue

**New files (server — `apps/hub-server/`):**
- `src/routes/daemons.ts` — `/api/daemons/*` route handlers
- `src/routes/daemons.test.ts`
- `src/ws/server.ts` — Hono WebSocket upgrade, connection manager
- `src/ws/manager.ts` — `Map<daemonId, WebSocket>` + broadcast
- `src/ws/manager.test.ts`
- `src/ws/protocol.ts` — message types (re-export from `packages/wss-protocol`)
- `src/jobs/pairing-sweep.ts` — sweep expired pairings every 60s
- `src/jobs/pairing-sweep.test.ts`

**New files (shared — `packages/wss-protocol/`):**
- `package.json`
- `src/index.ts` — TypeScript message types (`PingMessage`, `PongMessage`, base `WSSMessage`)
- `schema/messages.json` — JSON Schema (used to gen Go types in Plan 3)

**Modified files (server):**
- `apps/hub-server/src/db/schema.ts` — add `daemons`, `pairings` tables
- `apps/hub-server/src/index.ts` — mount `/api/daemons/*`, `/ws`, start sweep job
- `ops/migrations/0002_daemons_pairings.sql` — new migration

**Modified files (dashboard — `apps/dashboard/`):**
- `src/components/daemon-status-banner.tsx` — "Daemon not paired" banner
- `src/components/pair-daemon-modal.tsx` — modal with pin + OS install instructions
- `src/components/daemon-status-badge.tsx` — online/offline pill
- `src/lib/api/daemons.ts` — typed fetchers for `/api/daemons/*`
- `src/app/(authed)/dashboard/page.tsx` — wire banner + badge
- `src/components/__tests__/pair-daemon-modal.test.tsx`

**New files (ops):**
- `ops/install/install.sh` — POSIX shell installer (functional, downloads release binary)
- `ops/install/install.ps1` — Windows PowerShell installer (functional)
- `ops/install/brew/claude-hub-agent.rb` — Homebrew formula
- `.github/workflows/agent-build.yml` — Go matrix build

---

## Konvence

- Po každém TDD cyklu nový commit. Žádný `--amend`.
- Žádné `--no-verify`. Hooky jsou součást kontraktu.
- SPDX header `// SPDX-License-Identifier: Apache-2.0` (Go) nebo `// SPDX-License-Identifier: Apache-2.0` (TS) na první řádce každého source souboru.
- Go testy běží přes `go test ./...` z `apps/agent/`. TS testy přes `pnpm --filter hub-server test` z root.
- `git add` jen explicitní cesty, nikdy `-A`.

---

### Task 1: Bootstrap Go module

**Files:**
- Create: `apps/agent/go.mod`
- Create: `apps/agent/go.sum`
- Create: `apps/agent/cmd/claude-hub-agent/main.go`
- Modify: `go.work` (add `./apps/agent`)

- [ ] **Step 1: Init Go module**

Run from `D:/Claude/hub/apps/agent/`:
```bash
go mod init github.com/animato/claude-hub/agent
go get github.com/spf13/cobra@v1.8.1
go get github.com/rs/zerolog@v1.33.0
go get github.com/kardianos/service@v1.2.2
go get github.com/gorilla/websocket@v1.5.3
go get github.com/zalando/go-keyring@v0.2.5
go get github.com/stretchr/testify@v1.9.0
go mod tidy
```

- [ ] **Step 2: Add module to go.work**

`D:/Claude/hub/go.work`:
```
go 1.23

use (
    ./apps/agent
)
```

- [ ] **Step 3: Create main.go (smoke entrypoint)**

`apps/agent/cmd/claude-hub-agent/main.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package main

import (
    "fmt"
    "os"
)

var version = "0.0.0-dev"

func main() {
    if err := newRootCmd().Execute(); err != nil {
        fmt.Fprintln(os.Stderr, err)
        os.Exit(1)
    }
}
```

- [ ] **Step 4: Verify build**

Run: `cd apps/agent && go build ./cmd/claude-hub-agent`
Expected: error "newRootCmd undefined" — that's fine, next task adds it.

- [ ] **Step 5: Commit**

```bash
git add apps/agent/go.mod apps/agent/go.sum apps/agent/cmd/claude-hub-agent/main.go go.work
git commit -m "chore(agent): bootstrap go module and entrypoint"
```

---

### Task 2: Cobra root command + version

**Files:**
- Create: `apps/agent/cmd/claude-hub-agent/root.go`
- Create: `apps/agent/cmd/claude-hub-agent/root_test.go`

- [ ] **Step 1: Write failing test**

`apps/agent/cmd/claude-hub-agent/root_test.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package main

import (
    "bytes"
    "testing"

    "github.com/stretchr/testify/require"
)

func TestRootHelpListsSubcommands(t *testing.T) {
    cmd := newRootCmd()
    var out bytes.Buffer
    cmd.SetOut(&out)
    cmd.SetArgs([]string{"--help"})
    require.NoError(t, cmd.Execute())
    s := out.String()
    require.Contains(t, s, "run")
    require.Contains(t, s, "pair")
    require.Contains(t, s, "service")
    require.Contains(t, s, "status")
}
```

- [ ] **Step 2: Run test (should fail)**

Run: `cd apps/agent && go test ./cmd/claude-hub-agent/ -run TestRootHelp`
Expected: FAIL — `newRootCmd` undefined.

- [ ] **Step 3: Implement root**

`apps/agent/cmd/claude-hub-agent/root.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package main

import "github.com/spf13/cobra"

func newRootCmd() *cobra.Command {
    cmd := &cobra.Command{
        Use:     "claude-hub-agent",
        Short:   "Claude Hub local daemon",
        Version: version,
    }
    cmd.AddCommand(newRunCmd(), newPairCmd(), newServiceCmd(), newStatusCmd())
    return cmd
}
```

Stub the four subcommand constructors in their own files now, each returning a no-op `cobra.Command`:

`apps/agent/cmd/claude-hub-agent/run.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package main

import "github.com/spf13/cobra"

func newRunCmd() *cobra.Command {
    return &cobra.Command{Use: "run", Short: "Run the agent in the foreground"}
}
```

Repeat the same shape for `pair.go` (`newPairCmd`), `service.go` (`newServiceCmd`), `status.go` (`newStatusCmd`).

- [ ] **Step 4: Test passes**

Run: `cd apps/agent && go test ./cmd/claude-hub-agent/ -run TestRootHelp -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/agent/cmd/claude-hub-agent/root.go apps/agent/cmd/claude-hub-agent/root_test.go apps/agent/cmd/claude-hub-agent/run.go apps/agent/cmd/claude-hub-agent/pair.go apps/agent/cmd/claude-hub-agent/service.go apps/agent/cmd/claude-hub-agent/status.go
git commit -m "feat(agent): add cobra root command with subcommand stubs"
```

---

### Task 3: Config & paths

**Files:**
- Create: `apps/agent/internal/config/config.go`
- Create: `apps/agent/internal/config/config_test.go`

- [ ] **Step 1: Write failing test**

`apps/agent/internal/config/config_test.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package config

import (
    "path/filepath"
    "testing"

    "github.com/stretchr/testify/require"
)

func TestLoadDefaults(t *testing.T) {
    t.Setenv("HUB_URL", "")
    t.Setenv("AGENT_BIND_ADDR", "")
    t.Setenv("CLAUDE_HOME", "")
    t.Setenv("HOME", "/tmp/fakehome")
    cfg, err := Load()
    require.NoError(t, err)
    require.Equal(t, "127.0.0.1:7878", cfg.LocalBindAddr)
    require.Equal(t, filepath.Join("/tmp/fakehome", ".claude"), cfg.ClaudeHome)
    require.Equal(t, filepath.Join("/tmp/fakehome", ".claude-hub"), cfg.HubDataDir)
}

func TestLoadOverridesFromEnv(t *testing.T) {
    t.Setenv("HUB_URL", "https://hub.example.com")
    t.Setenv("AGENT_BIND_ADDR", "127.0.0.1:9999")
    t.Setenv("CLAUDE_HOME", "/custom/claude")
    t.Setenv("HOME", "/tmp/fakehome")
    cfg, err := Load()
    require.NoError(t, err)
    require.Equal(t, "https://hub.example.com", cfg.HubURL)
    require.Equal(t, "127.0.0.1:9999", cfg.LocalBindAddr)
    require.Equal(t, "/custom/claude", cfg.ClaudeHome)
}
```

- [ ] **Step 2: Run test (FAIL)**

Run: `cd apps/agent && go test ./internal/config/`
Expected: FAIL — package does not exist.

- [ ] **Step 3: Implement Load()**

`apps/agent/internal/config/config.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package config

import (
    "os"
    "path/filepath"
)

type Config struct {
    HubURL        string
    LocalBindAddr string
    ClaudeHome    string
    HubDataDir    string
    LogFile       string
    TokenFile     string
}

func Load() (*Config, error) {
    home, err := userHome()
    if err != nil {
        return nil, err
    }
    cfg := &Config{
        HubURL:        os.Getenv("HUB_URL"),
        LocalBindAddr: envOr("AGENT_BIND_ADDR", "127.0.0.1:7878"),
        ClaudeHome:    envOr("CLAUDE_HOME", filepath.Join(home, ".claude")),
        HubDataDir:    filepath.Join(home, ".claude-hub"),
    }
    cfg.LogFile = filepath.Join(cfg.HubDataDir, "agent.log")
    cfg.TokenFile = filepath.Join(cfg.HubDataDir, "agent.token")
    return cfg, nil
}

func envOr(k, def string) string {
    if v := os.Getenv(k); v != "" {
        return v
    }
    return def
}

func userHome() (string, error) {
    if h := os.Getenv("HOME"); h != "" {
        return h, nil
    }
    return os.UserHomeDir()
}
```

- [ ] **Step 4: Test passes**

Run: `cd apps/agent && go test ./internal/config/ -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/agent/internal/config/
git commit -m "feat(agent): add config loader with env overrides"
```

---

### Task 4: Structured logging

**Files:**
- Create: `apps/agent/internal/logging/logger.go`
- Create: `apps/agent/internal/logging/logger_test.go`

- [ ] **Step 1: Failing test**

`apps/agent/internal/logging/logger_test.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package logging

import (
    "bytes"
    "testing"

    "github.com/stretchr/testify/require"
)

func TestNewWritesJSONToBoth(t *testing.T) {
    var fileBuf, stderrBuf bytes.Buffer
    log := New(&fileBuf, &stderrBuf, "info")
    log.Info().Str("evt", "hello").Msg("test")
    require.Contains(t, fileBuf.String(), `"evt":"hello"`)
    require.Contains(t, stderrBuf.String(), `"evt":"hello"`)
}
```

- [ ] **Step 2: Run (FAIL)**

Run: `cd apps/agent && go test ./internal/logging/`
Expected: FAIL.

- [ ] **Step 3: Implement**

`apps/agent/internal/logging/logger.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package logging

import (
    "io"

    "github.com/rs/zerolog"
)

func New(fileW, stderrW io.Writer, level string) zerolog.Logger {
    lvl, err := zerolog.ParseLevel(level)
    if err != nil || lvl == zerolog.NoLevel {
        lvl = zerolog.InfoLevel
    }
    mw := zerolog.MultiLevelWriter(fileW, stderrW)
    return zerolog.New(mw).Level(lvl).With().Timestamp().Logger()
}
```

- [ ] **Step 4: PASS**

Run: `cd apps/agent && go test ./internal/logging/ -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/agent/internal/logging/
git commit -m "feat(agent): structured zerolog logging to file + stderr"
```

---

### Task 5: Keychain abstraction (interface + go-keyring impl)

**Files:**
- Create: `apps/agent/internal/storage/keychain/keychain.go`
- Create: `apps/agent/internal/storage/keychain/keyring_default.go`
- Create: `apps/agent/internal/storage/keychain/keychain_test.go`

- [ ] **Step 1: Failing test using mock keyring**

`apps/agent/internal/storage/keychain/keychain_test.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package keychain

import (
    "testing"

    "github.com/stretchr/testify/require"
    "github.com/zalando/go-keyring"
)

func TestKeyringStoreSetGetDelete(t *testing.T) {
    keyring.MockInit()
    s := &KeyringStore{Service: "claude-hub-agent-test"}
    require.NoError(t, s.Set("device_token", "abc123"))
    got, err := s.Get("device_token")
    require.NoError(t, err)
    require.Equal(t, "abc123", got)
    require.NoError(t, s.Delete("device_token"))
    _, err = s.Get("device_token")
    require.ErrorIs(t, err, ErrNotFound)
}
```

- [ ] **Step 2: Run (FAIL)**

Run: `cd apps/agent && go test ./internal/storage/keychain/`
Expected: FAIL.

- [ ] **Step 3: Implement interface + keyring impl**

`apps/agent/internal/storage/keychain/keychain.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package keychain

import "errors"

var ErrNotFound = errors.New("keychain: secret not found")

type Store interface {
    Set(key, value string) error
    Get(key string) (string, error)
    Delete(key string) error
}
```

`apps/agent/internal/storage/keychain/keyring_default.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package keychain

import (
    "errors"

    "github.com/zalando/go-keyring"
)

type KeyringStore struct {
    Service string
}

func (k *KeyringStore) Set(key, value string) error {
    return keyring.Set(k.Service, key, value)
}

func (k *KeyringStore) Get(key string) (string, error) {
    v, err := keyring.Get(k.Service, key)
    if errors.Is(err, keyring.ErrNotFound) {
        return "", ErrNotFound
    }
    return v, err
}

func (k *KeyringStore) Delete(key string) error {
    err := keyring.Delete(k.Service, key)
    if errors.Is(err, keyring.ErrNotFound) {
        return ErrNotFound
    }
    return err
}
```

- [ ] **Step 4: PASS**

Run: `cd apps/agent && go test ./internal/storage/keychain/ -v -run TestKeyringStore`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/agent/internal/storage/keychain/keychain.go apps/agent/internal/storage/keychain/keyring_default.go apps/agent/internal/storage/keychain/keychain_test.go
git commit -m "feat(agent): keychain Store interface backed by go-keyring"
```

---

### Task 6: Encrypted file fallback for keychain

**Files:**
- Create: `apps/agent/internal/storage/keychain/file_fallback.go`
- Modify: `apps/agent/internal/storage/keychain/keychain_test.go`

- [ ] **Step 1: Failing test**

Append to `apps/agent/internal/storage/keychain/keychain_test.go`:
```go
func TestFileStoreSetGetDelete(t *testing.T) {
    dir := t.TempDir()
    s, err := NewFileStore(dir+"/cred.enc", []byte("0123456789abcdef0123456789abcdef"))
    require.NoError(t, err)
    require.NoError(t, s.Set("device_token", "tok-xyz"))

    s2, err := NewFileStore(dir+"/cred.enc", []byte("0123456789abcdef0123456789abcdef"))
    require.NoError(t, err)
    got, err := s2.Get("device_token")
    require.NoError(t, err)
    require.Equal(t, "tok-xyz", got)

    require.NoError(t, s2.Delete("device_token"))
    _, err = s2.Get("device_token")
    require.ErrorIs(t, err, ErrNotFound)
}
```

- [ ] **Step 2: Run (FAIL)**

Run: `cd apps/agent && go test ./internal/storage/keychain/ -run TestFileStore`
Expected: FAIL — `NewFileStore` undefined.

- [ ] **Step 3: Implement file fallback (AES-GCM)**

`apps/agent/internal/storage/keychain/file_fallback.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package keychain

import (
    "crypto/aes"
    "crypto/cipher"
    "crypto/rand"
    "encoding/json"
    "errors"
    "io"
    "os"
    "sync"
)

type FileStore struct {
    path string
    key  []byte
    mu   sync.Mutex
}

func NewFileStore(path string, key []byte) (*FileStore, error) {
    if len(key) != 32 {
        return nil, errors.New("keychain: file fallback requires 32-byte key")
    }
    return &FileStore{path: path, key: key}, nil
}

func (f *FileStore) load() (map[string]string, error) {
    f.mu.Lock()
    defer f.mu.Unlock()
    data, err := os.ReadFile(f.path)
    if errors.Is(err, os.ErrNotExist) {
        return map[string]string{}, nil
    }
    if err != nil {
        return nil, err
    }
    block, err := aes.NewCipher(f.key)
    if err != nil {
        return nil, err
    }
    gcm, err := cipher.NewGCM(block)
    if err != nil {
        return nil, err
    }
    if len(data) < gcm.NonceSize() {
        return nil, errors.New("keychain: file ciphertext too short")
    }
    nonce, ct := data[:gcm.NonceSize()], data[gcm.NonceSize():]
    pt, err := gcm.Open(nil, nonce, ct, nil)
    if err != nil {
        return nil, err
    }
    m := map[string]string{}
    if err := json.Unmarshal(pt, &m); err != nil {
        return nil, err
    }
    return m, nil
}

func (f *FileStore) save(m map[string]string) error {
    f.mu.Lock()
    defer f.mu.Unlock()
    pt, err := json.Marshal(m)
    if err != nil {
        return err
    }
    block, err := aes.NewCipher(f.key)
    if err != nil {
        return err
    }
    gcm, err := cipher.NewGCM(block)
    if err != nil {
        return err
    }
    nonce := make([]byte, gcm.NonceSize())
    if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
        return err
    }
    ct := gcm.Seal(nonce, nonce, pt, nil)
    return os.WriteFile(f.path, ct, 0o600)
}

func (f *FileStore) Set(k, v string) error {
    m, err := f.load()
    if err != nil {
        return err
    }
    m[k] = v
    return f.save(m)
}

func (f *FileStore) Get(k string) (string, error) {
    m, err := f.load()
    if err != nil {
        return "", err
    }
    v, ok := m[k]
    if !ok {
        return "", ErrNotFound
    }
    return v, nil
}

func (f *FileStore) Delete(k string) error {
    m, err := f.load()
    if err != nil {
        return err
    }
    if _, ok := m[k]; !ok {
        return ErrNotFound
    }
    delete(m, k)
    return f.save(m)
}
```

- [ ] **Step 4: PASS**

Run: `cd apps/agent && go test ./internal/storage/keychain/ -v`
Expected: both `TestKeyringStore...` and `TestFileStore...` PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/agent/internal/storage/keychain/file_fallback.go apps/agent/internal/storage/keychain/keychain_test.go
git commit -m "feat(agent): AES-GCM encrypted file fallback for keychain"
```

---

### Task 7: Local API bearer token file

**Files:**
- Create: `apps/agent/internal/storage/agenttoken/token.go`
- Create: `apps/agent/internal/storage/agenttoken/token_test.go`

- [ ] **Step 1: Failing test**

`apps/agent/internal/storage/agenttoken/token_test.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package agenttoken

import (
    "os"
    "runtime"
    "testing"

    "github.com/stretchr/testify/require"
)

func TestEnsureCreatesTokenWithMode0600(t *testing.T) {
    dir := t.TempDir()
    path := dir + "/agent.token"
    tok, err := Ensure(path)
    require.NoError(t, err)
    require.Len(t, tok, 64)

    info, err := os.Stat(path)
    require.NoError(t, err)
    if runtime.GOOS != "windows" {
        require.Equal(t, os.FileMode(0o600), info.Mode().Perm())
    }
}

func TestEnsureReadsExistingToken(t *testing.T) {
    dir := t.TempDir()
    path := dir + "/agent.token"
    a, err := Ensure(path)
    require.NoError(t, err)
    b, err := Ensure(path)
    require.NoError(t, err)
    require.Equal(t, a, b)
}
```

- [ ] **Step 2: Run (FAIL)**

Run: `cd apps/agent && go test ./internal/storage/agenttoken/`
Expected: FAIL.

- [ ] **Step 3: Implement**

`apps/agent/internal/storage/agenttoken/token.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package agenttoken

import (
    "crypto/rand"
    "encoding/hex"
    "errors"
    "os"
    "path/filepath"
)

func Ensure(path string) (string, error) {
    if b, err := os.ReadFile(path); err == nil {
        return string(b), nil
    } else if !errors.Is(err, os.ErrNotExist) {
        return "", err
    }
    if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
        return "", err
    }
    raw := make([]byte, 32)
    if _, err := rand.Read(raw); err != nil {
        return "", err
    }
    tok := hex.EncodeToString(raw)
    if err := os.WriteFile(path, []byte(tok), 0o600); err != nil {
        return "", err
    }
    return tok, nil
}
```

- [ ] **Step 4: PASS**

Run: `cd apps/agent && go test ./internal/storage/agenttoken/ -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/agent/internal/storage/agenttoken/
git commit -m "feat(agent): generate and persist local API bearer token"
```

---

### Task 8: Inventory & manifest skeleton types

**Files:**
- Create: `apps/agent/internal/api/types.go`
- Create: `apps/agent/internal/scanner/scanner.go`
- Create: `apps/agent/internal/scanner/scanner_test.go`
- Create: `apps/agent/internal/manifest/parser.go`

- [ ] **Step 1: Failing test for scanner**

`apps/agent/internal/scanner/scanner_test.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package scanner

import (
    "testing"

    "github.com/stretchr/testify/require"
)

func TestNoopScannerReturnsEmpty(t *testing.T) {
    s := NewNoop()
    items, err := s.Scan(t.TempDir())
    require.NoError(t, err)
    require.Empty(t, items)
}
```

- [ ] **Step 2: Run (FAIL)**

Run: `cd apps/agent && go test ./internal/scanner/`
Expected: FAIL.

- [ ] **Step 3: Implement types + skeletons**

`apps/agent/internal/api/types.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package api

type ArtifactType string

const (
    ArtifactSkill   ArtifactType = "skill"
    ArtifactPlugin  ArtifactType = "plugin"
    ArtifactCommand ArtifactType = "command"
    ArtifactAgent   ArtifactType = "agent"
)

type PublishedAsRef struct {
    ArtifactID string `json:"artifactId"`
    Version    string `json:"version"`
}

type InventoryItem struct {
    Type        ArtifactType    `json:"type"`
    Slug        string          `json:"slug"`
    Version     string          `json:"version,omitempty"`
    Path        string          `json:"path"`
    Enabled     *bool           `json:"enabled,omitempty"`
    PublishedAs *PublishedAsRef `json:"publishedAs,omitempty"`
}

type DaemonOS string

const (
    OSWindows DaemonOS = "windows"
    OSMacOS   DaemonOS = "macos"
    OSLinux   DaemonOS = "linux"
)
```

`apps/agent/internal/scanner/scanner.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package scanner

import "github.com/animato/claude-hub/agent/internal/api"

type Scanner interface {
    Scan(claudeHome string) ([]api.InventoryItem, error)
}

type Noop struct{}

func NewNoop() *Noop { return &Noop{} }

func (n *Noop) Scan(_ string) ([]api.InventoryItem, error) {
    return []api.InventoryItem{}, nil
}
```

`apps/agent/internal/manifest/parser.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package manifest

import "github.com/animato/claude-hub/agent/internal/api"

type Parser interface {
    Parse(path string) (api.InventoryItem, error)
}

type Noop struct{}

func NewNoop() *Noop { return &Noop{} }

func (n *Noop) Parse(_ string) (api.InventoryItem, error) {
    return api.InventoryItem{}, nil
}
```

- [ ] **Step 4: PASS**

Run: `cd apps/agent && go test ./internal/scanner/ ./internal/manifest/ -v`
Expected: PASS (manifest has no test yet — that's fine).

- [ ] **Step 5: Commit**

```bash
git add apps/agent/internal/api/ apps/agent/internal/scanner/ apps/agent/internal/manifest/
git commit -m "feat(agent): add inventory types and noop scanner/manifest skeletons"
```

---

### Task 9: WSS message protocol package (TS)

**Files:**
- Create: `packages/wss-protocol/package.json`
- Create: `packages/wss-protocol/src/index.ts`
- Create: `packages/wss-protocol/src/index.test.ts`
- Create: `packages/wss-protocol/tsconfig.json`
- Modify: `pnpm-workspace.yaml` (add `packages/*` if not already)

- [ ] **Step 1: Failing test**

`packages/wss-protocol/src/index.test.ts`:
```typescript
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { parseMessage, makePing, makePong } from './index';

describe('wss-protocol', () => {
  it('round-trips ping/pong', () => {
    const ping = makePing('id-1');
    const parsed = parseMessage(JSON.stringify(ping));
    expect(parsed).toEqual({ type: 'ping', id: 'id-1', payload: {} });
    const pong = makePong('id-1');
    expect(pong.type).toBe('pong');
    expect(pong.id).toBe('id-1');
  });

  it('rejects invalid JSON', () => {
    expect(() => parseMessage('not json')).toThrow();
  });

  it('rejects missing type', () => {
    expect(() => parseMessage('{"id":"x"}')).toThrow(/type/);
  });
});
```

- [ ] **Step 2: Run (FAIL)**

Run: `pnpm --filter @claude-hub/wss-protocol test`
Expected: FAIL — package doesn't exist.

- [ ] **Step 3: Create package**

`packages/wss-protocol/package.json`:
```json
{
  "name": "@claude-hub/wss-protocol",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "scripts": {
    "test": "vitest run"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

`packages/wss-protocol/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

`packages/wss-protocol/src/index.ts`:
```typescript
// SPDX-License-Identifier: Apache-2.0
export type WSSMessageType =
  | 'ping' | 'pong'
  | 'inventory.snapshot' | 'inventory.delta'
  | 'job.install' | 'job.uninstall' | 'job.enable' | 'job.package'
  | 'job.result'
  | 'subscribe.local' | 'local.snapshot' | 'local.delta'
  | 'catalog.update';

export interface WSSMessage<T = unknown> {
  type: WSSMessageType;
  id: string;
  payload: T;
}

export function makePing(id: string): WSSMessage<Record<string, never>> {
  return { type: 'ping', id, payload: {} };
}

export function makePong(id: string): WSSMessage<Record<string, never>> {
  return { type: 'pong', id, payload: {} };
}

export function parseMessage(raw: string): WSSMessage {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    throw new Error(`wss-protocol: invalid JSON: ${(e as Error).message}`);
  }
  if (!obj || typeof obj !== 'object') throw new Error('wss-protocol: not an object');
  const m = obj as Partial<WSSMessage>;
  if (typeof m.type !== 'string') throw new Error('wss-protocol: missing type');
  if (typeof m.id !== 'string') throw new Error('wss-protocol: missing id');
  return { type: m.type as WSSMessageType, id: m.id, payload: m.payload ?? {} };
}
```

- [ ] **Step 4: Install + run tests**

Run: `pnpm install && pnpm --filter @claude-hub/wss-protocol test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/wss-protocol/ pnpm-workspace.yaml
git commit -m "feat(wss-protocol): add shared message types and parser"
```

---

### Task 10: Go WSS message structs (mirror TS)

**Files:**
- Create: `apps/agent/internal/wss/messages.go`
- Create: `apps/agent/internal/wss/messages_test.go`

- [ ] **Step 1: Failing test**

`apps/agent/internal/wss/messages_test.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package wss

import (
    "encoding/json"
    "testing"

    "github.com/stretchr/testify/require"
)

func TestPingMarshalRoundtrip(t *testing.T) {
    m := Message{Type: "ping", ID: "id-1", Payload: json.RawMessage(`{}`)}
    b, err := json.Marshal(m)
    require.NoError(t, err)

    var got Message
    require.NoError(t, json.Unmarshal(b, &got))
    require.Equal(t, "ping", got.Type)
    require.Equal(t, "id-1", got.ID)
}

func TestParseMessageRejectsMissingType(t *testing.T) {
    _, err := ParseMessage([]byte(`{"id":"x","payload":{}}`))
    require.Error(t, err)
}
```

- [ ] **Step 2: Run (FAIL)**

Run: `cd apps/agent && go test ./internal/wss/`
Expected: FAIL.

- [ ] **Step 3: Implement**

`apps/agent/internal/wss/messages.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package wss

import (
    "encoding/json"
    "errors"
)

const (
    TypePing             = "ping"
    TypePong             = "pong"
    TypeInventorySnap    = "inventory.snapshot"
    TypeInventoryDelta   = "inventory.delta"
    TypeJobInstall       = "job.install"
    TypeJobUninstall     = "job.uninstall"
    TypeJobEnable        = "job.enable"
    TypeJobPackage       = "job.package"
    TypeJobResult        = "job.result"
)

type Message struct {
    Type    string          `json:"type"`
    ID      string          `json:"id"`
    Payload json.RawMessage `json:"payload"`
}

func ParseMessage(raw []byte) (*Message, error) {
    var m Message
    if err := json.Unmarshal(raw, &m); err != nil {
        return nil, err
    }
    if m.Type == "" {
        return nil, errors.New("wss: missing type")
    }
    if m.ID == "" {
        return nil, errors.New("wss: missing id")
    }
    if len(m.Payload) == 0 {
        m.Payload = json.RawMessage(`{}`)
    }
    return &m, nil
}

func NewPong(id string) Message {
    return Message{Type: TypePong, ID: id, Payload: json.RawMessage(`{}`)}
}
```

- [ ] **Step 4: PASS**

Run: `cd apps/agent && go test ./internal/wss/ -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/agent/internal/wss/messages.go apps/agent/internal/wss/messages_test.go
git commit -m "feat(agent): WSS message envelope and parser mirroring TS schema"
```

---

### Task 11: WSS message router (extensible for Plan 3)

**Files:**
- Create: `apps/agent/internal/wss/router.go`
- Create: `apps/agent/internal/wss/router_test.go`

- [ ] **Step 1: Failing test**

`apps/agent/internal/wss/router_test.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package wss

import (
    "encoding/json"
    "errors"
    "testing"

    "github.com/stretchr/testify/require"
)

func TestRouterDispatchesPingToPongHandler(t *testing.T) {
    r := NewRouter()
    var seen string
    r.Handle(TypePing, func(m *Message) (*Message, error) {
        seen = m.ID
        return ptr(NewPong(m.ID)), nil
    })
    out, err := r.Dispatch(&Message{Type: TypePing, ID: "id-1", Payload: json.RawMessage(`{}`)})
    require.NoError(t, err)
    require.Equal(t, "id-1", seen)
    require.Equal(t, TypePong, out.Type)
}

func TestRouterReturnsErrorForUnknown(t *testing.T) {
    r := NewRouter()
    _, err := r.Dispatch(&Message{Type: "job.alien", ID: "x", Payload: json.RawMessage(`{}`)})
    require.True(t, errors.Is(err, ErrUnknownMessageType))
}

func ptr[T any](v T) *T { return &v }
```

- [ ] **Step 2: Run (FAIL)**

Run: `cd apps/agent && go test ./internal/wss/ -run TestRouter`
Expected: FAIL.

- [ ] **Step 3: Implement**

`apps/agent/internal/wss/router.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package wss

import (
    "errors"
    "fmt"
    "sync"
)

var ErrUnknownMessageType = errors.New("wss: unknown message type")

type Handler func(*Message) (*Message, error)

type Router struct {
    mu       sync.RWMutex
    handlers map[string]Handler
}

func NewRouter() *Router {
    r := &Router{handlers: map[string]Handler{}}
    r.Handle(TypePing, func(m *Message) (*Message, error) {
        out := NewPong(m.ID)
        return &out, nil
    })
    return r
}

func (r *Router) Handle(t string, h Handler) {
    r.mu.Lock()
    defer r.mu.Unlock()
    r.handlers[t] = h
}

func (r *Router) Dispatch(m *Message) (*Message, error) {
    r.mu.RLock()
    h, ok := r.handlers[m.Type]
    r.mu.RUnlock()
    if !ok {
        return nil, fmt.Errorf("%w: %s", ErrUnknownMessageType, m.Type)
    }
    return h(m)
}
```

- [ ] **Step 4: PASS**

Run: `cd apps/agent && go test ./internal/wss/ -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/agent/internal/wss/router.go apps/agent/internal/wss/router_test.go
git commit -m "feat(agent): extensible WSS message router with builtin ping handler"
```

---

### Task 12: WSS client with reconnect + keepalive

**Files:**
- Create: `apps/agent/internal/wss/client.go`
- Create: `apps/agent/internal/wss/client_test.go`

- [ ] **Step 1: Failing integration test**

`apps/agent/internal/wss/client_test.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package wss

import (
    "context"
    "encoding/json"
    "net/http"
    "net/http/httptest"
    "strings"
    "sync/atomic"
    "testing"
    "time"

    "github.com/gorilla/websocket"
    "github.com/rs/zerolog"
    "github.com/stretchr/testify/require"
)

func TestClientConnectsAuthenticatesAndReceivesPing(t *testing.T) {
    var pongs int32
    upgrader := websocket.Upgrader{}
    srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        require.Equal(t, "Bearer device-tok", r.Header.Get("Authorization"))
        c, err := upgrader.Upgrade(w, r, nil)
        require.NoError(t, err)
        defer c.Close()
        require.NoError(t, c.WriteJSON(Message{Type: TypePing, ID: "p1", Payload: json.RawMessage(`{}`)}))
        var got Message
        require.NoError(t, c.ReadJSON(&got))
        if got.Type == TypePong {
            atomic.AddInt32(&pongs, 1)
        }
    }))
    defer srv.Close()

    url := "ws" + strings.TrimPrefix(srv.URL, "http")
    cli := NewClient(url, "device-tok", NewRouter(), zerolog.Nop())
    ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
    defer cancel()
    require.NoError(t, cli.RunOnce(ctx))
    require.EqualValues(t, 1, atomic.LoadInt32(&pongs))
}
```

- [ ] **Step 2: Run (FAIL)**

Run: `cd apps/agent && go test ./internal/wss/ -run TestClient`
Expected: FAIL — `NewClient` undefined.

- [ ] **Step 3: Implement**

`apps/agent/internal/wss/client.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package wss

import (
    "context"
    "math"
    "net/http"
    "time"

    "github.com/gorilla/websocket"
    "github.com/rs/zerolog"
)

const (
    keepalivePeriod = 30 * time.Second
    writeWait       = 10 * time.Second
    readWait        = 60 * time.Second
)

type Client struct {
    url    string
    token  string
    router *Router
    log    zerolog.Logger
}

func NewClient(url, token string, router *Router, log zerolog.Logger) *Client {
    return &Client{url: url, token: token, router: router, log: log}
}

// Run reconnects with exponential backoff until ctx is done.
func (c *Client) Run(ctx context.Context) {
    attempt := 0
    for {
        if err := c.RunOnce(ctx); err != nil {
            c.log.Warn().Err(err).Msg("wss connection ended")
        }
        if ctx.Err() != nil {
            return
        }
        delay := time.Duration(math.Min(float64(time.Minute), float64(time.Second)*math.Pow(2, float64(attempt))))
        attempt++
        select {
        case <-time.After(delay):
        case <-ctx.Done():
            return
        }
    }
}

// RunOnce performs a single connection lifecycle.
func (c *Client) RunOnce(ctx context.Context) error {
    hdr := http.Header{"Authorization": []string{"Bearer " + c.token}}
    conn, _, err := websocket.DefaultDialer.DialContext(ctx, c.url, hdr)
    if err != nil {
        return err
    }
    defer conn.Close()

    conn.SetReadDeadline(time.Now().Add(readWait))
    conn.SetPongHandler(func(string) error {
        return conn.SetReadDeadline(time.Now().Add(readWait))
    })

    done := make(chan struct{})
    // keepalive
    go func() {
        t := time.NewTicker(keepalivePeriod)
        defer t.Stop()
        for {
            select {
            case <-t.C:
                _ = conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(writeWait))
            case <-done:
                return
            case <-ctx.Done():
                return
            }
        }
    }()
    defer close(done)

    for {
        if ctx.Err() != nil {
            return ctx.Err()
        }
        _, raw, err := conn.ReadMessage()
        if err != nil {
            return err
        }
        msg, err := ParseMessage(raw)
        if err != nil {
            c.log.Warn().Err(err).Msg("wss: parse error")
            continue
        }
        out, err := c.router.Dispatch(msg)
        if err != nil {
            c.log.Warn().Err(err).Str("type", msg.Type).Msg("wss: dispatch error")
            continue
        }
        if out != nil {
            conn.SetWriteDeadline(time.Now().Add(writeWait))
            if err := conn.WriteJSON(out); err != nil {
                return err
            }
        }
    }
}
```

- [ ] **Step 4: PASS**

Run: `cd apps/agent && go test ./internal/wss/ -v -run TestClient`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/agent/internal/wss/client.go apps/agent/internal/wss/client_test.go
git commit -m "feat(agent): WSS client with bearer auth, reconnect, and 30s keepalive"
```

---

### Task 13: Local API server skeleton + status endpoint

**Files:**
- Create: `apps/agent/internal/api/local/server.go`
- Create: `apps/agent/internal/api/local/handlers.go`
- Create: `apps/agent/internal/api/local/middleware.go`
- Create: `apps/agent/internal/api/local/server_test.go`

- [ ] **Step 1: Failing test**

`apps/agent/internal/api/local/server_test.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package local

import (
    "encoding/json"
    "net/http"
    "net/http/httptest"
    "testing"

    "github.com/stretchr/testify/require"
)

type fakeState struct{}

func (fakeState) Status() StatusResponse {
    return StatusResponse{Paired: true, HubURL: "https://hub.example", AgentVersion: "0.1.0", Online: false}
}

func (fakeState) Pair(_, _ string) error { return nil }

func TestStatusRequiresBearerToken(t *testing.T) {
    h := NewServer("test-token", fakeState{}).Handler()
    req := httptest.NewRequest(http.MethodGet, "/v1/status", nil)
    rr := httptest.NewRecorder()
    h.ServeHTTP(rr, req)
    require.Equal(t, http.StatusUnauthorized, rr.Code)
}

func TestStatusReturnsJSONWhenAuthorized(t *testing.T) {
    h := NewServer("test-token", fakeState{}).Handler()
    req := httptest.NewRequest(http.MethodGet, "/v1/status", nil)
    req.Header.Set("Authorization", "Bearer test-token")
    rr := httptest.NewRecorder()
    h.ServeHTTP(rr, req)
    require.Equal(t, http.StatusOK, rr.Code)
    var got StatusResponse
    require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &got))
    require.True(t, got.Paired)
    require.Equal(t, "https://hub.example", got.HubURL)
}

func TestCORSDeniedByDefault(t *testing.T) {
    h := NewServer("test-token", fakeState{}).Handler()
    req := httptest.NewRequest(http.MethodOptions, "/v1/status", nil)
    req.Header.Set("Origin", "http://evil.example")
    rr := httptest.NewRecorder()
    h.ServeHTTP(rr, req)
    require.Empty(t, rr.Header().Get("Access-Control-Allow-Origin"))
}
```

- [ ] **Step 2: Run (FAIL)**

Run: `cd apps/agent && go test ./internal/api/local/`
Expected: FAIL.

- [ ] **Step 3: Implement**

`apps/agent/internal/api/local/server.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package local

import "net/http"

type State interface {
    Status() StatusResponse
    Pair(hubURL, pin string) error
}

type Server struct {
    token string
    state State
}

func NewServer(token string, state State) *Server {
    return &Server{token: token, state: state}
}

func (s *Server) Handler() http.Handler {
    mux := http.NewServeMux()
    mux.HandleFunc("/v1/status", s.handleStatus)
    mux.HandleFunc("/v1/pair", s.handlePair)
    return s.withMiddleware(mux)
}
```

`apps/agent/internal/api/local/middleware.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package local

import (
    "net/http"
    "strings"
)

func (s *Server) withMiddleware(h http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // CORS deny: never echo Allow-Origin. Reject preflight bluntly.
        if r.Method == http.MethodOptions {
            w.WriteHeader(http.StatusForbidden)
            return
        }
        auth := r.Header.Get("Authorization")
        if !strings.HasPrefix(auth, "Bearer ") || strings.TrimPrefix(auth, "Bearer ") != s.token {
            w.WriteHeader(http.StatusUnauthorized)
            return
        }
        h.ServeHTTP(w, r)
    })
}
```

`apps/agent/internal/api/local/handlers.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package local

import (
    "encoding/json"
    "net/http"
)

type StatusResponse struct {
    Paired       bool   `json:"paired"`
    HubURL       string `json:"hub_url"`
    AgentVersion string `json:"agent_version"`
    Online       bool   `json:"online"`
}

type PairRequest struct {
    HubURL string `json:"hub_url"`
    Pin    string `json:"pin"`
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
    if r.Method != http.MethodGet {
        w.WriteHeader(http.StatusMethodNotAllowed)
        return
    }
    writeJSON(w, http.StatusOK, s.state.Status())
}

func (s *Server) handlePair(w http.ResponseWriter, r *http.Request) {
    if r.Method != http.MethodPost {
        w.WriteHeader(http.StatusMethodNotAllowed)
        return
    }
    var req PairRequest
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        w.WriteHeader(http.StatusBadRequest)
        return
    }
    if err := s.state.Pair(req.HubURL, req.Pin); err != nil {
        writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
        return
    }
    writeJSON(w, http.StatusOK, map[string]string{"status": "paired"})
}

func writeJSON(w http.ResponseWriter, code int, v any) {
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(code)
    _ = json.NewEncoder(w).Encode(v)
}
```

- [ ] **Step 4: PASS**

Run: `cd apps/agent && go test ./internal/api/local/ -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/agent/internal/api/local/
git commit -m "feat(agent): localhost HTTP API with bearer auth, CORS deny, status endpoint"
```

---

### Task 14: Drizzle schema — daemons + pairings

**Files:**
- Modify: `apps/hub-server/src/db/schema.ts`
- Create: `ops/migrations/0002_daemons_pairings.sql`
- Create: `apps/hub-server/src/db/schema.test.ts`

- [ ] **Step 1: Failing test**

`apps/hub-server/src/db/schema.test.ts`:
```typescript
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { daemons, pairings } from './schema';

describe('schema', () => {
  it('daemons has expected columns', () => {
    const cols = Object.keys((daemons as any));
    for (const c of ['id', 'userId', 'hostname', 'os', 'agentVersion', 'tokenHash', 'pairedAt', 'lastSeenAt']) {
      expect(cols).toContain(c);
    }
  });

  it('pairings has expected columns', () => {
    const cols = Object.keys((pairings as any));
    for (const c of ['id', 'pin', 'userId', 'expiresAt', 'consumedAt']) {
      expect(cols).toContain(c);
    }
  });
});
```

- [ ] **Step 2: Run (FAIL)**

Run: `pnpm --filter hub-server test -- schema.test`
Expected: FAIL.

- [ ] **Step 3: Add tables to schema**

Append to `apps/hub-server/src/db/schema.ts`:
```typescript
import { pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './schema'; // self — only if needed; else inline references

export const daemons = pgTable('daemons', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  hostname: text('hostname').notNull(),
  os: text('os', { enum: ['windows', 'macos', 'linux'] }).notNull(),
  agentVersion: text('agent_version').notNull(),
  tokenHash: text('token_hash').notNull(),
  pairedAt: timestamp('paired_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export const pairings = pgTable('pairings', {
  id: text('id').primaryKey(),
  pin: text('pin').notNull(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true, mode: 'date' }),
}, (t) => ({
  pinIdx: uniqueIndex('pairings_pin_idx').on(t.pin),
}));
```

(Note: if `users` is in the same file, drop the redundant import and reference directly.)

- [ ] **Step 4: Write SQL migration**

`ops/migrations/0002_daemons_pairings.sql`:
```sql
-- SPDX-License-Identifier: Apache-2.0
CREATE TABLE IF NOT EXISTS daemons (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    hostname      TEXT NOT NULL,
    os            TEXT NOT NULL CHECK (os IN ('windows','macos','linux')),
    agent_version TEXT NOT NULL,
    token_hash    TEXT NOT NULL,
    paired_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS daemons_user_id_idx ON daemons(user_id);

CREATE TABLE IF NOT EXISTS pairings (
    id           TEXT PRIMARY KEY,
    pin          TEXT NOT NULL,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at   TIMESTAMPTZ NOT NULL,
    consumed_at  TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS pairings_pin_idx ON pairings(pin);
CREATE INDEX IF NOT EXISTS pairings_expires_idx ON pairings(expires_at);
```

- [ ] **Step 5: PASS**

Run: `pnpm --filter hub-server test -- schema.test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/hub-server/src/db/schema.ts apps/hub-server/src/db/schema.test.ts ops/migrations/0002_daemons_pairings.sql
git commit -m "feat(server): add daemons and pairings tables"
```

---

### Task 15: `POST /api/daemons/pair` (logged-in user → pin)

**Files:**
- Create: `apps/hub-server/src/routes/daemons.ts`
- Create: `apps/hub-server/test/integration/daemons-pair.test.ts`
- Modify: `apps/hub-server/src/index.ts`

- [ ] **Step 1: Failing integration test (Testcontainers)**

`apps/hub-server/test/integration/daemons-pair.test.ts`:
```typescript
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestApp, loginAsUser, type TestApp } from './helpers';

describe('POST /api/daemons/pair', () => {
  let app: TestApp;
  beforeAll(async () => { app = await startTestApp(); });
  afterAll(async () => { await app.stop(); });

  it('returns 6-digit pin and pairing id for logged-in user', async () => {
    const cookie = await loginAsUser(app, 'alice@example.com', 'CorrectHorseBattery!');
    const res = await app.fetch('/api/daemons/pair', { method: 'POST', headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pin).toMatch(/^\d{6}$/);
    expect(body.pairingId).toBeDefined();
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('rejects unauthenticated', async () => {
    const res = await app.fetch('/api/daemons/pair', { method: 'POST' });
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run (FAIL)**

Run: `pnpm --filter hub-server test -- daemons-pair`
Expected: FAIL — route does not exist.

- [ ] **Step 3: Implement route**

`apps/hub-server/src/routes/daemons.ts`:
```typescript
// SPDX-License-Identifier: Apache-2.0
import { Hono } from 'hono';
import { v7 as uuidv7 } from 'uuid';
import { db } from '../db';
import { pairings } from '../db/schema';
import { requireUser, type AuthEnv } from '../auth/middleware';

export const daemonsRoute = new Hono<AuthEnv>();

const PIN_TTL_MS = 5 * 60 * 1000;

function genPin(): string {
  // crypto-strong 6-digit pin
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  const n = ((buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3]) >>> 0;
  return (n % 1_000_000).toString().padStart(6, '0');
}

daemonsRoute.post('/pair', requireUser, async (c) => {
  const user = c.get('user');
  const id = uuidv7();
  const pin = genPin();
  const expiresAt = new Date(Date.now() + PIN_TTL_MS);
  await db.insert(pairings).values({ id, pin, userId: user.id, expiresAt });
  return c.json({ pairingId: id, pin, expiresAt: expiresAt.toISOString() });
});
```

- [ ] **Step 4: Mount route**

In `apps/hub-server/src/index.ts`, add:
```typescript
import { daemonsRoute } from './routes/daemons';
app.route('/api/daemons', daemonsRoute);
```

- [ ] **Step 5: PASS**

Run: `pnpm --filter hub-server test -- daemons-pair`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/hub-server/src/routes/daemons.ts apps/hub-server/test/integration/daemons-pair.test.ts apps/hub-server/src/index.ts
git commit -m "feat(server): POST /api/daemons/pair issues 6-digit pin with 5min TTL"
```

---

### Task 16: `POST /api/daemons/register` (daemon side)

**Files:**
- Modify: `apps/hub-server/src/routes/daemons.ts`
- Create: `apps/hub-server/test/integration/daemons-register.test.ts`

- [ ] **Step 1: Failing test**

`apps/hub-server/test/integration/daemons-register.test.ts`:
```typescript
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestApp, loginAsUser, type TestApp } from './helpers';

describe('POST /api/daemons/register', () => {
  let app: TestApp;
  beforeAll(async () => { app = await startTestApp(); });
  afterAll(async () => { await app.stop(); });

  it('exchanges valid pin for device_token', async () => {
    const cookie = await loginAsUser(app, 'alice@example.com', 'CorrectHorseBattery!');
    const pairRes = await app.fetch('/api/daemons/pair', { method: 'POST', headers: { cookie } });
    const { pin } = await pairRes.json();

    const regRes = await app.fetch('/api/daemons/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin, hostname: 'mac-studio', os: 'macos', agentVersion: '0.1.0' }),
    });
    expect(regRes.status).toBe(200);
    const body = await regRes.json();
    expect(body.deviceToken).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32-byte url-safe base64
    expect(body.daemonId).toBeDefined();
  });

  it('rejects invalid pin', async () => {
    const res = await app.fetch('/api/daemons/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: '000000', hostname: 'h', os: 'linux', agentVersion: '0.1.0' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects already-consumed pin', async () => {
    const cookie = await loginAsUser(app, 'alice@example.com', 'CorrectHorseBattery!');
    const pairRes = await app.fetch('/api/daemons/pair', { method: 'POST', headers: { cookie } });
    const { pin } = await pairRes.json();
    const body = JSON.stringify({ pin, hostname: 'h', os: 'linux', agentVersion: '0.1.0' });
    const first = await app.fetch('/api/daemons/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    expect(first.status).toBe(200);
    const second = await app.fetch('/api/daemons/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    expect(second.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run (FAIL)**

Run: `pnpm --filter hub-server test -- daemons-register`
Expected: FAIL.

- [ ] **Step 3: Implement register handler**

Append to `apps/hub-server/src/routes/daemons.ts`:
```typescript
import { eq, and, isNull, gt } from 'drizzle-orm';
import { daemons } from '../db/schema';
import { createHash, randomBytes } from 'node:crypto';

interface RegisterBody {
  pin?: string;
  hostname?: string;
  os?: 'windows' | 'macos' | 'linux';
  agentVersion?: string;
}

daemonsRoute.post('/register', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as RegisterBody;
  const { pin, hostname, os, agentVersion } = body;
  if (!pin || !hostname || !os || !agentVersion) return c.json({ error: 'missing_fields' }, 400);
  if (!['windows', 'macos', 'linux'].includes(os)) return c.json({ error: 'bad_os' }, 400);

  const now = new Date();
  const [pairing] = await db
    .select()
    .from(pairings)
    .where(and(eq(pairings.pin, pin), isNull(pairings.consumedAt), gt(pairings.expiresAt, now)))
    .limit(1);
  if (!pairing) return c.json({ error: 'invalid_pin' }, 400);

  const tokenRaw = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(tokenRaw).digest('hex');
  const daemonId = uuidv7();

  await db.transaction(async (tx) => {
    await tx.insert(daemons).values({
      id: daemonId, userId: pairing.userId, hostname, os, agentVersion, tokenHash,
    });
    await tx.update(pairings).set({ consumedAt: now }).where(eq(pairings.id, pairing.id));
  });

  return c.json({ daemonId, deviceToken: tokenRaw });
});
```

- [ ] **Step 4: PASS**

Run: `pnpm --filter hub-server test -- daemons-register`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/hub-server/src/routes/daemons.ts apps/hub-server/test/integration/daemons-register.test.ts
git commit -m "feat(server): POST /api/daemons/register exchanges pin for device_token"
```

---

### Task 17: `GET /api/daemons` and `DELETE /api/daemons/:id`

**Files:**
- Modify: `apps/hub-server/src/routes/daemons.ts`
- Create: `apps/hub-server/test/integration/daemons-list.test.ts`

- [ ] **Step 1: Failing test**

`apps/hub-server/test/integration/daemons-list.test.ts`:
```typescript
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestApp, loginAsUser, registerDaemon, type TestApp } from './helpers';

describe('daemons list/delete', () => {
  let app: TestApp;
  beforeAll(async () => { app = await startTestApp(); });
  afterAll(async () => { await app.stop(); });

  it('lists own daemons with online=false initially', async () => {
    const cookie = await loginAsUser(app, 'alice@example.com', 'CorrectHorseBattery!');
    await registerDaemon(app, cookie, { hostname: 'mac-studio', os: 'macos' });
    const res = await app.fetch('/api/daemons', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.daemons).toHaveLength(1);
    expect(body.daemons[0].hostname).toBe('mac-studio');
    expect(body.daemons[0].online).toBe(false);
  });

  it('does not leak daemons of other users', async () => {
    const aliceCookie = await loginAsUser(app, 'alice@example.com', 'CorrectHorseBattery!');
    await registerDaemon(app, aliceCookie, { hostname: 'mac', os: 'macos' });
    const bobCookie = await loginAsUser(app, 'bob@example.com', 'CorrectHorseBattery!');
    const res = await app.fetch('/api/daemons', { headers: { cookie: bobCookie } });
    const body = await res.json();
    expect(body.daemons).toHaveLength(0);
  });

  it('deletes own daemon, 404 for someone else\'s', async () => {
    const aliceCookie = await loginAsUser(app, 'alice@example.com', 'CorrectHorseBattery!');
    const { daemonId } = await registerDaemon(app, aliceCookie, { hostname: 'h', os: 'linux' });
    const bobCookie = await loginAsUser(app, 'bob@example.com', 'CorrectHorseBattery!');
    const denied = await app.fetch(`/api/daemons/${daemonId}`, { method: 'DELETE', headers: { cookie: bobCookie } });
    expect(denied.status).toBe(404);
    const ok = await app.fetch(`/api/daemons/${daemonId}`, { method: 'DELETE', headers: { cookie: aliceCookie } });
    expect(ok.status).toBe(204);
  });
});
```

- [ ] **Step 2: Run (FAIL)**

Run: `pnpm --filter hub-server test -- daemons-list`
Expected: FAIL.

- [ ] **Step 3: Implement**

Append to `apps/hub-server/src/routes/daemons.ts`:
```typescript
import { connectionManager } from '../ws/manager';

daemonsRoute.get('/', requireUser, async (c) => {
  const user = c.get('user');
  const rows = await db.select().from(daemons).where(eq(daemons.userId, user.id));
  return c.json({
    daemons: rows.map((d) => ({
      id: d.id,
      hostname: d.hostname,
      os: d.os,
      agentVersion: d.agentVersion,
      pairedAt: d.pairedAt.toISOString(),
      lastSeenAt: d.lastSeenAt.toISOString(),
      online: connectionManager.isOnline(d.id),
    })),
  });
});

daemonsRoute.delete('/:id', requireUser, async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const result = await db.delete(daemons).where(and(eq(daemons.id, id), eq(daemons.userId, user.id)));
  if ((result as any).rowCount === 0) return c.json({ error: 'not_found' }, 404);
  connectionManager.disconnect(id);
  return c.body(null, 204);
});
```

(Note: `connectionManager` lands in Task 19. Until then this code won't compile — but Task 18 stubs it. We continue in order.)

- [ ] **Step 4: Stub connectionManager so this compiles before Task 19**

Create `apps/hub-server/src/ws/manager.ts` with a stub:
```typescript
// SPDX-License-Identifier: Apache-2.0
class ConnectionManager {
  isOnline(_daemonId: string) { return false; }
  disconnect(_daemonId: string) {}
}
export const connectionManager = new ConnectionManager();
```

(Real impl comes in Task 19; this temporary stub keeps Task 17 green and is replaced, not deleted, in Task 19.)

- [ ] **Step 5: PASS**

Run: `pnpm --filter hub-server test -- daemons-list`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/hub-server/src/routes/daemons.ts apps/hub-server/src/ws/manager.ts apps/hub-server/test/integration/daemons-list.test.ts
git commit -m "feat(server): list and delete own daemons via /api/daemons"
```

---

### Task 18: Pairing TTL sweep job

**Files:**
- Create: `apps/hub-server/src/jobs/pairing-sweep.ts`
- Create: `apps/hub-server/test/integration/pairing-sweep.test.ts`
- Modify: `apps/hub-server/src/index.ts`

- [ ] **Step 1: Failing test**

`apps/hub-server/test/integration/pairing-sweep.test.ts`:
```typescript
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestApp, type TestApp } from './helpers';
import { sweepExpiredPairings } from '../../src/jobs/pairing-sweep';
import { db } from '../../src/db';
import { pairings } from '../../src/db/schema';
import { v7 as uuidv7 } from 'uuid';
import { sql } from 'drizzle-orm';

describe('pairing sweep', () => {
  let app: TestApp;
  beforeAll(async () => { app = await startTestApp(); });
  afterAll(async () => { await app.stop(); });

  it('deletes pairings whose expires_at is in the past', async () => {
    const past = new Date(Date.now() - 60_000);
    await db.insert(pairings).values({ id: uuidv7(), pin: '999999', userId: app.aliceId, expiresAt: past });
    const removed = await sweepExpiredPairings();
    expect(removed).toBeGreaterThanOrEqual(1);
    const left = await db.select({ c: sql<number>`count(*)` }).from(pairings);
    expect(Number(left[0].c)).toBe(0);
  });
});
```

- [ ] **Step 2: Run (FAIL)**

Run: `pnpm --filter hub-server test -- pairing-sweep`
Expected: FAIL.

- [ ] **Step 3: Implement**

`apps/hub-server/src/jobs/pairing-sweep.ts`:
```typescript
// SPDX-License-Identifier: Apache-2.0
import { lt } from 'drizzle-orm';
import { db } from '../db';
import { pairings } from '../db/schema';

export async function sweepExpiredPairings(): Promise<number> {
  const result = await db.delete(pairings).where(lt(pairings.expiresAt, new Date()));
  return Number((result as any).rowCount ?? 0);
}

export function startPairingSweep(intervalMs = 60_000): () => void {
  const t = setInterval(() => {
    sweepExpiredPairings().catch(() => {});
  }, intervalMs);
  return () => clearInterval(t);
}
```

In `apps/hub-server/src/index.ts`, after server boots:
```typescript
import { startPairingSweep } from './jobs/pairing-sweep';
const stopSweep = startPairingSweep();
process.on('SIGTERM', () => { stopSweep(); });
```

- [ ] **Step 4: PASS**

Run: `pnpm --filter hub-server test -- pairing-sweep`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/hub-server/src/jobs/pairing-sweep.ts apps/hub-server/test/integration/pairing-sweep.test.ts apps/hub-server/src/index.ts
git commit -m "feat(server): periodic sweep of expired pairings (60s)"
```

---

### Task 19: WSS connection manager (real impl)

**Files:**
- Modify: `apps/hub-server/src/ws/manager.ts`
- Create: `apps/hub-server/src/ws/manager.test.ts`

- [ ] **Step 1: Failing test**

`apps/hub-server/src/ws/manager.test.ts`:
```typescript
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { ConnectionManager } from './manager';

class FakeWS {
  sent: string[] = [];
  closed = false;
  send(s: string) { this.sent.push(s); }
  close() { this.closed = true; }
}

describe('ConnectionManager', () => {
  it('tracks connect/disconnect/online state', () => {
    const m = new ConnectionManager();
    const ws = new FakeWS() as unknown as WebSocket;
    expect(m.isOnline('d1')).toBe(false);
    m.connect('d1', ws);
    expect(m.isOnline('d1')).toBe(true);
    m.disconnect('d1');
    expect(m.isOnline('d1')).toBe(false);
  });

  it('sendTo writes JSON to a single daemon', () => {
    const m = new ConnectionManager();
    const ws = new FakeWS();
    m.connect('d1', ws as unknown as WebSocket);
    m.sendTo('d1', { type: 'ping', id: 'x', payload: {} });
    expect(ws.sent[0]).toContain('"ping"');
  });

  it('broadcast sends to every connected daemon', () => {
    const m = new ConnectionManager();
    const a = new FakeWS();
    const b = new FakeWS();
    m.connect('a', a as unknown as WebSocket);
    m.connect('b', b as unknown as WebSocket);
    m.broadcast({ type: 'ping', id: 'x', payload: {} });
    expect(a.sent.length).toBe(1);
    expect(b.sent.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run (FAIL)**

Run: `pnpm --filter hub-server test -- ws/manager`
Expected: FAIL.

- [ ] **Step 3: Real implementation**

Replace `apps/hub-server/src/ws/manager.ts`:
```typescript
// SPDX-License-Identifier: Apache-2.0
import type { WSSMessage } from '@claude-hub/wss-protocol';

export interface WSLike {
  send(data: string): void;
  close(): void;
}

export class ConnectionManager {
  private conns = new Map<string, WSLike>();

  connect(daemonId: string, ws: WSLike) {
    const prev = this.conns.get(daemonId);
    if (prev) prev.close();
    this.conns.set(daemonId, ws);
  }

  disconnect(daemonId: string) {
    const ws = this.conns.get(daemonId);
    if (ws) ws.close();
    this.conns.delete(daemonId);
  }

  isOnline(daemonId: string): boolean {
    return this.conns.has(daemonId);
  }

  sendTo(daemonId: string, msg: WSSMessage): boolean {
    const ws = this.conns.get(daemonId);
    if (!ws) return false;
    ws.send(JSON.stringify(msg));
    return true;
  }

  broadcast(msg: WSSMessage) {
    const data = JSON.stringify(msg);
    for (const ws of this.conns.values()) ws.send(data);
  }
}

export const connectionManager = new ConnectionManager();
```

- [ ] **Step 4: PASS**

Run: `pnpm --filter hub-server test -- ws/manager`
Expected: PASS. Re-run earlier daemons-list test to confirm no regression.

- [ ] **Step 5: Commit**

```bash
git add apps/hub-server/src/ws/manager.ts apps/hub-server/src/ws/manager.test.ts
git commit -m "feat(server): in-memory WSS connection manager with broadcast"
```

---

### Task 20: WSS `/ws` endpoint with bearer auth + ping/last_seen

**Files:**
- Create: `apps/hub-server/src/ws/server.ts`
- Create: `apps/hub-server/test/integration/ws-handshake.test.ts`
- Modify: `apps/hub-server/src/index.ts`

- [ ] **Step 1: Failing test**

`apps/hub-server/test/integration/ws-handshake.test.ts`:
```typescript
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { startTestApp, loginAsUser, registerDaemon, type TestApp } from './helpers';

describe('WSS /ws', () => {
  let app: TestApp;
  beforeAll(async () => { app = await startTestApp(); });
  afterAll(async () => { await app.stop(); });

  it('rejects connection without Authorization header', async () => {
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(`${app.wsUrl}/ws`);
      ws.on('unexpected-response', (_req, res) => {
        expect(res.statusCode).toBe(401);
        resolve();
      });
      ws.on('error', () => resolve());
    });
  });

  it('accepts valid device_token, replies pong, stamps last_seen_at', async () => {
    const cookie = await loginAsUser(app, 'alice@example.com', 'CorrectHorseBattery!');
    const { deviceToken, daemonId } = await registerDaemon(app, cookie, { hostname: 'h', os: 'linux' });

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`${app.wsUrl}/ws`, { headers: { Authorization: `Bearer ${deviceToken}` } });
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', id: msg.id, payload: {} }));
          setTimeout(() => { ws.close(); resolve(); }, 100);
        }
      });
      ws.on('error', reject);
    });

    const listRes = await app.fetch('/api/daemons', { headers: { cookie } });
    const body = await listRes.json();
    const d = body.daemons.find((x: any) => x.id === daemonId);
    expect(new Date(d.lastSeenAt).getTime()).toBeGreaterThan(Date.now() - 5_000);
  });
});
```

- [ ] **Step 2: Run (FAIL)**

Run: `pnpm --filter hub-server test -- ws-handshake`
Expected: FAIL.

- [ ] **Step 3: Implement /ws using @hono/node-ws**

`apps/hub-server/src/ws/server.ts`:
```typescript
// SPDX-License-Identifier: Apache-2.0
import { Hono } from 'hono';
import { createNodeWebSocket } from '@hono/node-ws';
import { v7 as uuidv7 } from 'uuid';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { daemons } from '../db/schema';
import { connectionManager } from './manager';
import { parseMessage, makePing } from '@claude-hub/wss-protocol';

export function attachWS(app: Hono) {
  const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });

  app.get('/ws', upgradeWebSocket(async (c) => {
    const auth = c.req.header('Authorization') ?? '';
    if (!auth.startsWith('Bearer ')) {
      throw new Response(null, { status: 401 });
    }
    const token = auth.slice(7);
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const [d] = await db.select().from(daemons).where(eq(daemons.tokenHash, tokenHash)).limit(1);
    if (!d) throw new Response(null, { status: 401 });

    return {
      onOpen: (_e, ws) => {
        const wsLike = { send: (s: string) => ws.send(s), close: () => ws.close() };
        connectionManager.connect(d.id, wsLike);
        // server-initiated ping for last_seen handshake
        ws.send(JSON.stringify(makePing(uuidv7())));
      },
      onMessage: async (ev) => {
        try {
          const msg = parseMessage(typeof ev.data === 'string' ? ev.data : ev.data.toString());
          if (msg.type === 'pong') {
            await db.update(daemons).set({ lastSeenAt: new Date() }).where(eq(daemons.id, d.id));
          }
        } catch { /* drop */ }
      },
      onClose: () => connectionManager.disconnect(d.id),
      onError: () => connectionManager.disconnect(d.id),
    };
  }));

  return { injectWebSocket };
}
```

In `apps/hub-server/src/index.ts`:
```typescript
import { attachWS } from './ws/server';
import { serve } from '@hono/node-server';

const { injectWebSocket } = attachWS(app);
const server = serve({ fetch: app.fetch, port });
injectWebSocket(server);
```

Add deps:
```bash
pnpm --filter hub-server add @hono/node-ws ws
pnpm --filter hub-server add -D @types/ws
```

- [ ] **Step 4: PASS**

Run: `pnpm --filter hub-server test -- ws-handshake`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/hub-server/src/ws/server.ts apps/hub-server/src/index.ts apps/hub-server/test/integration/ws-handshake.test.ts apps/hub-server/package.json pnpm-lock.yaml
git commit -m "feat(server): WSS /ws endpoint with bearer auth and ping/pong handshake"
```

---

### Task 21: Pair subcommand (CLI → local API → hub /register)

**Files:**
- Modify: `apps/agent/cmd/claude-hub-agent/pair.go`
- Create: `apps/agent/internal/pairing/pairing.go`
- Create: `apps/agent/internal/pairing/pairing_test.go`

- [ ] **Step 1: Failing test**

`apps/agent/internal/pairing/pairing_test.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package pairing

import (
    "encoding/json"
    "net/http"
    "net/http/httptest"
    "testing"

    "github.com/stretchr/testify/require"
)

type fakeStore struct{ kv map[string]string }

func (f *fakeStore) Set(k, v string) error      { f.kv[k] = v; return nil }
func (f *fakeStore) Get(k string) (string, error) { return f.kv[k], nil }
func (f *fakeStore) Delete(k string) error      { delete(f.kv, k); return nil }

func TestPairCallsRegisterAndStoresToken(t *testing.T) {
    var got struct{ Pin, Hostname, OS, AgentVersion string }
    srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        require.Equal(t, "/api/daemons/register", r.URL.Path)
        require.NoError(t, json.NewDecoder(r.Body).Decode(&struct {
            Pin          *string `json:"pin"`
            Hostname     *string `json:"hostname"`
            OS           *string `json:"os"`
            AgentVersion *string `json:"agentVersion"`
        }{&got.Pin, &got.Hostname, &got.OS, &got.AgentVersion}))
        w.Header().Set("Content-Type", "application/json")
        json.NewEncoder(w).Encode(map[string]string{"daemonId": "d-123", "deviceToken": "tok-xyz"})
    }))
    defer srv.Close()

    store := &fakeStore{kv: map[string]string{}}
    err := Pair(srv.URL, "482913", "myhost", "macos", "0.1.0", store)
    require.NoError(t, err)
    require.Equal(t, "482913", got.Pin)
    require.Equal(t, "tok-xyz", store.kv["device_token"])
    require.Equal(t, "d-123", store.kv["daemon_id"])
    require.Equal(t, srv.URL, store.kv["hub_url"])
}
```

- [ ] **Step 2: Run (FAIL)**

Run: `cd apps/agent && go test ./internal/pairing/`
Expected: FAIL.

- [ ] **Step 3: Implement**

`apps/agent/internal/pairing/pairing.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package pairing

import (
    "bytes"
    "encoding/json"
    "fmt"
    "io"
    "net/http"

    "github.com/animato/claude-hub/agent/internal/storage/keychain"
)

type registerReq struct {
    Pin          string `json:"pin"`
    Hostname     string `json:"hostname"`
    OS           string `json:"os"`
    AgentVersion string `json:"agentVersion"`
}

type registerResp struct {
    DaemonID    string `json:"daemonId"`
    DeviceToken string `json:"deviceToken"`
}

func Pair(hubURL, pin, hostname, os, agentVersion string, store keychain.Store) error {
    body, _ := json.Marshal(registerReq{Pin: pin, Hostname: hostname, OS: os, AgentVersion: agentVersion})
    resp, err := http.Post(hubURL+"/api/daemons/register", "application/json", bytes.NewReader(body))
    if err != nil {
        return fmt.Errorf("pairing: post failed: %w", err)
    }
    defer resp.Body.Close()
    if resp.StatusCode != http.StatusOK {
        b, _ := io.ReadAll(resp.Body)
        return fmt.Errorf("pairing: hub returned %d: %s", resp.StatusCode, string(b))
    }
    var rr registerResp
    if err := json.NewDecoder(resp.Body).Decode(&rr); err != nil {
        return fmt.Errorf("pairing: decode: %w", err)
    }
    if err := store.Set("device_token", rr.DeviceToken); err != nil {
        return err
    }
    if err := store.Set("daemon_id", rr.DaemonID); err != nil {
        return err
    }
    if err := store.Set("hub_url", hubURL); err != nil {
        return err
    }
    return nil
}
```

- [ ] **Step 4: Wire pair subcommand**

Replace `apps/agent/cmd/claude-hub-agent/pair.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package main

import (
    "fmt"
    "os"
    "runtime"

    "github.com/spf13/cobra"

    "github.com/animato/claude-hub/agent/internal/pairing"
    "github.com/animato/claude-hub/agent/internal/storage/keychain"
)

func newPairCmd() *cobra.Command {
    var hub, pin string
    cmd := &cobra.Command{
        Use:   "pair",
        Short: "Pair this daemon with a hub using a 6-digit pin",
        RunE: func(cmd *cobra.Command, _ []string) error {
            if hub == "" || pin == "" {
                return fmt.Errorf("--hub and --pin are required")
            }
            host, err := os.Hostname()
            if err != nil { host = "unknown" }
            osName := goosToDaemonOS(runtime.GOOS)
            store := &keychain.KeyringStore{Service: "claude-hub-agent"}
            if err := pairing.Pair(hub, pin, host, osName, version, store); err != nil {
                return err
            }
            fmt.Fprintln(cmd.OutOrStdout(), "Paired successfully.")
            return nil
        },
    }
    cmd.Flags().StringVar(&hub, "hub", "", "Hub URL (e.g. https://hub.company.tld)")
    cmd.Flags().StringVar(&pin, "pin", "", "6-digit pairing pin")
    return cmd
}

func goosToDaemonOS(g string) string {
    switch g {
    case "darwin":
        return "macos"
    case "windows":
        return "windows"
    default:
        return "linux"
    }
}
```

- [ ] **Step 5: PASS**

Run: `cd apps/agent && go test ./internal/pairing/ ./cmd/claude-hub-agent/ -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/agent/internal/pairing/ apps/agent/cmd/claude-hub-agent/pair.go
git commit -m "feat(agent): pair subcommand exchanges pin for device_token via /register"
```

---

### Task 22: Run subcommand (foreground): wire local API + WSS

**Files:**
- Modify: `apps/agent/cmd/claude-hub-agent/run.go`
- Create: `apps/agent/internal/runtime/runtime.go`
- Create: `apps/agent/internal/runtime/runtime_test.go`

- [ ] **Step 1: Failing test**

`apps/agent/internal/runtime/runtime_test.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package runtime

import (
    "context"
    "io"
    "testing"
    "time"

    "github.com/rs/zerolog"
    "github.com/stretchr/testify/require"

    "github.com/animato/claude-hub/agent/internal/config"
    "github.com/animato/claude-hub/agent/internal/storage/keychain"
)

type memStore struct{ kv map[string]string }
func (m *memStore) Set(k, v string) error { m.kv[k] = v; return nil }
func (m *memStore) Get(k string) (string, error) {
    v, ok := m.kv[k]
    if !ok { return "", keychain.ErrNotFound }
    return v, nil
}
func (m *memStore) Delete(k string) error { delete(m.kv, k); return nil }

func TestStartReturnsCleanlyOnContextCancel(t *testing.T) {
    cfg := &config.Config{
        LocalBindAddr: "127.0.0.1:0",
        HubDataDir:    t.TempDir(),
        TokenFile:     t.TempDir() + "/agent.token",
    }
    log := zerolog.New(io.Discard)
    store := &memStore{kv: map[string]string{}}
    rt := New(cfg, store, log)
    ctx, cancel := context.WithCancel(context.Background())
    errCh := make(chan error, 1)
    go func() { errCh <- rt.Start(ctx) }()
    time.Sleep(100 * time.Millisecond)
    cancel()
    select {
    case err := <-errCh:
        require.True(t, err == nil || err == context.Canceled)
    case <-time.After(2 * time.Second):
        t.Fatal("Start did not return after cancel")
    }
}
```

- [ ] **Step 2: Run (FAIL)**

Run: `cd apps/agent && go test ./internal/runtime/`
Expected: FAIL.

- [ ] **Step 3: Implement Runtime**

`apps/agent/internal/runtime/runtime.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package runtime

import (
    "context"
    "errors"
    "net"
    "net/http"
    "strings"
    "sync"
    "time"

    "github.com/rs/zerolog"

    "github.com/animato/claude-hub/agent/internal/api/local"
    "github.com/animato/claude-hub/agent/internal/config"
    "github.com/animato/claude-hub/agent/internal/storage/agenttoken"
    "github.com/animato/claude-hub/agent/internal/storage/keychain"
    "github.com/animato/claude-hub/agent/internal/wss"
)

type Runtime struct {
    cfg   *config.Config
    store keychain.Store
    log   zerolog.Logger

    mu     sync.Mutex
    online bool
}

func New(cfg *config.Config, store keychain.Store, log zerolog.Logger) *Runtime {
    return &Runtime{cfg: cfg, store: store, log: log}
}

func (r *Runtime) Status() local.StatusResponse {
    hub, _ := r.store.Get("hub_url")
    _, errTok := r.store.Get("device_token")
    r.mu.Lock(); online := r.online; r.mu.Unlock()
    return local.StatusResponse{
        Paired:       errTok == nil,
        HubURL:       hub,
        AgentVersion: r.cfg.AgentVersion(),
        Online:       online,
    }
}

func (r *Runtime) Pair(_, _ string) error {
    return errors.New("Pair is invoked through the CLI subcommand, not the local API in MVP")
}

func (r *Runtime) Start(ctx context.Context) error {
    tok, err := agenttoken.Ensure(r.cfg.TokenFile)
    if err != nil {
        return err
    }
    apiSrv := local.NewServer(tok, r)
    httpSrv := &http.Server{Addr: r.cfg.LocalBindAddr, Handler: apiSrv.Handler(), ReadHeaderTimeout: 5 * time.Second}
    ln, err := net.Listen("tcp", r.cfg.LocalBindAddr)
    if err != nil {
        return err
    }
    go func() { _ = httpSrv.Serve(ln) }()
    defer httpSrv.Shutdown(context.Background())

    // WSS only if paired
    go r.runWSS(ctx)

    <-ctx.Done()
    return nil
}

func (r *Runtime) runWSS(ctx context.Context) {
    for {
        if ctx.Err() != nil { return }
        token, err := r.store.Get("device_token")
        if err != nil || token == "" {
            time.Sleep(5 * time.Second)
            continue
        }
        hub, _ := r.store.Get("hub_url")
        wsURL := strings.Replace(hub, "http", "ws", 1) + "/ws"
        client := wss.NewClient(wsURL, token, wss.NewRouter(), r.log)
        r.setOnline(true)
        if err := client.RunOnce(ctx); err != nil {
            r.log.Warn().Err(err).Msg("wss disconnected")
        }
        r.setOnline(false)
        select {
        case <-time.After(2 * time.Second):
        case <-ctx.Done():
            return
        }
    }
}

func (r *Runtime) setOnline(v bool) {
    r.mu.Lock(); defer r.mu.Unlock(); r.online = v
}
```

Add `AgentVersion()` getter to `apps/agent/internal/config/config.go`:
```go
func (c *Config) AgentVersion() string { return Version }
var Version = "0.1.0-dev"
```

- [ ] **Step 4: Wire run subcommand**

Replace `apps/agent/cmd/claude-hub-agent/run.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package main

import (
    "context"
    "os"
    "os/signal"
    "syscall"

    "github.com/spf13/cobra"

    "github.com/animato/claude-hub/agent/internal/config"
    "github.com/animato/claude-hub/agent/internal/logging"
    "github.com/animato/claude-hub/agent/internal/runtime"
    "github.com/animato/claude-hub/agent/internal/storage/keychain"
)

func newRunCmd() *cobra.Command {
    return &cobra.Command{
        Use:   "run",
        Short: "Run the agent in the foreground",
        RunE: func(cmd *cobra.Command, _ []string) error {
            cfg, err := config.Load()
            if err != nil { return err }
            if err := os.MkdirAll(cfg.HubDataDir, 0o700); err != nil { return err }
            f, err := os.OpenFile(cfg.LogFile, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
            if err != nil { return err }
            defer f.Close()
            log := logging.New(f, os.Stderr, "info")
            store := &keychain.KeyringStore{Service: "claude-hub-agent"}

            rt := runtime.New(cfg, store, log)
            ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
            defer cancel()
            log.Info().Str("addr", cfg.LocalBindAddr).Msg("agent starting")
            return rt.Start(ctx)
        },
    }
}
```

- [ ] **Step 5: PASS**

Run: `cd apps/agent && go test ./internal/runtime/ -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/agent/internal/runtime/ apps/agent/cmd/claude-hub-agent/run.go apps/agent/internal/config/config.go
git commit -m "feat(agent): runtime wiring and run subcommand (local API + WSS loop)"
```

---

### Task 23: Service install/uninstall/start/stop via kardianos

**Files:**
- Modify: `apps/agent/cmd/claude-hub-agent/service.go`
- Create: `apps/agent/cmd/claude-hub-agent/service_test.go`

- [ ] **Step 1: Failing test**

`apps/agent/cmd/claude-hub-agent/service_test.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package main

import (
    "bytes"
    "testing"

    "github.com/stretchr/testify/require"
)

func TestServiceHelpListsActions(t *testing.T) {
    cmd := newServiceCmd()
    var out bytes.Buffer
    cmd.SetOut(&out)
    cmd.SetArgs([]string{"--help"})
    require.NoError(t, cmd.Execute())
    s := out.String()
    for _, w := range []string{"install", "uninstall", "start", "stop"} {
        require.Contains(t, s, w)
    }
}
```

- [ ] **Step 2: Run (FAIL)**

Run: `cd apps/agent && go test ./cmd/claude-hub-agent/ -run TestServiceHelp`
Expected: FAIL.

- [ ] **Step 3: Implement service subcommand**

Replace `apps/agent/cmd/claude-hub-agent/service.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package main

import (
    "fmt"

    "github.com/kardianos/service"
    "github.com/spf13/cobra"
)

type svcProgram struct{}

func (p *svcProgram) Start(s service.Service) error { return nil }
func (p *svcProgram) Stop(s service.Service) error  { return nil }

func newKardianosService() (service.Service, error) {
    return service.New(&svcProgram{}, &service.Config{
        Name:        "claude-hub-agent",
        DisplayName: "Claude Hub Agent",
        Description: "Local daemon that syncs ~/.claude/ with the Claude Hub server.",
        Arguments:   []string{"run"},
    })
}

func newServiceCmd() *cobra.Command {
    cmd := &cobra.Command{
        Use:   "service",
        Short: "Manage the OS service (autostart at login)",
    }
    for _, action := range []string{"install", "uninstall", "start", "stop"} {
        a := action
        cmd.AddCommand(&cobra.Command{
            Use:   a,
            Short: fmt.Sprintf("%s the claude-hub-agent service", a),
            RunE: func(cmd *cobra.Command, _ []string) error {
                s, err := newKardianosService()
                if err != nil { return err }
                return service.Control(s, a)
            },
        })
    }
    return cmd
}
```

- [ ] **Step 4: PASS**

Run: `cd apps/agent && go test ./cmd/claude-hub-agent/ -run TestServiceHelp`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/agent/cmd/claude-hub-agent/service.go apps/agent/cmd/claude-hub-agent/service_test.go
git commit -m "feat(agent): service install/uninstall/start/stop via kardianos"
```

---

### Task 24: Status subcommand (calls local API)

**Files:**
- Modify: `apps/agent/cmd/claude-hub-agent/status.go`
- Create: `apps/agent/cmd/claude-hub-agent/status_test.go`

- [ ] **Step 1: Failing test**

`apps/agent/cmd/claude-hub-agent/status_test.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package main

import (
    "bytes"
    "encoding/json"
    "net/http"
    "net/http/httptest"
    "os"
    "testing"

    "github.com/stretchr/testify/require"
)

func TestStatusPrintsJSONFromLocalAPI(t *testing.T) {
    tokenPath := t.TempDir() + "/agent.token"
    require.NoError(t, os.WriteFile(tokenPath, []byte("local-tok"), 0o600))

    srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        require.Equal(t, "Bearer local-tok", r.Header.Get("Authorization"))
        w.Header().Set("Content-Type", "application/json")
        json.NewEncoder(w).Encode(map[string]any{"paired": true, "hub_url": "https://hub", "agent_version": "0.1.0", "online": true})
    }))
    defer srv.Close()

    var out bytes.Buffer
    cmd := newStatusCmdWithDeps(srv.URL, tokenPath)
    cmd.SetOut(&out)
    require.NoError(t, cmd.Execute())
    require.Contains(t, out.String(), `"paired":true`)
}
```

- [ ] **Step 2: Run (FAIL)**

Run: `cd apps/agent && go test ./cmd/claude-hub-agent/ -run TestStatus`
Expected: FAIL.

- [ ] **Step 3: Implement**

Replace `apps/agent/cmd/claude-hub-agent/status.go`:
```go
// SPDX-License-Identifier: Apache-2.0
package main

import (
    "io"
    "net/http"
    "os"

    "github.com/spf13/cobra"

    "github.com/animato/claude-hub/agent/internal/config"
)

func newStatusCmd() *cobra.Command {
    cfg, _ := config.Load()
    addr := "http://" + cfg.LocalBindAddr
    return newStatusCmdWithDeps(addr, cfg.TokenFile)
}

func newStatusCmdWithDeps(baseURL, tokenPath string) *cobra.Command {
    return &cobra.Command{
        Use:   "status",
        Short: "Print agent status as JSON",
        RunE: func(cmd *cobra.Command, _ []string) error {
            tok, err := os.ReadFile(tokenPath)
            if err != nil {
                return err
            }
            req, _ := http.NewRequest(http.MethodGet, baseURL+"/v1/status", nil)
            req.Header.Set("Authorization", "Bearer "+string(tok))
            resp, err := http.DefaultClient.Do(req)
            if err != nil { return err }
            defer resp.Body.Close()
            b, _ := io.ReadAll(resp.Body)
            cmd.OutOrStdout().Write(b)
            return nil
        },
    }
}
```

- [ ] **Step 4: PASS**

Run: `cd apps/agent && go test ./cmd/claude-hub-agent/ -v -run TestStatus`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/agent/cmd/claude-hub-agent/status.go apps/agent/cmd/claude-hub-agent/status_test.go
git commit -m "feat(agent): status subcommand prints local API JSON"
```

---

### Task 25: Dashboard — daemons API client + status badge

**Files:**
- Create: `apps/dashboard/src/lib/api/daemons.ts`
- Create: `apps/dashboard/src/components/daemon-status-badge.tsx`
- Create: `apps/dashboard/src/components/__tests__/daemon-status-badge.test.tsx`

- [ ] **Step 1: Failing test**

`apps/dashboard/src/components/__tests__/daemon-status-badge.test.tsx`:
```typescript
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DaemonStatusBadge } from '../daemon-status-badge';

describe('DaemonStatusBadge', () => {
  it('renders Online when online=true', () => {
    render(<DaemonStatusBadge online={true} hostname="mac-studio" />);
    expect(screen.getByText(/online/i)).toBeInTheDocument();
    expect(screen.getByText(/mac-studio/)).toBeInTheDocument();
  });
  it('renders Offline when online=false', () => {
    render(<DaemonStatusBadge online={false} hostname="mac-studio" />);
    expect(screen.getByText(/offline/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run (FAIL)**

Run: `pnpm --filter dashboard test -- daemon-status-badge`
Expected: FAIL.

- [ ] **Step 3: Implement client + component**

`apps/dashboard/src/lib/api/daemons.ts`:
```typescript
// SPDX-License-Identifier: Apache-2.0
import type { DaemonDTO } from '@claude-hub/shared-types';

export async function listDaemons(): Promise<DaemonDTO[]> {
  const res = await fetch('/api/daemons', { credentials: 'include' });
  if (!res.ok) throw new Error(`listDaemons: ${res.status}`);
  const body = await res.json();
  return body.daemons as DaemonDTO[];
}

export async function createPairing(): Promise<{ pin: string; pairingId: string; expiresAt: string }> {
  const res = await fetch('/api/daemons/pair', { method: 'POST', credentials: 'include' });
  if (!res.ok) throw new Error(`createPairing: ${res.status}`);
  return res.json();
}
```

`apps/dashboard/src/components/daemon-status-badge.tsx`:
```typescript
// SPDX-License-Identifier: Apache-2.0
'use client';

interface Props {
  online: boolean;
  hostname: string;
}

export function DaemonStatusBadge({ online, hostname }: Props) {
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm ${
        online ? 'bg-green-100 text-green-800' : 'bg-gray-200 text-gray-700'
      }`}
      data-testid="daemon-status-badge"
    >
      <span className={`h-2 w-2 rounded-full ${online ? 'bg-green-500' : 'bg-gray-400'}`} />
      {hostname} — {online ? 'Online' : 'Offline'}
    </span>
  );
}
```

- [ ] **Step 4: PASS**

Run: `pnpm --filter dashboard test -- daemon-status-badge`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/lib/api/daemons.ts apps/dashboard/src/components/daemon-status-badge.tsx apps/dashboard/src/components/__tests__/daemon-status-badge.test.tsx
git commit -m "feat(dashboard): daemon API client and status badge component"
```

---

### Task 26: Dashboard — Pair daemon modal

**Files:**
- Create: `apps/dashboard/src/components/pair-daemon-modal.tsx`
- Create: `apps/dashboard/src/components/__tests__/pair-daemon-modal.test.tsx`

- [ ] **Step 1: Failing test**

`apps/dashboard/src/components/__tests__/pair-daemon-modal.test.tsx`:
```typescript
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { PairDaemonModal } from '../pair-daemon-modal';

vi.mock('../../lib/api/daemons', () => ({
  createPairing: vi.fn().mockResolvedValue({ pin: '482913', pairingId: 'p1', expiresAt: new Date(Date.now() + 300_000).toISOString() }),
}));

describe('PairDaemonModal', () => {
  it('shows pin and per-OS install command after open', async () => {
    render(<PairDaemonModal open={true} onClose={() => {}} publicUrl="https://hub.example" />);
    await waitFor(() => expect(screen.getByText('482913')).toBeInTheDocument());
    expect(screen.getByText(/brew install/)).toBeInTheDocument();
    expect(screen.getByText(/install\.sh/)).toBeInTheDocument();
    expect(screen.getByText(/install\.ps1/)).toBeInTheDocument();
    expect(screen.getByText(/claude-hub-agent pair --hub https:\/\/hub\.example --pin 482913/)).toBeInTheDocument();
  });

  it('calls onClose when Done clicked', async () => {
    const onClose = vi.fn();
    render(<PairDaemonModal open={true} onClose={onClose} publicUrl="https://hub.example" />);
    await waitFor(() => screen.getByText('482913'));
    fireEvent.click(screen.getByRole('button', { name: /done/i }));
    expect(onClose).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run (FAIL)**

Run: `pnpm --filter dashboard test -- pair-daemon-modal`
Expected: FAIL.

- [ ] **Step 3: Implement**

`apps/dashboard/src/components/pair-daemon-modal.tsx`:
```typescript
// SPDX-License-Identifier: Apache-2.0
'use client';
import { useEffect, useState } from 'react';
import { createPairing } from '../lib/api/daemons';

interface Props {
  open: boolean;
  onClose: () => void;
  publicUrl: string;
}

export function PairDaemonModal({ open, onClose, publicUrl }: Props) {
  const [pin, setPin] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setPin(null);
    setError(null);
    createPairing().then((r) => setPin(r.pin)).catch((e) => setError(String(e)));
  }, [open]);

  if (!open) return null;
  return (
    <div role="dialog" aria-label="Pair daemon" className="fixed inset-0 flex items-center justify-center bg-black/40">
      <div className="w-[640px] rounded-lg bg-white p-6 shadow-xl">
        <h2 className="text-lg font-semibold">Pair your daemon</h2>
        {error && <p className="mt-2 text-red-600">{error}</p>}
        {pin && (
          <>
            <p className="mt-2 text-sm text-gray-600">
              Your pin (valid for 5 minutes):
            </p>
            <p className="my-3 text-center font-mono text-3xl tracking-widest">{pin}</p>

            <h3 className="mt-4 font-medium">1. Install the agent</h3>
            <pre className="mt-2 rounded bg-gray-100 p-3 text-sm">
              <code>{`# macOS
brew install claude-hub-agent

# Linux
curl ${publicUrl}/install.sh | sh

# Windows (PowerShell)
iwr ${publicUrl}/install.ps1 | iex`}</code>
            </pre>

            <h3 className="mt-4 font-medium">2. Run the pair command</h3>
            <pre className="mt-2 rounded bg-gray-100 p-3 text-sm">
              <code>{`claude-hub-agent pair --hub ${publicUrl} --pin ${pin}`}</code>
            </pre>
          </>
        )}
        <div className="mt-6 flex justify-end">
          <button onClick={onClose} className="rounded bg-blue-600 px-4 py-2 text-white">Done</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: PASS**

Run: `pnpm --filter dashboard test -- pair-daemon-modal`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/components/pair-daemon-modal.tsx apps/dashboard/src/components/__tests__/pair-daemon-modal.test.tsx
git commit -m "feat(dashboard): pair daemon modal with pin and per-OS install instructions"
```

---

### Task 27: Dashboard — banner wiring + 5s polling

**Files:**
- Create: `apps/dashboard/src/components/daemon-status-banner.tsx`
- Modify: `apps/dashboard/src/app/(authed)/dashboard/page.tsx`
- Create: `apps/dashboard/src/components/__tests__/daemon-status-banner.test.tsx`

- [ ] **Step 1: Failing test**

`apps/dashboard/src/components/__tests__/daemon-status-banner.test.tsx`:
```typescript
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { DaemonStatusBanner } from '../daemon-status-banner';

const listDaemonsMock = vi.fn();
vi.mock('../../lib/api/daemons', () => ({
  listDaemons: () => listDaemonsMock(),
}));

describe('DaemonStatusBanner', () => {
  it('shows Pair daemon CTA when no daemons', async () => {
    listDaemonsMock.mockResolvedValueOnce([]);
    render(<DaemonStatusBanner publicUrl="https://hub.example" />);
    await waitFor(() => expect(screen.getByText(/not paired yet/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /pair daemon/i })).toBeInTheDocument();
  });

  it('shows online badge when at least one daemon is online', async () => {
    listDaemonsMock.mockResolvedValueOnce([
      { id: 'd1', hostname: 'mac', os: 'macos', online: true, agentVersion: '0.1.0', pairedAt: '', lastSeenAt: '' },
    ]);
    render(<DaemonStatusBanner publicUrl="https://hub.example" />);
    await waitFor(() => expect(screen.getByText(/online/i)).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run (FAIL)**

Run: `pnpm --filter dashboard test -- daemon-status-banner`
Expected: FAIL.

- [ ] **Step 3: Implement**

`apps/dashboard/src/components/daemon-status-banner.tsx`:
```typescript
// SPDX-License-Identifier: Apache-2.0
'use client';
import { useEffect, useState } from 'react';
import type { DaemonDTO } from '@claude-hub/shared-types';
import { listDaemons } from '../lib/api/daemons';
import { DaemonStatusBadge } from './daemon-status-badge';
import { PairDaemonModal } from './pair-daemon-modal';

interface Props { publicUrl: string; }

export function DaemonStatusBanner({ publicUrl }: Props) {
  const [daemons, setDaemons] = useState<DaemonDTO[] | null>(null);
  const [pairOpen, setPairOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const list = await listDaemons();
        if (alive) setDaemons(list);
      } catch { /* ignore transient */ }
    };
    tick();
    const t = setInterval(tick, 5_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (daemons === null) return <div className="text-sm text-gray-400">Loading…</div>;

  if (daemons.length === 0) {
    return (
      <>
        <div className="rounded border border-amber-300 bg-amber-50 p-4">
          <p className="text-sm">Your daemon is not paired yet. Install the agent and run pair to connect.</p>
          <button onClick={() => setPairOpen(true)} className="mt-2 rounded bg-blue-600 px-3 py-1 text-white">
            Pair daemon
          </button>
        </div>
        <PairDaemonModal open={pairOpen} onClose={() => setPairOpen(false)} publicUrl={publicUrl} />
      </>
    );
  }

  return (
    <div className="flex flex-wrap gap-2">
      {daemons.map((d) => (
        <DaemonStatusBadge key={d.id} online={d.online} hostname={d.hostname} />
      ))}
    </div>
  );
}
```

Modify `apps/dashboard/src/app/(authed)/dashboard/page.tsx`:
```typescript
import { DaemonStatusBanner } from '@/components/daemon-status-banner';

export default function DashboardPage() {
  const publicUrl = process.env.NEXT_PUBLIC_HUB_URL ?? '';
  return (
    <main className="space-y-4 p-6">
      <h1 className="text-xl font-semibold">Dashboard</h1>
      <DaemonStatusBanner publicUrl={publicUrl} />
    </main>
  );
}
```

- [ ] **Step 4: PASS**

Run: `pnpm --filter dashboard test -- daemon-status-banner`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/components/daemon-status-banner.tsx apps/dashboard/src/components/__tests__/daemon-status-banner.test.tsx apps/dashboard/src/app/(authed)/dashboard/page.tsx
git commit -m "feat(dashboard): daemon status banner with 5s polling and pair CTA"
```

---

### Task 28: Install scripts (functional placeholders that work today)

**Files:**
- Create: `ops/install/install.sh`
- Create: `ops/install/install.ps1`
- Create: `ops/install/brew/claude-hub-agent.rb`

- [ ] **Step 1: Write `install.sh`**

`ops/install/install.sh`:
```bash
#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail

VERSION="${CLAUDE_HUB_AGENT_VERSION:-latest}"
RELEASE_BASE="${CLAUDE_HUB_AGENT_RELEASE_BASE:-https://github.com/animato/claude-hub/releases/download}"
INSTALL_DIR="${CLAUDE_HUB_AGENT_INSTALL_DIR:-$HOME/.local/bin}"

uname_s="$(uname -s)"
uname_m="$(uname -m)"
case "$uname_s" in
    Linux*)  os="linux" ;;
    Darwin*) os="darwin" ;;
    *) echo "Unsupported OS: $uname_s" >&2; exit 1 ;;
esac
case "$uname_m" in
    x86_64|amd64) arch="amd64" ;;
    arm64|aarch64) arch="arm64" ;;
    *) echo "Unsupported arch: $uname_m" >&2; exit 1 ;;
esac

if [ "$VERSION" = "latest" ]; then
    url="$RELEASE_BASE/latest/claude-hub-agent_${os}_${arch}.tar.gz"
else
    url="$RELEASE_BASE/v${VERSION}/claude-hub-agent_${os}_${arch}.tar.gz"
fi

mkdir -p "$INSTALL_DIR"
tmp="$(mktemp -d)"
echo "Downloading $url"
curl -fSL "$url" -o "$tmp/agent.tar.gz"
tar -xzf "$tmp/agent.tar.gz" -C "$tmp"
mv "$tmp/claude-hub-agent" "$INSTALL_DIR/claude-hub-agent"
chmod +x "$INSTALL_DIR/claude-hub-agent"
rm -rf "$tmp"

echo "Installing service (requires sudo or admin context for systemd/launchd)..."
"$INSTALL_DIR/claude-hub-agent" service install || true
"$INSTALL_DIR/claude-hub-agent" service start  || true

echo "Installed claude-hub-agent to $INSTALL_DIR/claude-hub-agent"
echo "Next step: run 'claude-hub-agent pair --hub <hub-url> --pin <pin-from-dashboard>'"
```

- [ ] **Step 2: Write `install.ps1`**

`ops/install/install.ps1`:
```powershell
# SPDX-License-Identifier: Apache-2.0
$ErrorActionPreference = "Stop"

$Version    = if ($env:CLAUDE_HUB_AGENT_VERSION) { $env:CLAUDE_HUB_AGENT_VERSION } else { "latest" }
$Base       = if ($env:CLAUDE_HUB_AGENT_RELEASE_BASE) { $env:CLAUDE_HUB_AGENT_RELEASE_BASE } else { "https://github.com/animato/claude-hub/releases/download" }
$InstallDir = if ($env:CLAUDE_HUB_AGENT_INSTALL_DIR) { $env:CLAUDE_HUB_AGENT_INSTALL_DIR } else { "$env:LOCALAPPDATA\claude-hub" }

$arch = if ([System.Environment]::Is64BitOperatingSystem) {
    if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "amd64" }
} else { throw "32-bit Windows not supported." }

$tag = if ($Version -eq "latest") { "latest" } else { "v$Version" }
$url = "$Base/$tag/claude-hub-agent_windows_${arch}.zip"

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$tmp = New-TemporaryFile
$zip = "$($tmp.FullName).zip"
Move-Item $tmp.FullName $zip

Write-Host "Downloading $url"
Invoke-WebRequest -Uri $url -OutFile $zip
Expand-Archive -Path $zip -DestinationPath $InstallDir -Force
Remove-Item $zip

$exe = Join-Path $InstallDir "claude-hub-agent.exe"
& $exe service install
& $exe service start

# Add InstallDir to user PATH if missing
$path = [Environment]::GetEnvironmentVariable("Path", "User")
if (-not ($path -split ";" -contains $InstallDir)) {
    [Environment]::SetEnvironmentVariable("Path", "$path;$InstallDir", "User")
}

Write-Host "Installed claude-hub-agent to $InstallDir"
Write-Host "Next: run 'claude-hub-agent pair --hub <hub-url> --pin <pin-from-dashboard>'"
```

- [ ] **Step 3: Write Homebrew formula**

`ops/install/brew/claude-hub-agent.rb`:
```ruby
# SPDX-License-Identifier: Apache-2.0
class ClaudeHubAgent < Formula
  desc "Local daemon for the Claude Hub team marketplace"
  homepage "https://github.com/animato/claude-hub"
  version "0.1.0"

  if Hardware::CPU.arm?
    url "https://github.com/animato/claude-hub/releases/download/v#{version}/claude-hub-agent_darwin_arm64.tar.gz"
    sha256 "REPLACE_AT_RELEASE_TIME"
  else
    url "https://github.com/animato/claude-hub/releases/download/v#{version}/claude-hub-agent_darwin_amd64.tar.gz"
    sha256 "REPLACE_AT_RELEASE_TIME"
  end

  def install
    bin.install "claude-hub-agent"
  end

  service do
    run [opt_bin/"claude-hub-agent", "run"]
    keep_alive true
    log_path var/"log/claude-hub-agent.log"
    error_log_path var/"log/claude-hub-agent.err.log"
  end

  test do
    assert_match "claude-hub-agent", shell_output("#{bin}/claude-hub-agent --version")
  end
end
```

- [ ] **Step 4: Sanity-check the shell scripts parse**

Run on Linux/macOS:
```bash
bash -n ops/install/install.sh
```
Expected: no output, exit 0.

Run on Windows (or via pwsh container):
```powershell
[System.Management.Automation.Language.Parser]::ParseFile("ops/install/install.ps1", [ref]$null, [ref]$null) | Out-Null
```
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add ops/install/
git commit -m "feat(install): cross-platform install scripts and brew formula"
```

---

### Task 29: GitHub Actions cross-platform agent build

**Files:**
- Create: `.github/workflows/agent-build.yml`

- [ ] **Step 1: Write workflow**

`.github/workflows/agent-build.yml`:
```yaml
# SPDX-License-Identifier: Apache-2.0
name: agent-build

on:
  push:
    paths:
      - 'apps/agent/**'
      - '.github/workflows/agent-build.yml'
  pull_request:
    paths:
      - 'apps/agent/**'
      - '.github/workflows/agent-build.yml'

jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    runs-on: ${{ matrix.os }}
    defaults:
      run:
        working-directory: apps/agent
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: '1.23'
          cache-dependency-path: apps/agent/go.sum
      - name: Install Linux keyring deps
        if: runner.os == 'Linux'
        run: sudo apt-get update && sudo apt-get install -y libsecret-1-dev dbus-x11 gnome-keyring
      - run: go vet ./...
      - run: go test ./... -count=1

  build:
    needs: test
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: ubuntu-latest
            goos: linux
            goarch: amd64
          - os: ubuntu-latest
            goos: linux
            goarch: arm64
          - os: macos-latest
            goos: darwin
            goarch: amd64
          - os: macos-latest
            goos: darwin
            goarch: arm64
          - os: windows-latest
            goos: windows
            goarch: amd64
    runs-on: ${{ matrix.os }}
    defaults:
      run:
        working-directory: apps/agent
    env:
      GOOS: ${{ matrix.goos }}
      GOARCH: ${{ matrix.goarch }}
      CGO_ENABLED: '0'
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: '1.23'
          cache-dependency-path: apps/agent/go.sum
      - run: go build -o dist/claude-hub-agent${{ matrix.goos == 'windows' && '.exe' || '' }} ./cmd/claude-hub-agent
      - uses: actions/upload-artifact@v4
        with:
          name: claude-hub-agent-${{ matrix.goos }}-${{ matrix.goarch }}
          path: apps/agent/dist/*
```

- [ ] **Step 2: Validate locally**

Run: `cd apps/agent && go vet ./... && go test ./... -count=1`
Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/agent-build.yml
git commit -m "ci(agent): cross-platform Go matrix (linux/darwin/windows × amd64/arm64)"
```

---

## Self-Review

Provedeno proti specu (sekce 4.2, 6.2, 7.3, 7.6) a kontraktům (`_implementation-contracts.md`).

**1. Spec coverage:**
- 4.2.1 Go daemon (fsnotify, manifest, local API, WSS, kardianos): Tasks 1–13 (skeletony scanner/manifest), 22, 23. fsnotify se integruje až v Plan 3 — scope je jasně oddělený. ✓
- 6.2 Onboarding (pin, register, store in keychain, WSS connect, last_seen): Tasks 14–22. ✓
- 7.3 Pairing flow (5min TTL, 256-bit device_token, OS keychain): Tasks 5, 6, 14, 15, 16, 21. ✓
- 7.6 Daemon hardening (CORS deny, file token mode 0600, 127.0.0.1 only): Tasks 7, 13, 22. ✓
- 5.1 Schema (`daemons`, `pairings`): Task 14. ✓
- WSS protocol (ping/pong + framing extensible): Tasks 9, 10, 11, 12, 19, 20. ✓
- Dashboard pair wizard + online badge + 5s polling: Tasks 25, 26, 27. ✓
- Install scripts: Task 28. ✓
- CI matrix: Task 29. ✓

**2. Placeholder scan:** Nenalezeny žádné "TBD"/"TODO"/"implement later"/"add error handling" patterny. Všechny code bloky jsou kompletní. Task 17 záměrně vytváří dočasný stub `connectionManager`, který je nahrazen v Task 19 — to je explicitně dokumentováno, ne placeholder.

**3. Type consistency:**
- `InventoryItem` má stejné fieldy v TS (`packages/shared-types`) i Go (Task 8). ✓
- Bearer token field v `/api/daemons/register` response = `deviceToken` (camelCase) v server (Task 16) i parser (Task 21). ✓
- WSS message envelope `{type, id, payload}` konzistentně mezi TS (Task 9) a Go (Task 10). ✓
- `connectionManager.isOnline(daemonId)` signatura stejná v Task 17 (stub), Task 19 (real impl), Task 20 (callsite). ✓
- `DaemonOS` enum: `'windows' | 'macos' | 'linux'` všude.

**Coverage gaps:** žádné — všechny brief items pokryté.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-09-plan-2-daemon-foundation.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session via `superpowers:executing-plans`, batch with checkpoints.

**Which approach?**
