# Plan 4 — Plugins + Commands + Subagents + Enable/Disable Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rozšířit end-to-end flow z Plan 3 (skills) na zbylé tři typy artefaktů — `plugin`, `command`, `agent` — a přidat plugin enable/disable toggle přes `~/.claude/settings.json`.

**Architecture:** Každý typ dostane vlastní manifest parser a scanner v daemonu, sjednocené přes `ManifestParser` a `ScannerProvider` registry interface (existují v Plan 3). Install/uninstall jobs větví per type podle install path. Nový `job.toggle` putuje od Hubu k daemonovi přes WSS a daemon atomic-edituje `settings.json`. Hub server validuje upload archives per-type pomocí zod schemat. Dashboard rozšiřuje Local i Catalog o per-type ikony, filter chip-bar a — pouze pro plugin — Switch komponentu pro toggle.

**Tech Stack:** Go 1.23+ (`fsnotify`, `kardianos/service`), Node.js 22 + TypeScript + Hono, drizzle-orm, PostgreSQL 16, Next.js 14 + Tailwind + shadcn/ui (`Switch`, `lucide-react` ikony), Vitest + Testcontainers, Go `testing` + `t.TempDir`, Playwright.

**Závislosti z Plan 3:** `ArtifactType` enum, `ArtifactManifest` struct, `ManifestParser` interface, `ScannerProvider` interface, WSS message router, Dashboard Local + Catalog skeleton, Publish modal, install button.

---

## File Structure

**Daemon (`apps/agent/`):**
- Create `internal/manifest/plugin.go` — parser pro `plugin.json`
- Create `internal/manifest/command.go` — parser pro `commands/*.md` frontmatter
- Create `internal/manifest/agent.go` — parser pro `agents/*.md` frontmatter
- Create `internal/manifest/registry.go` — generic `ManifestParser` registry
- Create `internal/scanner/plugins.go`, `internal/scanner/commands.go`, `internal/scanner/agents.go`
- Modify `internal/scanner/registry.go` — agregace všech scannerů (rozšíření z Plan 3)
- Modify `internal/jobs/install.go` — per-type install paths a archive validation
- Modify `internal/jobs/uninstall.go` — per-type cleanup s backup
- Create `internal/jobs/toggle.go` — plugin enable/disable přes `settings.json`
- Modify `internal/api/local/router.go` — `/v1/toggle` per-type routing
- Modify `internal/wss/router.go` — handler pro `job.toggle`
- Tests: `*_test.go` ke každému novému souboru

**Hub server (`apps/hub-server/`):**
- Create `src/validators/manifest-plugin.ts`, `manifest-command.ts`, `manifest-agent.ts` — zod schemata
- Modify `src/routes/artifacts.ts` — per-type validation v `POST /api/artifacts/upload`
- Create `src/routes/local-toggle.ts` — `POST /api/local/:daemonId/toggle-request`
- Modify `src/wss/dispatcher.ts` — broadcast `job.toggle`, rozšíření `job.result` kódů
- Tests: `test/integration/upload-{plugin,command,agent}.test.ts`, `test/integration/toggle.test.ts`

**Dashboard (`apps/dashboard/`):**
- Create `components/ArtifactTypeIcon.tsx` — lucide-react ikony per typ
- Create `components/TypeFilterChips.tsx` — All / Skills / Plugins / Commands / Agents
- Create `components/ToggleSwitch.tsx` — wrapper nad shadcn Switch s optimistic update
- Modify `app/local/page.tsx` — Type column, filter chips, action column větvení
- Modify `app/catalog/page.tsx` — filter chips a per-type ikony
- Modify `app/catalog/[slug]/page.tsx` — typeMeta rendering per typ
- Modify `components/PublishModal.tsx` — pre-fill description per typ + zobrazení typu
- Tests: `*.test.tsx` ke každé komponentě, Playwright `e2e/multi-type-flow.spec.ts`

**WSS protocol (`packages/wss-protocol/`):**
- Modify `schema.json` — přidat `job.toggle` typ
- Tests: `schema.test.ts`

---

## Task 1: WSS protocol — `job.toggle` schema

**Files:**
- Modify: `packages/wss-protocol/schema.json`
- Modify: `packages/wss-protocol/src/types.ts`
- Test: `packages/wss-protocol/test/schema.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/wss-protocol/test/schema.test.ts (append)
import { validateMessage } from '../src/validate';

test('job.toggle is valid for plugin enable', () => {
  const msg = {
    type: 'job.toggle',
    id: '01H...',
    payload: { artifactId: 'a-1', slug: 'org-tooling', enabled: true },
  };
  expect(validateMessage(msg)).toEqual({ ok: true });
});

test('job.toggle rejects missing slug', () => {
  const msg = {
    type: 'job.toggle',
    id: '01H...',
    payload: { artifactId: 'a-1', enabled: true },
  };
  expect(validateMessage(msg).ok).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @hub/wss-protocol test -- schema.test.ts`
Expected: FAIL — `job.toggle` not in schema

- [ ] **Step 3: Add `job.toggle` to schema**

```json
// packages/wss-protocol/schema.json — add inside oneOf of HubToDaemon messages
{
  "$id": "JobToggle",
  "type": "object",
  "required": ["type", "id", "payload"],
  "properties": {
    "type": { "const": "job.toggle" },
    "id": { "type": "string" },
    "payload": {
      "type": "object",
      "required": ["artifactId", "slug", "enabled"],
      "properties": {
        "artifactId": { "type": "string" },
        "slug": { "type": "string", "pattern": "^[a-z0-9][a-z0-9-]{0,63}$" },
        "enabled": { "type": "boolean" }
      },
      "additionalProperties": false
    }
  }
}
```

```ts
// packages/wss-protocol/src/types.ts — append
export interface JobToggleMessage {
  type: 'job.toggle';
  id: string;
  payload: { artifactId: string; slug: string; enabled: boolean };
}
export type HubToDaemonMessage =
  | JobInstallMessage
  | JobUninstallMessage
  | JobToggleMessage
  | JobPackageMessage
  | PingMessage;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @hub/wss-protocol test`
Expected: PASS

- [ ] **Step 5: Generate Go types**

Run: `pnpm --filter @hub/wss-protocol run gen:go`
Expected: regenerated `apps/agent/internal/wss/messages_gen.go` includes `JobToggleMessage`.

- [ ] **Step 6: Commit**

```bash
git add packages/wss-protocol apps/agent/internal/wss/messages_gen.go
git commit -m "feat(wss): add job.toggle message type for plugin enable/disable"
```

---

## Task 2: Manifest parser registry (generic)

**Files:**
- Create: `apps/agent/internal/manifest/registry.go`
- Test: `apps/agent/internal/manifest/registry_test.go`

- [ ] **Step 1: Write the failing test**

```go
// apps/agent/internal/manifest/registry_test.go
package manifest

import (
	"testing"

	"github.com/claude-hub/agent/internal/api"
)

type fakeParser struct{ t api.ArtifactType }

func (f fakeParser) Type() api.ArtifactType { return f.t }
func (f fakeParser) Parse(path string) (Manifest, error) {
	return Manifest{Type: f.t, Slug: "x", Description: "d"}, nil
}

func TestRegistry_LookupByType(t *testing.T) {
	r := NewRegistry()
	r.Register(fakeParser{t: api.ArtifactPlugin})
	p, ok := r.For(api.ArtifactPlugin)
	if !ok || p.Type() != api.ArtifactPlugin {
		t.Fatalf("expected plugin parser, got %v", p)
	}
}

func TestRegistry_UnknownType(t *testing.T) {
	r := NewRegistry()
	if _, ok := r.For(api.ArtifactCommand); ok {
		t.Fatal("expected miss for unregistered type")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/manifest/ -run TestRegistry -v`
Expected: FAIL — `NewRegistry undefined`

- [ ] **Step 3: Implement registry**

```go
// apps/agent/internal/manifest/registry.go
// SPDX-License-Identifier: Apache-2.0
package manifest

import "github.com/claude-hub/agent/internal/api"

type Manifest struct {
	Type        api.ArtifactType
	Slug        string
	Version     string
	Description string
	TypeMeta    map[string]any
}

type Parser interface {
	Type() api.ArtifactType
	Parse(path string) (Manifest, error)
}

type Registry struct{ parsers map[api.ArtifactType]Parser }

func NewRegistry() *Registry { return &Registry{parsers: map[api.ArtifactType]Parser{}} }

func (r *Registry) Register(p Parser) { r.parsers[p.Type()] = p }

func (r *Registry) For(t api.ArtifactType) (Parser, bool) {
	p, ok := r.parsers[t]
	return p, ok
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/manifest/ -run TestRegistry -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/agent/internal/manifest/registry.go apps/agent/internal/manifest/registry_test.go
git commit -m "feat(agent): add manifest parser registry for multi-type support"
```

---

## Task 3: Plugin manifest parser — happy path

**Files:**
- Create: `apps/agent/internal/manifest/plugin.go`
- Test: `apps/agent/internal/manifest/plugin_test.go`

- [ ] **Step 1: Write the failing test**

```go
// apps/agent/internal/manifest/plugin_test.go
package manifest

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPluginParser_ParseValid(t *testing.T) {
	dir := t.TempDir()
	pluginDir := filepath.Join(dir, "org-tooling", ".claude-plugin")
	if err := os.MkdirAll(pluginDir, 0o755); err != nil {
		t.Fatal(err)
	}
	json := `{
		"name": "org-tooling",
		"version": "1.2.0",
		"description": "Internal tools",
		"commands": ["a.md", "b.md"],
		"agents": ["x.md"],
		"skills": [],
		"hooks": [],
		"mcp": []
	}`
	if err := os.WriteFile(filepath.Join(pluginDir, "plugin.json"), []byte(json), 0o644); err != nil {
		t.Fatal(err)
	}

	p := PluginParser{}
	m, err := p.Parse(filepath.Join(dir, "org-tooling"))
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if m.Slug != "org-tooling" || m.Version != "1.2.0" || m.Description != "Internal tools" {
		t.Fatalf("bad manifest: %+v", m)
	}
	if m.TypeMeta["commands"].(int) != 2 || m.TypeMeta["agents"].(int) != 1 || m.TypeMeta["skills"].(int) != 0 {
		t.Fatalf("bad counts: %+v", m.TypeMeta)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/manifest/ -run TestPluginParser_ParseValid -v`
Expected: FAIL — `PluginParser undefined`

- [ ] **Step 3: Implement plugin parser**

```go
// apps/agent/internal/manifest/plugin.go
// SPDX-License-Identifier: Apache-2.0
package manifest

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/claude-hub/agent/internal/api"
)

type PluginParser struct{}

func (PluginParser) Type() api.ArtifactType { return api.ArtifactPlugin }

type pluginJSON struct {
	Name        string   `json:"name"`
	Version     string   `json:"version"`
	Description string   `json:"description"`
	Commands    []string `json:"commands"`
	Agents      []string `json:"agents"`
	Skills      []string `json:"skills"`
	Hooks       []string `json:"hooks"`
	MCP         []string `json:"mcp"`
}

func (PluginParser) Parse(pluginRoot string) (Manifest, error) {
	jsonPath := filepath.Join(pluginRoot, ".claude-plugin", "plugin.json")
	data, err := os.ReadFile(jsonPath)
	if err != nil {
		return Manifest{}, fmt.Errorf("read plugin.json: %w", err)
	}
	var p pluginJSON
	if err := json.Unmarshal(data, &p); err != nil {
		return Manifest{}, fmt.Errorf("parse plugin.json: %w", err)
	}
	if p.Name == "" {
		return Manifest{}, errors.New("plugin.json: name is required")
	}
	if !semverLike(p.Version) {
		return Manifest{}, fmt.Errorf("plugin.json: version %q is not semver-like", p.Version)
	}
	return Manifest{
		Type:        api.ArtifactPlugin,
		Slug:        p.Name,
		Version:     p.Version,
		Description: p.Description,
		TypeMeta: map[string]any{
			"commands": len(p.Commands),
			"agents":   len(p.Agents),
			"skills":   len(p.Skills),
			"hooks":    len(p.Hooks),
			"mcp":      len(p.MCP),
		},
	}, nil
}
```

Add `semverLike` to a shared helper file `apps/agent/internal/manifest/semver.go`:

```go
// SPDX-License-Identifier: Apache-2.0
package manifest

import "regexp"

var semverRe = regexp.MustCompile(`^\d+\.\d+\.\d+$`)

func semverLike(v string) bool { return semverRe.MatchString(v) }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/manifest/ -run TestPluginParser_ParseValid -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/agent/internal/manifest/plugin.go apps/agent/internal/manifest/semver.go apps/agent/internal/manifest/plugin_test.go
git commit -m "feat(agent): add plugin.json manifest parser"
```

---

## Task 4: Plugin parser — validation failures

**Files:**
- Modify: `apps/agent/internal/manifest/plugin_test.go`

- [ ] **Step 1: Write the failing test**

```go
func TestPluginParser_RejectsEmptyName(t *testing.T) {
	dir := t.TempDir()
	pluginDir := filepath.Join(dir, "x", ".claude-plugin")
	os.MkdirAll(pluginDir, 0o755)
	os.WriteFile(filepath.Join(pluginDir, "plugin.json"),
		[]byte(`{"name":"","version":"1.0.0"}`), 0o644)
	if _, err := (PluginParser{}).Parse(filepath.Join(dir, "x")); err == nil {
		t.Fatal("expected error for empty name")
	}
}

func TestPluginParser_RejectsBadVersion(t *testing.T) {
	dir := t.TempDir()
	pluginDir := filepath.Join(dir, "x", ".claude-plugin")
	os.MkdirAll(pluginDir, 0o755)
	os.WriteFile(filepath.Join(pluginDir, "plugin.json"),
		[]byte(`{"name":"x","version":"v1"}`), 0o644)
	if _, err := (PluginParser{}).Parse(filepath.Join(dir, "x")); err == nil {
		t.Fatal("expected error for bad semver")
	}
}

func TestPluginParser_RejectsMissingFile(t *testing.T) {
	dir := t.TempDir()
	if _, err := (PluginParser{}).Parse(filepath.Join(dir, "ghost")); err == nil {
		t.Fatal("expected error for missing plugin.json")
	}
}
```

- [ ] **Step 2: Run tests to verify they pass (Task 3 implementation already covers these)**

Run: `go test ./internal/manifest/ -run TestPluginParser -v`
Expected: PASS for all four cases.

- [ ] **Step 3: Commit**

```bash
git add apps/agent/internal/manifest/plugin_test.go
git commit -m "test(agent): cover plugin manifest validation errors"
```

---

## Task 5: Command manifest parser

**Files:**
- Create: `apps/agent/internal/manifest/command.go`
- Test: `apps/agent/internal/manifest/command_test.go`

- [ ] **Step 1: Write the failing test**

```go
// apps/agent/internal/manifest/command_test.go
package manifest

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCommandParser_ParseValid(t *testing.T) {
	dir := t.TempDir()
	body := `---
description: Deploy current branch to staging
argument-hint: "[env]"
allowed-tools:
  - Bash
  - Read
---
Deploy the current branch.
`
	path := filepath.Join(dir, "deploy.md")
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	m, err := (CommandParser{}).Parse(path)
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if m.Slug != "deploy" || m.Description != "Deploy current branch to staging" {
		t.Fatalf("bad manifest: %+v", m)
	}
	if m.TypeMeta["argumentHint"].(string) != "[env]" {
		t.Fatalf("bad argument hint: %v", m.TypeMeta["argumentHint"])
	}
	tools := m.TypeMeta["allowedTools"].([]string)
	if len(tools) != 2 || tools[0] != "Bash" {
		t.Fatalf("bad allowedTools: %v", tools)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/manifest/ -run TestCommandParser_ParseValid -v`
Expected: FAIL — `CommandParser undefined`

- [ ] **Step 3: Implement command parser**

```go
// apps/agent/internal/manifest/command.go
// SPDX-License-Identifier: Apache-2.0
package manifest

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/claude-hub/agent/internal/api"
	"gopkg.in/yaml.v3"
)

type CommandParser struct{}

func (CommandParser) Type() api.ArtifactType { return api.ArtifactCommand }

type commandFM struct {
	Description  string   `yaml:"description"`
	ArgumentHint string   `yaml:"argument-hint"`
	AllowedTools []string `yaml:"allowed-tools"`
}

func (CommandParser) Parse(mdPath string) (Manifest, error) {
	data, err := os.ReadFile(mdPath)
	if err != nil {
		return Manifest{}, fmt.Errorf("read %s: %w", mdPath, err)
	}
	fm, _, err := splitFrontmatter(data)
	if err != nil {
		return Manifest{}, err
	}
	var c commandFM
	if err := yaml.Unmarshal(fm, &c); err != nil {
		return Manifest{}, fmt.Errorf("parse frontmatter: %w", err)
	}
	slug := strings.TrimSuffix(filepath.Base(mdPath), ".md")
	if slug == "" {
		return Manifest{}, fmt.Errorf("empty slug for %s", mdPath)
	}
	return Manifest{
		Type:        api.ArtifactCommand,
		Slug:        slug,
		Description: c.Description,
		TypeMeta: map[string]any{
			"argumentHint": c.ArgumentHint,
			"allowedTools": c.AllowedTools,
		},
	}, nil
}
```

Add a shared `splitFrontmatter` helper in `apps/agent/internal/manifest/frontmatter.go`:

```go
// SPDX-License-Identifier: Apache-2.0
package manifest

import (
	"bytes"
	"errors"
)

var fmDelim = []byte("---\n")

func splitFrontmatter(data []byte) (front []byte, body []byte, err error) {
	if !bytes.HasPrefix(data, fmDelim) {
		return nil, nil, errors.New("missing frontmatter")
	}
	rest := data[len(fmDelim):]
	end := bytes.Index(rest, fmDelim)
	if end < 0 {
		return nil, nil, errors.New("unterminated frontmatter")
	}
	return rest[:end], rest[end+len(fmDelim):], nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/manifest/ -run TestCommandParser -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/agent/internal/manifest/command.go apps/agent/internal/manifest/frontmatter.go apps/agent/internal/manifest/command_test.go
git commit -m "feat(agent): add slash command manifest parser"
```

---

## Task 6: Agent manifest parser

**Files:**
- Create: `apps/agent/internal/manifest/agent.go`
- Test: `apps/agent/internal/manifest/agent_test.go`

- [ ] **Step 1: Write the failing test**

```go
// apps/agent/internal/manifest/agent_test.go
package manifest

import (
	"os"
	"path/filepath"
	"testing"
)

func TestAgentParser_ParseValid(t *testing.T) {
	dir := t.TempDir()
	body := `---
name: code-reviewer
description: Reviews PRs
model: claude-opus-4-7
tools:
  - Read
  - Grep
---
You are a careful code reviewer.
`
	path := filepath.Join(dir, "code-reviewer.md")
	os.WriteFile(path, []byte(body), 0o644)
	m, err := (AgentParser{}).Parse(path)
	if err != nil {
		t.Fatal(err)
	}
	if m.Slug != "code-reviewer" || m.Description != "Reviews PRs" {
		t.Fatalf("bad manifest: %+v", m)
	}
	if m.TypeMeta["model"].(string) != "claude-opus-4-7" {
		t.Fatalf("bad model: %v", m.TypeMeta["model"])
	}
	tools := m.TypeMeta["tools"].([]string)
	if len(tools) != 2 {
		t.Fatalf("bad tools: %v", tools)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/manifest/ -run TestAgentParser -v`
Expected: FAIL — `AgentParser undefined`

- [ ] **Step 3: Implement agent parser**

```go
// apps/agent/internal/manifest/agent.go
// SPDX-License-Identifier: Apache-2.0
package manifest

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/claude-hub/agent/internal/api"
	"gopkg.in/yaml.v3"
)

type AgentParser struct{}

func (AgentParser) Type() api.ArtifactType { return api.ArtifactAgent }

type agentFM struct {
	Name        string   `yaml:"name"`
	Description string   `yaml:"description"`
	Model       string   `yaml:"model"`
	Tools       []string `yaml:"tools"`
}

func (AgentParser) Parse(mdPath string) (Manifest, error) {
	data, err := os.ReadFile(mdPath)
	if err != nil {
		return Manifest{}, fmt.Errorf("read %s: %w", mdPath, err)
	}
	fm, _, err := splitFrontmatter(data)
	if err != nil {
		return Manifest{}, err
	}
	var a agentFM
	if err := yaml.Unmarshal(fm, &a); err != nil {
		return Manifest{}, fmt.Errorf("parse frontmatter: %w", err)
	}
	slug := strings.TrimSuffix(filepath.Base(mdPath), ".md")
	if a.Name != "" && a.Name != slug {
		return Manifest{}, fmt.Errorf("agent name %q does not match filename %q", a.Name, slug)
	}
	return Manifest{
		Type:        api.ArtifactAgent,
		Slug:        slug,
		Description: a.Description,
		TypeMeta: map[string]any{
			"model": a.Model,
			"tools": a.Tools,
		},
	}, nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/manifest/ -run TestAgentParser -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/agent/internal/manifest/agent.go apps/agent/internal/manifest/agent_test.go
git commit -m "feat(agent): add subagent manifest parser"
```

---

## Task 7: Plugin scanner

**Files:**
- Create: `apps/agent/internal/scanner/plugins.go`
- Test: `apps/agent/internal/scanner/plugins_test.go`

- [ ] **Step 1: Write the failing test**

```go
// apps/agent/internal/scanner/plugins_test.go
package scanner

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/claude-hub/agent/internal/api"
	"github.com/claude-hub/agent/internal/manifest"
)

func TestPluginScanner_ListsPluginDirs(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{"alpha", "beta"} {
		dir := filepath.Join(root, name, ".claude-plugin")
		os.MkdirAll(dir, 0o755)
		os.WriteFile(filepath.Join(dir, "plugin.json"),
			[]byte(`{"name":"`+name+`","version":"0.1.0","description":"d"}`), 0o644)
	}
	s := NewPluginScanner(root, manifest.PluginParser{})
	items, err := s.Scan()
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 2 {
		t.Fatalf("expected 2 plugins, got %d", len(items))
	}
	if items[0].Type != api.ArtifactPlugin {
		t.Fatalf("bad type: %v", items[0].Type)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/scanner/ -run TestPluginScanner -v`
Expected: FAIL — `NewPluginScanner undefined`

- [ ] **Step 3: Implement plugin scanner**

```go
// apps/agent/internal/scanner/plugins.go
// SPDX-License-Identifier: Apache-2.0
package scanner

import (
	"os"
	"path/filepath"

	"github.com/claude-hub/agent/internal/api"
	"github.com/claude-hub/agent/internal/manifest"
)

type PluginScanner struct {
	root   string
	parser manifest.PluginParser
}

func NewPluginScanner(root string, p manifest.PluginParser) *PluginScanner {
	return &PluginScanner{root: root, parser: p}
}

func (s *PluginScanner) Type() api.ArtifactType { return api.ArtifactPlugin }
func (s *PluginScanner) Root() string           { return s.root }

func (s *PluginScanner) Scan() ([]api.InventoryItem, error) {
	entries, err := os.ReadDir(s.root)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	out := make([]api.InventoryItem, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		path := filepath.Join(s.root, e.Name())
		m, err := s.parser.Parse(path)
		if err != nil {
			continue // skip malformed
		}
		out = append(out, api.InventoryItem{
			Type:    api.ArtifactPlugin,
			Slug:    m.Slug,
			Version: m.Version,
			Path:    path,
		})
	}
	return out, nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/scanner/ -run TestPluginScanner -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/agent/internal/scanner/plugins.go apps/agent/internal/scanner/plugins_test.go
git commit -m "feat(agent): add plugin filesystem scanner"
```

---

## Task 8: Command + Agent scanners (single-file types)

**Files:**
- Create: `apps/agent/internal/scanner/commands.go`
- Create: `apps/agent/internal/scanner/agents.go`
- Test: `apps/agent/internal/scanner/commands_test.go`
- Test: `apps/agent/internal/scanner/agents_test.go`

- [ ] **Step 1: Write the failing tests**

```go
// apps/agent/internal/scanner/commands_test.go
package scanner

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/claude-hub/agent/internal/manifest"
)

func TestCommandScanner_ListsMdFiles(t *testing.T) {
	root := t.TempDir()
	body := "---\ndescription: x\n---\nhi\n"
	os.WriteFile(filepath.Join(root, "deploy.md"), []byte(body), 0o644)
	os.WriteFile(filepath.Join(root, "rollback.md"), []byte(body), 0o644)
	os.WriteFile(filepath.Join(root, "ignored.txt"), []byte("nope"), 0o644)

	s := NewCommandScanner(root, manifest.CommandParser{})
	items, err := s.Scan()
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 2 {
		t.Fatalf("expected 2, got %d", len(items))
	}
}
```

```go
// apps/agent/internal/scanner/agents_test.go (analog)
package scanner

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/claude-hub/agent/internal/manifest"
)

func TestAgentScanner_ListsMdFiles(t *testing.T) {
	root := t.TempDir()
	body := "---\nname: reviewer\ndescription: x\n---\nhi\n"
	os.WriteFile(filepath.Join(root, "reviewer.md"), []byte(body), 0o644)
	s := NewAgentScanner(root, manifest.AgentParser{})
	items, _ := s.Scan()
	if len(items) != 1 {
		t.Fatalf("expected 1, got %d", len(items))
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/scanner/ -run "TestCommandScanner|TestAgentScanner" -v`
Expected: FAIL — constructors undefined

- [ ] **Step 3: Implement both scanners**

```go
// apps/agent/internal/scanner/commands.go
// SPDX-License-Identifier: Apache-2.0
package scanner

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/claude-hub/agent/internal/api"
	"github.com/claude-hub/agent/internal/manifest"
)

type CommandScanner struct {
	root   string
	parser manifest.CommandParser
}

func NewCommandScanner(root string, p manifest.CommandParser) *CommandScanner {
	return &CommandScanner{root: root, parser: p}
}

func (s *CommandScanner) Type() api.ArtifactType { return api.ArtifactCommand }
func (s *CommandScanner) Root() string           { return s.root }

func (s *CommandScanner) Scan() ([]api.InventoryItem, error) {
	return scanMarkdown(s.root, api.ArtifactCommand, func(p string) (manifest.Manifest, error) {
		return s.parser.Parse(p)
	})
}
```

```go
// apps/agent/internal/scanner/agents.go
// SPDX-License-Identifier: Apache-2.0
package scanner

import (
	"github.com/claude-hub/agent/internal/api"
	"github.com/claude-hub/agent/internal/manifest"
)

type AgentScanner struct {
	root   string
	parser manifest.AgentParser
}

func NewAgentScanner(root string, p manifest.AgentParser) *AgentScanner {
	return &AgentScanner{root: root, parser: p}
}

func (s *AgentScanner) Type() api.ArtifactType { return api.ArtifactAgent }
func (s *AgentScanner) Root() string           { return s.root }

func (s *AgentScanner) Scan() ([]api.InventoryItem, error) {
	return scanMarkdown(s.root, api.ArtifactAgent, func(p string) (manifest.Manifest, error) {
		return s.parser.Parse(p)
	})
}
```

```go
// apps/agent/internal/scanner/markdown.go
// SPDX-License-Identifier: Apache-2.0
package scanner

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/claude-hub/agent/internal/api"
	"github.com/claude-hub/agent/internal/manifest"
)

func scanMarkdown(root string, kind api.ArtifactType, parse func(string) (manifest.Manifest, error)) ([]api.InventoryItem, error) {
	entries, err := os.ReadDir(root)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	out := make([]api.InventoryItem, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".md") {
			continue
		}
		path := filepath.Join(root, e.Name())
		m, err := parse(path)
		if err != nil {
			continue
		}
		out = append(out, api.InventoryItem{
			Type: kind, Slug: m.Slug, Path: path,
		})
	}
	return out, nil
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/scanner/ -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/agent/internal/scanner/commands.go apps/agent/internal/scanner/agents.go apps/agent/internal/scanner/markdown.go apps/agent/internal/scanner/commands_test.go apps/agent/internal/scanner/agents_test.go
git commit -m "feat(agent): add command and agent filesystem scanners"
```

---

## Task 9: Scanner registry — aggregate all four types

**Files:**
- Modify: `apps/agent/internal/scanner/registry.go`
- Test: `apps/agent/internal/scanner/registry_test.go`

- [ ] **Step 1: Write the failing test**

```go
// apps/agent/internal/scanner/registry_test.go (replace content)
package scanner

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/claude-hub/agent/internal/api"
	"github.com/claude-hub/agent/internal/manifest"
)

func TestRegistry_AggregatesAllTypes(t *testing.T) {
	home := t.TempDir()
	// skill
	os.MkdirAll(filepath.Join(home, "skills", "s1"), 0o755)
	os.WriteFile(filepath.Join(home, "skills", "s1", "SKILL.md"),
		[]byte("---\nname: s1\ndescription: d\n---\n"), 0o644)
	// plugin
	os.MkdirAll(filepath.Join(home, "plugins", "p1", ".claude-plugin"), 0o755)
	os.WriteFile(filepath.Join(home, "plugins", "p1", ".claude-plugin", "plugin.json"),
		[]byte(`{"name":"p1","version":"0.1.0","description":"d"}`), 0o644)
	// command
	os.MkdirAll(filepath.Join(home, "commands"), 0o755)
	os.WriteFile(filepath.Join(home, "commands", "deploy.md"),
		[]byte("---\ndescription: d\n---\n"), 0o644)
	// agent
	os.MkdirAll(filepath.Join(home, "agents"), 0o755)
	os.WriteFile(filepath.Join(home, "agents", "rev.md"),
		[]byte("---\nname: rev\ndescription: d\n---\n"), 0o644)

	r := NewRegistry()
	r.Register(NewSkillScanner(filepath.Join(home, "skills"), manifest.SkillParser{}))
	r.Register(NewPluginScanner(filepath.Join(home, "plugins"), manifest.PluginParser{}))
	r.Register(NewCommandScanner(filepath.Join(home, "commands"), manifest.CommandParser{}))
	r.Register(NewAgentScanner(filepath.Join(home, "agents"), manifest.AgentParser{}))

	items, err := r.ScanAll()
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 4 {
		t.Fatalf("expected 4 items, got %d", len(items))
	}
	counts := map[api.ArtifactType]int{}
	for _, it := range items {
		counts[it.Type]++
	}
	for _, k := range []api.ArtifactType{api.ArtifactSkill, api.ArtifactPlugin, api.ArtifactCommand, api.ArtifactAgent} {
		if counts[k] != 1 {
			t.Fatalf("missing type %s: counts=%v", k, counts)
		}
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/scanner/ -run TestRegistry_AggregatesAllTypes -v`
Expected: FAIL — `Register` does not accept new scanners

- [ ] **Step 3: Update registry**

```go
// apps/agent/internal/scanner/registry.go
// SPDX-License-Identifier: Apache-2.0
package scanner

import (
	"github.com/claude-hub/agent/internal/api"
)

type Provider interface {
	Type() api.ArtifactType
	Root() string
	Scan() ([]api.InventoryItem, error)
}

type Registry struct {
	providers []Provider
}

func NewRegistry() *Registry { return &Registry{} }

func (r *Registry) Register(p Provider) { r.providers = append(r.providers, p) }

func (r *Registry) Providers() []Provider { return r.providers }

func (r *Registry) ScanAll() ([]api.InventoryItem, error) {
	var all []api.InventoryItem
	for _, p := range r.providers {
		items, err := p.Scan()
		if err != nil {
			return nil, err
		}
		all = append(all, items...)
	}
	return all, nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/scanner/ -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/agent/internal/scanner/registry.go apps/agent/internal/scanner/registry_test.go
git commit -m "feat(agent): aggregate skills/plugins/commands/agents in scanner registry"
```

---

## Task 10: Wire watchers for all four roots in daemon main

**Files:**
- Modify: `apps/agent/cmd/agent/main.go`
- Test: `apps/agent/internal/scanner/watcher_test.go`

- [ ] **Step 1: Write the failing test**

```go
// apps/agent/internal/scanner/watcher_test.go
package scanner

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestWatcher_FiresForAllRoots(t *testing.T) {
	home := t.TempDir()
	for _, sub := range []string{"skills", "plugins", "commands", "agents"} {
		os.MkdirAll(filepath.Join(home, sub), 0o755)
	}
	w, err := NewMultiRootWatcher([]string{
		filepath.Join(home, "skills"),
		filepath.Join(home, "plugins"),
		filepath.Join(home, "commands"),
		filepath.Join(home, "agents"),
	})
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()

	events := make(chan string, 4)
	go w.Run(func(path string) { events <- path })

	for _, sub := range []string{"skills", "plugins", "commands", "agents"} {
		os.WriteFile(filepath.Join(home, sub, "ping.txt"), []byte("x"), 0o644)
	}
	deadline := time.After(2 * time.Second)
	got := 0
	for got < 4 {
		select {
		case <-events:
			got++
		case <-deadline:
			t.Fatalf("only got %d events", got)
		}
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/scanner/ -run TestWatcher_FiresForAllRoots -v`
Expected: FAIL — `NewMultiRootWatcher undefined`

- [ ] **Step 3: Implement multi-root watcher**

```go
// apps/agent/internal/scanner/watcher.go
// SPDX-License-Identifier: Apache-2.0
package scanner

import "github.com/fsnotify/fsnotify"

type MultiRootWatcher struct {
	w *fsnotify.Watcher
}

func NewMultiRootWatcher(roots []string) (*MultiRootWatcher, error) {
	w, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	for _, r := range roots {
		if err := w.Add(r); err != nil {
			w.Close()
			return nil, err
		}
	}
	return &MultiRootWatcher{w: w}, nil
}

func (m *MultiRootWatcher) Run(onChange func(path string)) {
	for ev := range m.w.Events {
		onChange(ev.Name)
	}
}

func (m *MultiRootWatcher) Close() error { return m.w.Close() }
```

Modify daemon entrypoint to wire all four roots:

```go
// apps/agent/cmd/agent/main.go (relevant excerpt)
home := os.Getenv("CLAUDE_HOME")
if home == "" {
	h, _ := os.UserHomeDir()
	home = filepath.Join(h, ".claude")
}
reg := scanner.NewRegistry()
reg.Register(scanner.NewSkillScanner(filepath.Join(home, "skills"), manifest.SkillParser{}))
reg.Register(scanner.NewPluginScanner(filepath.Join(home, "plugins"), manifest.PluginParser{}))
reg.Register(scanner.NewCommandScanner(filepath.Join(home, "commands"), manifest.CommandParser{}))
reg.Register(scanner.NewAgentScanner(filepath.Join(home, "agents"), manifest.AgentParser{}))

watcher, err := scanner.NewMultiRootWatcher([]string{
	filepath.Join(home, "skills"),
	filepath.Join(home, "plugins"),
	filepath.Join(home, "commands"),
	filepath.Join(home, "agents"),
})
if err != nil { log.Fatal(err) }
go watcher.Run(func(_ string) { syncer.Resnapshot(reg) })
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/scanner/ -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/agent/cmd/agent/main.go apps/agent/internal/scanner/watcher.go apps/agent/internal/scanner/watcher_test.go
git commit -m "feat(agent): watch all four artifact roots and feed unified inventory"
```

---

## Task 11: Install job — per-type install paths

**Files:**
- Modify: `apps/agent/internal/jobs/install.go`
- Test: `apps/agent/internal/jobs/install_test.go`

- [ ] **Step 1: Write the failing test**

```go
// apps/agent/internal/jobs/install_test.go (append)
func TestInstall_PluginExtractsToPluginsDir(t *testing.T) {
	home := t.TempDir()
	tarPath := makeTarGz(t, map[string]string{
		"org-tooling/.claude-plugin/plugin.json": `{"name":"org-tooling","version":"0.1.0","description":"d"}`,
	})

	r := Runner{Home: home}
	err := r.Install(InstallJob{
		ArtifactID: "a-1",
		Type:       api.ArtifactPlugin,
		Slug:       "org-tooling",
		ArchivePath: tarPath,
		Sha256:      sha256OfFile(t, tarPath),
	})
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(home, "plugins", "org-tooling", ".claude-plugin", "plugin.json")
	if _, err := os.Stat(want); err != nil {
		t.Fatalf("plugin not extracted: %v", err)
	}
}

func TestInstall_CommandWritesSingleFile(t *testing.T) {
	home := t.TempDir()
	tarPath := makeTarGz(t, map[string]string{
		"deploy.md": "---\ndescription: d\n---\n",
	})
	r := Runner{Home: home}
	err := r.Install(InstallJob{
		ArtifactID: "a-2",
		Type:       api.ArtifactCommand,
		Slug:       "deploy",
		ArchivePath: tarPath,
		Sha256:      sha256OfFile(t, tarPath),
	})
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(home, "commands", "deploy.md")
	if _, err := os.Stat(want); err != nil {
		t.Fatalf("command not extracted: %v", err)
	}
}

func TestInstall_AgentWritesSingleFile(t *testing.T) {
	home := t.TempDir()
	tarPath := makeTarGz(t, map[string]string{
		"rev.md": "---\nname: rev\ndescription: d\n---\n",
	})
	r := Runner{Home: home}
	err := r.Install(InstallJob{
		ArtifactID: "a-3",
		Type:       api.ArtifactAgent,
		Slug:       "rev",
		ArchivePath: tarPath,
		Sha256:      sha256OfFile(t, tarPath),
	})
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(home, "agents", "rev.md")
	if _, err := os.Stat(want); err != nil {
		t.Fatalf("agent not extracted: %v", err)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/jobs/ -run TestInstall -v`
Expected: FAIL — install only handles skill type from Plan 3

- [ ] **Step 3: Implement per-type routing**

```go
// apps/agent/internal/jobs/install.go (extend)
func (r Runner) destinationFor(j InstallJob) (string, error) {
	if !slugRe.MatchString(j.Slug) {
		return "", fmt.Errorf("invalid slug %q", j.Slug)
	}
	switch j.Type {
	case api.ArtifactSkill:
		return filepath.Join(r.Home, "skills", j.Slug), nil
	case api.ArtifactPlugin:
		return filepath.Join(r.Home, "plugins", j.Slug), nil
	case api.ArtifactCommand:
		return filepath.Join(r.Home, "commands", j.Slug+".md"), nil
	case api.ArtifactAgent:
		return filepath.Join(r.Home, "agents", j.Slug+".md"), nil
	default:
		return "", fmt.Errorf("unsupported type %q", j.Type)
	}
}

func (r Runner) Install(j InstallJob) error {
	if err := r.verifySha256(j.ArchivePath, j.Sha256); err != nil {
		return err
	}
	dst, err := r.destinationFor(j)
	if err != nil {
		return err
	}
	if err := r.backupIfExists(dst); err != nil {
		return err
	}
	switch j.Type {
	case api.ArtifactCommand, api.ArtifactAgent:
		return r.extractSingleFile(j.ArchivePath, dst, j.Slug+".md")
	default:
		return r.extractDir(j.ArchivePath, dst)
	}
}
```

`extractSingleFile` reads exactly one entry whose basename matches `wantName` and writes it to `dst`; reject archives with extra entries to prevent path traversal payloads.

```go
func (r Runner) extractSingleFile(tarGz, dst, wantName string) error {
	gz, _ := os.Open(tarGz)
	defer gz.Close()
	gr, _ := gzip.NewReader(gz)
	tr := tar.NewReader(gr)
	wrote := false
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		if filepath.Base(h.Name) != wantName || h.Typeflag != tar.TypeReg {
			return fmt.Errorf("unexpected archive entry %q", h.Name)
		}
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return err
		}
		f, err := os.Create(dst)
		if err != nil {
			return err
		}
		if _, err := io.Copy(f, tr); err != nil {
			f.Close()
			return err
		}
		f.Close()
		wrote = true
	}
	if !wrote {
		return fmt.Errorf("no %q in archive", wantName)
	}
	return nil
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/jobs/ -run TestInstall -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/agent/internal/jobs/install.go apps/agent/internal/jobs/install_test.go
git commit -m "feat(agent): install plugin/command/agent artifacts per type"
```

---

## Task 12: Uninstall — per-type cleanup with backup

**Files:**
- Modify: `apps/agent/internal/jobs/uninstall.go`
- Test: `apps/agent/internal/jobs/uninstall_test.go`

- [ ] **Step 1: Write the failing test**

```go
// apps/agent/internal/jobs/uninstall_test.go (append)
func TestUninstall_CommandMovesFileToBackup(t *testing.T) {
	home := t.TempDir()
	cmdPath := filepath.Join(home, "commands", "deploy.md")
	os.MkdirAll(filepath.Dir(cmdPath), 0o755)
	os.WriteFile(cmdPath, []byte("body"), 0o644)

	r := Runner{Home: home}
	if err := r.Uninstall(UninstallJob{Type: api.ArtifactCommand, Slug: "deploy"}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(cmdPath); !os.IsNotExist(err) {
		t.Fatal("command file still present")
	}
	matches, _ := filepath.Glob(filepath.Join(home, ".claude-hub-backup", "commands", "deploy-*.md"))
	if len(matches) != 1 {
		t.Fatalf("expected backup, got %v", matches)
	}
}

func TestUninstall_PluginMovesDirToBackup(t *testing.T) {
	home := t.TempDir()
	plugDir := filepath.Join(home, "plugins", "org-tooling")
	os.MkdirAll(plugDir, 0o755)
	os.WriteFile(filepath.Join(plugDir, "x.txt"), []byte("y"), 0o644)
	r := Runner{Home: home}
	if err := r.Uninstall(UninstallJob{Type: api.ArtifactPlugin, Slug: "org-tooling"}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(plugDir); !os.IsNotExist(err) {
		t.Fatal("plugin still present")
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/jobs/ -run TestUninstall -v`
Expected: FAIL — uninstall covers only skill in Plan 3

- [ ] **Step 3: Implement per-type uninstall**

```go
// apps/agent/internal/jobs/uninstall.go (extend)
func (r Runner) Uninstall(j UninstallJob) error {
	switch j.Type {
	case api.ArtifactSkill, api.ArtifactPlugin:
		return r.moveDirToBackup(j)
	case api.ArtifactCommand, api.ArtifactAgent:
		return r.moveFileToBackup(j)
	default:
		return fmt.Errorf("unsupported type %q", j.Type)
	}
}

func (r Runner) moveFileToBackup(j UninstallJob) error {
	src := filepath.Join(r.Home, subdirFor(j.Type), j.Slug+".md")
	if _, err := os.Stat(src); err != nil {
		return err
	}
	stamp := time.Now().UTC().Format("20060102T150405Z")
	dstDir := filepath.Join(r.Home, ".claude-hub-backup", subdirFor(j.Type))
	os.MkdirAll(dstDir, 0o755)
	dst := filepath.Join(dstDir, fmt.Sprintf("%s-%s.md", j.Slug, stamp))
	return os.Rename(src, dst)
}

func subdirFor(t api.ArtifactType) string {
	return map[api.ArtifactType]string{
		api.ArtifactSkill: "skills", api.ArtifactPlugin: "plugins",
		api.ArtifactCommand: "commands", api.ArtifactAgent: "agents",
	}[t]
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/jobs/ -run TestUninstall -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/agent/internal/jobs/uninstall.go apps/agent/internal/jobs/uninstall_test.go
git commit -m "feat(agent): uninstall plugin/command/agent with timestamped backup"
```

---

## Task 13: Toggle job — atomic edit of `settings.json` (happy path)

**Files:**
- Create: `apps/agent/internal/jobs/toggle.go`
- Test: `apps/agent/internal/jobs/toggle_test.go`

- [ ] **Step 1: Write the failing test**

```go
// apps/agent/internal/jobs/toggle_test.go
package jobs

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/claude-hub/agent/internal/api"
)

func readSettings(t *testing.T, home string) map[string]any {
	data, err := os.ReadFile(filepath.Join(home, "settings.json"))
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func TestToggle_SetsEnabledTrue(t *testing.T) {
	home := t.TempDir()
	os.WriteFile(filepath.Join(home, "settings.json"),
		[]byte(`{"theme":"dark"}`), 0o644)

	r := Runner{Home: home}
	if err := r.Toggle(ToggleJob{Type: api.ArtifactPlugin, Slug: "org-tooling", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	got := readSettings(t, home)
	ep := got["enabledPlugins"].(map[string]any)
	if ep["org-tooling"] != true {
		t.Fatalf("expected enabled true, got %v", ep)
	}
	if got["theme"] != "dark" {
		t.Fatal("did not preserve other keys")
	}
}

func TestToggle_CreatesEnabledPluginsKey(t *testing.T) {
	home := t.TempDir()
	os.WriteFile(filepath.Join(home, "settings.json"), []byte(`{}`), 0o644)
	r := Runner{Home: home}
	if err := r.Toggle(ToggleJob{Type: api.ArtifactPlugin, Slug: "x", Enabled: false}); err != nil {
		t.Fatal(err)
	}
	got := readSettings(t, home)
	if got["enabledPlugins"].(map[string]any)["x"] != false {
		t.Fatalf("missing key: %v", got)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/jobs/ -run TestToggle -v`
Expected: FAIL — `Toggle` undefined

- [ ] **Step 3: Implement toggle**

```go
// apps/agent/internal/jobs/toggle.go
// SPDX-License-Identifier: Apache-2.0
package jobs

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/claude-hub/agent/internal/api"
)

type ToggleJob struct {
	Type    api.ArtifactType
	Slug    string
	Enabled bool
}

var ErrToggleNotSupported = errors.New("toggle not supported for type in MVP")

func (r Runner) Toggle(j ToggleJob) error {
	if j.Type != api.ArtifactPlugin {
		return fmt.Errorf("%w: %s", ErrToggleNotSupported, j.Type)
	}
	settingsPath := filepath.Join(r.Home, "settings.json")
	current := map[string]any{}
	if data, err := os.ReadFile(settingsPath); err == nil {
		if len(data) > 0 {
			if err := json.Unmarshal(data, &current); err != nil {
				return fmt.Errorf("parse settings.json: %w", err)
			}
		}
	} else if !os.IsNotExist(err) {
		return err
	}

	enabled, _ := current["enabledPlugins"].(map[string]any)
	if enabled == nil {
		enabled = map[string]any{}
	}
	enabled[j.Slug] = j.Enabled
	current["enabledPlugins"] = enabled

	data, err := json.MarshalIndent(current, "", "  ")
	if err != nil {
		return err
	}
	return atomicWrite(settingsPath, data)
}

func atomicWrite(path string, data []byte) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".settings-*.tmp")
	if err != nil {
		return err
	}
	if _, err := io.Copy(tmp, byteReader(data)); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	tmp.Close()
	return os.Rename(tmp.Name(), path)
}

type byteReader []byte

func (b byteReader) Read(p []byte) (int, error) {
	if len(b) == 0 {
		return 0, io.EOF
	}
	n := copy(p, b)
	return n, nil
}
```

(Note: prefer `bytes.NewReader` in real implementation; the inline reader is shown for clarity.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/jobs/ -run TestToggle -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/agent/internal/jobs/toggle.go apps/agent/internal/jobs/toggle_test.go
git commit -m "feat(agent): atomic plugin toggle via settings.json"
```

---

## Task 14: Toggle job — refuse non-plugin types

**Files:**
- Modify: `apps/agent/internal/jobs/toggle_test.go`

- [ ] **Step 1: Write the failing test**

```go
func TestToggle_RejectsSkill(t *testing.T) {
	r := Runner{Home: t.TempDir()}
	err := r.Toggle(ToggleJob{Type: api.ArtifactSkill, Slug: "x", Enabled: true})
	if !errors.Is(err, ErrToggleNotSupported) {
		t.Fatalf("expected ErrToggleNotSupported, got %v", err)
	}
}

func TestToggle_RejectsCommand(t *testing.T) {
	r := Runner{Home: t.TempDir()}
	err := r.Toggle(ToggleJob{Type: api.ArtifactCommand, Slug: "x", Enabled: true})
	if !errors.Is(err, ErrToggleNotSupported) {
		t.Fatal(err)
	}
}

func TestToggle_RejectsAgent(t *testing.T) {
	r := Runner{Home: t.TempDir()}
	err := r.Toggle(ToggleJob{Type: api.ArtifactAgent, Slug: "x", Enabled: true})
	if !errors.Is(err, ErrToggleNotSupported) {
		t.Fatal(err)
	}
}
```

- [ ] **Step 2: Run tests**

Run: `go test ./internal/jobs/ -run TestToggle_Rejects -v`
Expected: PASS (Task 13 already enforces this).

- [ ] **Step 3: Commit**

```bash
git add apps/agent/internal/jobs/toggle_test.go
git commit -m "test(agent): toggle rejects skill/command/agent types"
```

---

## Task 15: Local API — `/v1/toggle` endpoint

**Files:**
- Modify: `apps/agent/internal/api/local/router.go`
- Test: `apps/agent/internal/api/local/router_test.go`

- [ ] **Step 1: Write the failing test**

```go
// apps/agent/internal/api/local/router_test.go (append)
func TestLocalAPI_ToggleEnablesPlugin(t *testing.T) {
	home := t.TempDir()
	os.WriteFile(filepath.Join(home, "settings.json"), []byte(`{}`), 0o644)
	srv := newTestServer(t, home)
	defer srv.Close()

	body := `{"artifactId":"a-1","slug":"p1","type":"plugin","enabled":true}`
	resp := postJSON(t, srv.URL+"/v1/toggle", body)
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	data, _ := os.ReadFile(filepath.Join(home, "settings.json"))
	if !strings.Contains(string(data), `"p1": true`) {
		t.Fatalf("settings not updated: %s", data)
	}
}

func TestLocalAPI_ToggleSkillReturns400(t *testing.T) {
	srv := newTestServer(t, t.TempDir())
	defer srv.Close()
	body := `{"artifactId":"a-2","slug":"s","type":"skill","enabled":true}`
	resp := postJSON(t, srv.URL+"/v1/toggle", body)
	if resp.StatusCode != 400 {
		t.Fatalf("expected 400, got %d", resp.StatusCode)
	}
}
```

- [ ] **Step 2: Run tests**

Run: `go test ./internal/api/local/ -run TestLocalAPI_Toggle -v`
Expected: FAIL — endpoint not wired

- [ ] **Step 3: Wire toggle route**

```go
// apps/agent/internal/api/local/router.go (excerpt)
mux.HandleFunc("/v1/toggle", func(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" { http.Error(w, "method", 405); return }
	var req struct {
		ArtifactID string             `json:"artifactId"`
		Slug       string             `json:"slug"`
		Type       api.ArtifactType   `json:"type"`
		Enabled    bool               `json:"enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad json", 400); return
	}
	err := h.Runner.Toggle(jobs.ToggleJob{Type: req.Type, Slug: req.Slug, Enabled: req.Enabled})
	if errors.Is(err, jobs.ErrToggleNotSupported) {
		http.Error(w, "toggle not supported for type", 400); return
	}
	if err != nil {
		http.Error(w, err.Error(), 500); return
	}
	w.WriteHeader(200)
})
```

- [ ] **Step 4: Run tests**

Run: `go test ./internal/api/local/ -run TestLocalAPI_Toggle -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/agent/internal/api/local/router.go apps/agent/internal/api/local/router_test.go
git commit -m "feat(agent): expose POST /v1/toggle on local API"
```

---

## Task 16: WSS router — handle `job.toggle` from hub

**Files:**
- Modify: `apps/agent/internal/wss/router.go`
- Test: `apps/agent/internal/wss/router_test.go`

- [ ] **Step 1: Write the failing test**

```go
// apps/agent/internal/wss/router_test.go (append)
func TestWSSRouter_DispatchesJobToggle(t *testing.T) {
	home := t.TempDir()
	os.WriteFile(filepath.Join(home, "settings.json"), []byte(`{}`), 0o644)
	results := make(chan JobResult, 1)
	r := NewRouter(jobs.Runner{Home: home}, func(res JobResult) { results <- res })

	r.Dispatch([]byte(`{"type":"job.toggle","id":"j-1","payload":{"artifactId":"a-1","slug":"p1","enabled":true}}`))

	select {
	case res := <-results:
		if res.ID != "j-1" || res.Status != "success" {
			t.Fatalf("bad result: %+v", res)
		}
	case <-time.After(time.Second):
		t.Fatal("no result")
	}
}
```

- [ ] **Step 2: Run test**

Run: `go test ./internal/wss/ -run TestWSSRouter_DispatchesJobToggle -v`
Expected: FAIL

- [ ] **Step 3: Implement `job.toggle` branch**

```go
// apps/agent/internal/wss/router.go (excerpt)
case "job.toggle":
	var p struct {
		ArtifactID string `json:"artifactId"`
		Slug       string `json:"slug"`
		Enabled    bool   `json:"enabled"`
	}
	if err := json.Unmarshal(msg.Payload, &p); err != nil {
		r.report(JobResult{ID: msg.ID, Status: "error", Code: "bad_payload", Message: err.Error()})
		return
	}
	err := r.runner.Toggle(jobs.ToggleJob{Type: api.ArtifactPlugin, Slug: p.Slug, Enabled: p.Enabled})
	if err != nil {
		code := "toggle_failed"
		if errors.Is(err, jobs.ErrToggleNotSupported) { code = "not_supported_in_mvp" }
		r.report(JobResult{ID: msg.ID, Status: "error", Code: code, Message: err.Error()})
		return
	}
	r.report(JobResult{ID: msg.ID, Status: "success"})
```

Update `JobResult` to carry `Code` (string) and ensure existing handlers initialize it on success/error.

- [ ] **Step 4: Run tests**

Run: `go test ./internal/wss/ -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/agent/internal/wss/router.go apps/agent/internal/wss/router_test.go
git commit -m "feat(agent): handle job.toggle WSS message"
```

---

## Task 17: Hub-server zod schemas per type

**Files:**
- Create: `apps/hub-server/src/validators/manifest-plugin.ts`
- Create: `apps/hub-server/src/validators/manifest-command.ts`
- Create: `apps/hub-server/src/validators/manifest-agent.ts`
- Test: `apps/hub-server/test/unit/manifest-validators.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/hub-server/test/unit/manifest-validators.test.ts
import { describe, it, expect } from 'vitest';
import { pluginManifestSchema } from '../../src/validators/manifest-plugin';
import { commandManifestSchema } from '../../src/validators/manifest-command';
import { agentManifestSchema } from '../../src/validators/manifest-agent';

describe('plugin manifest', () => {
  it('accepts a minimal plugin', () => {
    const r = pluginManifestSchema.safeParse({
      schemaVersion: 1, name: 'org-tooling', type: 'plugin',
      description: 'd', typeMeta: { commands: 0, agents: 0, skills: 0, hooks: 0, mcp: 0 },
    });
    expect(r.success).toBe(true);
  });
  it('rejects a non-semver version in payload', () => {
    const r = pluginManifestSchema.safeParse({
      schemaVersion: 1, name: 'x', type: 'plugin', description: '',
      typeMeta: { commands: 'oops' as any },
    });
    expect(r.success).toBe(false);
  });
});

describe('command manifest', () => {
  it('accepts argument-hint + allowed-tools', () => {
    const r = commandManifestSchema.safeParse({
      schemaVersion: 1, name: 'deploy', type: 'command',
      description: 'd', typeMeta: { argumentHint: '[env]', allowedTools: ['Bash'] },
    });
    expect(r.success).toBe(true);
  });
});

describe('agent manifest', () => {
  it('accepts model + tools', () => {
    const r = agentManifestSchema.safeParse({
      schemaVersion: 1, name: 'rev', type: 'agent',
      description: 'd', typeMeta: { model: 'claude-opus-4-7', tools: ['Read'] },
    });
    expect(r.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test**

Run: `pnpm --filter hub-server test -- manifest-validators`
Expected: FAIL — modules don't exist

- [ ] **Step 3: Implement zod schemas**

```ts
// apps/hub-server/src/validators/manifest-plugin.ts
// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { slugSchema } from './slug';

export const pluginManifestSchema = z.object({
  schemaVersion: z.literal(1),
  name: slugSchema,
  type: z.literal('plugin'),
  description: z.string().max(500),
  typeMeta: z.object({
    commands: z.number().int().min(0),
    agents: z.number().int().min(0),
    skills: z.number().int().min(0),
    hooks: z.number().int().min(0),
    mcp: z.number().int().min(0),
  }),
});
```

```ts
// apps/hub-server/src/validators/manifest-command.ts
import { z } from 'zod';
import { slugSchema } from './slug';
export const commandManifestSchema = z.object({
  schemaVersion: z.literal(1),
  name: slugSchema,
  type: z.literal('command'),
  description: z.string().max(500),
  typeMeta: z.object({
    argumentHint: z.string().optional().default(''),
    allowedTools: z.array(z.string()).default([]),
  }),
});
```

```ts
// apps/hub-server/src/validators/manifest-agent.ts
import { z } from 'zod';
import { slugSchema } from './slug';
export const agentManifestSchema = z.object({
  schemaVersion: z.literal(1),
  name: slugSchema,
  type: z.literal('agent'),
  description: z.string().max(500),
  typeMeta: z.object({
    model: z.string().min(1),
    tools: z.array(z.string()).default([]),
  }),
});
```

```ts
// apps/hub-server/src/validators/slug.ts
import { z } from 'zod';
export const slugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter hub-server test -- manifest-validators`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/hub-server/src/validators apps/hub-server/test/unit/manifest-validators.test.ts
git commit -m "feat(server): add zod schemas for plugin/command/agent manifests"
```

---

## Task 18: Hub-server upload — per-type archive validation

**Files:**
- Modify: `apps/hub-server/src/routes/artifacts.ts`
- Create: `apps/hub-server/src/services/archive-inspector.ts`
- Test: `apps/hub-server/test/integration/upload-types.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/hub-server/test/integration/upload-types.test.ts
import { describe, it, expect } from 'vitest';
import { app } from '../../src/app';
import { tarGzFromMap, asMultipart, asMember } from '../helpers';

describe('upload per type', () => {
  it('accepts a valid plugin archive', async () => {
    const tar = await tarGzFromMap({
      'org-tooling/.claude-plugin/plugin.json':
        '{"name":"org-tooling","version":"0.1.0","description":"d"}',
    });
    const res = await app.request('/api/artifacts/upload',
      asMultipart({ type: 'plugin', slug: 'org-tooling', version: '0.1.0', archive: tar }, asMember()));
    expect(res.status).toBe(201);
  });

  it('rejects a plugin archive missing plugin.json', async () => {
    const tar = await tarGzFromMap({ 'org-tooling/README.md': '# nothing here' });
    const res = await app.request('/api/artifacts/upload',
      asMultipart({ type: 'plugin', slug: 'org-tooling', version: '0.1.0', archive: tar }, asMember()));
    expect(res.status).toBe(422);
    expect(await res.text()).toMatch(/plugin\.json/);
  });

  it('accepts a valid command archive', async () => {
    const tar = await tarGzFromMap({ 'deploy.md': '---\ndescription: d\n---\nbody' });
    const res = await app.request('/api/artifacts/upload',
      asMultipart({ type: 'command', slug: 'deploy', version: '0.1.0', archive: tar }, asMember()));
    expect(res.status).toBe(201);
  });

  it('rejects a command archive without frontmatter', async () => {
    const tar = await tarGzFromMap({ 'deploy.md': 'no frontmatter' });
    const res = await app.request('/api/artifacts/upload',
      asMultipart({ type: 'command', slug: 'deploy', version: '0.1.0', archive: tar }, asMember()));
    expect(res.status).toBe(422);
  });

  it('accepts a valid agent archive', async () => {
    const tar = await tarGzFromMap({ 'rev.md': '---\nname: rev\ndescription: d\n---\n' });
    const res = await app.request('/api/artifacts/upload',
      asMultipart({ type: 'agent', slug: 'rev', version: '0.1.0', archive: tar }, asMember()));
    expect(res.status).toBe(201);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `pnpm --filter hub-server test -- upload-types`
Expected: FAIL — server only validates skills today

- [ ] **Step 3: Implement archive inspector**

```ts
// apps/hub-server/src/services/archive-inspector.ts
// SPDX-License-Identifier: Apache-2.0
import { extract } from 'tar-stream';
import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';

export interface InspectedEntry { path: string; content: string; }

export async function listEntries(buf: Buffer, opts: { maxBytes?: number } = {}): Promise<InspectedEntry[]> {
  const max = opts.maxBytes ?? 10 * 1024 * 1024;
  if (buf.byteLength > max) throw new Error('archive too large');
  return new Promise((resolve, reject) => {
    const out: InspectedEntry[] = [];
    const ex = extract();
    ex.on('entry', (header, stream, next) => {
      const chunks: Buffer[] = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => {
        out.push({ path: header.name, content: Buffer.concat(chunks).toString('utf8') });
        next();
      });
      stream.resume();
    });
    ex.on('finish', () => resolve(out));
    ex.on('error', reject);
    Readable.from(buf).pipe(createGunzip()).pipe(ex);
  });
}

export function findEntry(entries: InspectedEntry[], suffix: string): InspectedEntry | undefined {
  return entries.find((e) => e.path === suffix || e.path.endsWith('/' + suffix));
}

export function hasFrontmatter(content: string): boolean {
  return /^---\n[\s\S]*?\n---\n/.test(content);
}
```

```ts
// apps/hub-server/src/routes/artifacts.ts (excerpt of upload handler)
import { listEntries, findEntry, hasFrontmatter } from '../services/archive-inspector';
import { pluginManifestSchema } from '../validators/manifest-plugin';
import { commandManifestSchema } from '../validators/manifest-command';
import { agentManifestSchema } from '../validators/manifest-agent';

async function validatePerType(type: ArtifactType, slug: string, archive: Buffer) {
  const entries = await listEntries(archive);
  if (type === 'plugin') {
    const e = findEntry(entries, '.claude-plugin/plugin.json');
    if (!e) throw new HttpError(422, 'plugin archive missing .claude-plugin/plugin.json');
    const json = JSON.parse(e.content);
    pluginManifestSchema.parse({
      schemaVersion: 1, name: slug, type: 'plugin', description: json.description ?? '',
      typeMeta: {
        commands: (json.commands ?? []).length, agents: (json.agents ?? []).length,
        skills: (json.skills ?? []).length, hooks: (json.hooks ?? []).length, mcp: (json.mcp ?? []).length,
      },
    });
  } else if (type === 'command') {
    const e = findEntry(entries, slug + '.md');
    if (!e) throw new HttpError(422, `command archive missing ${slug}.md`);
    if (!hasFrontmatter(e.content)) throw new HttpError(422, 'command markdown missing frontmatter');
  } else if (type === 'agent') {
    const e = findEntry(entries, slug + '.md');
    if (!e) throw new HttpError(422, `agent archive missing ${slug}.md`);
    if (!hasFrontmatter(e.content)) throw new HttpError(422, 'agent markdown missing frontmatter');
  }
  // skill validated by Plan 3 path
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter hub-server test -- upload-types`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/hub-server/src/routes/artifacts.ts apps/hub-server/src/services/archive-inspector.ts apps/hub-server/test/integration/upload-types.test.ts
git commit -m "feat(server): validate plugin/command/agent archives on upload"
```

---

## Task 19: Hub-server toggle-request endpoint + WSS broadcast

**Files:**
- Create: `apps/hub-server/src/routes/local-toggle.ts`
- Modify: `apps/hub-server/src/wss/dispatcher.ts`
- Modify: `apps/hub-server/src/app.ts` (mount route)
- Test: `apps/hub-server/test/integration/toggle.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/hub-server/test/integration/toggle.test.ts
import { describe, it, expect } from 'vitest';
import { app } from '../../src/app';
import { connectFakeDaemon, asMember, registerArtifact } from '../helpers';

describe('plugin toggle flow', () => {
  it('broadcasts job.toggle to the daemon', async () => {
    const daemon = await connectFakeDaemon('user-1');
    const artifact = await registerArtifact({ type: 'plugin', slug: 'org-tooling' });

    const res = await app.request(`/api/local/${daemon.id}/toggle-request`,
      { method: 'POST', headers: asMember().headers,
        body: JSON.stringify({ artifactId: artifact.id, enabled: true }) });
    expect(res.status).toBe(202);

    const msg = await daemon.nextMessage();
    expect(msg.type).toBe('job.toggle');
    expect(msg.payload).toEqual({ artifactId: artifact.id, slug: 'org-tooling', enabled: true });
  });

  it('rejects toggle for skill artifact', async () => {
    const daemon = await connectFakeDaemon('user-1');
    const artifact = await registerArtifact({ type: 'skill', slug: 'helper' });
    const res = await app.request(`/api/local/${daemon.id}/toggle-request`,
      { method: 'POST', headers: asMember().headers,
        body: JSON.stringify({ artifactId: artifact.id, enabled: false }) });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test**

Run: `pnpm --filter hub-server test -- toggle`
Expected: FAIL — endpoint missing

- [ ] **Step 3: Implement endpoint**

```ts
// apps/hub-server/src/routes/local-toggle.ts
// SPDX-License-Identifier: Apache-2.0
import { Hono } from 'hono';
import { requireSession } from '../auth/middleware';
import { db, artifacts } from '../db';
import { sendToDaemon } from '../wss/dispatcher';
import { eq } from 'drizzle-orm';
import { ulid } from 'ulid';

export const toggleRoute = new Hono();

toggleRoute.post('/api/local/:daemonId/toggle-request', requireSession, async (c) => {
  const { daemonId } = c.req.param();
  const { artifactId, enabled } = await c.req.json();
  const [art] = await db.select().from(artifacts).where(eq(artifacts.id, artifactId));
  if (!art) return c.text('artifact not found', 404);
  if (art.type !== 'plugin') {
    return c.text('toggle is only supported for plugins in MVP', 400);
  }
  const sent = await sendToDaemon(daemonId, {
    type: 'job.toggle',
    id: ulid(),
    payload: { artifactId, slug: art.slug, enabled: !!enabled },
  });
  if (!sent) return c.text('daemon offline', 503);
  return c.body(null, 202);
});
```

```ts
// apps/hub-server/src/wss/dispatcher.ts (extend job.result handling)
case 'job.result': {
  if (msg.payload.code === 'not_supported_in_mvp') {
    auditLog.write({ action: 'toggle.rejected', reason: msg.payload.message, daemonId });
  }
  // existing success/error broadcast logic
  break;
}
```

```ts
// apps/hub-server/src/app.ts (mount)
app.route('/', toggleRoute);
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter hub-server test -- toggle`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/hub-server/src/routes/local-toggle.ts apps/hub-server/src/wss/dispatcher.ts apps/hub-server/src/app.ts apps/hub-server/test/integration/toggle.test.ts
git commit -m "feat(server): add /api/local/:daemonId/toggle-request and WSS plumbing"
```

---

## Task 20: Dashboard — type icon + filter chips component

**Files:**
- Create: `apps/dashboard/components/ArtifactTypeIcon.tsx`
- Create: `apps/dashboard/components/TypeFilterChips.tsx`
- Test: `apps/dashboard/components/TypeFilterChips.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// apps/dashboard/components/TypeFilterChips.test.tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { TypeFilterChips } from './TypeFilterChips';

describe('TypeFilterChips', () => {
  it('renders all five chips (All + 4 types)', () => {
    render(<TypeFilterChips value="all" onChange={() => {}} />);
    ['All', 'Skills', 'Plugins', 'Commands', 'Agents'].forEach((label) =>
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument(),
    );
  });

  it('fires onChange with selected type', () => {
    const onChange = vi.fn();
    render(<TypeFilterChips value="all" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Plugins' }));
    expect(onChange).toHaveBeenCalledWith('plugin');
  });
});
```

- [ ] **Step 2: Run test**

Run: `pnpm --filter dashboard test -- TypeFilterChips`
Expected: FAIL — component missing

- [ ] **Step 3: Implement components**

```tsx
// apps/dashboard/components/ArtifactTypeIcon.tsx
// SPDX-License-Identifier: Apache-2.0
import { BookOpen, Puzzle, Terminal, Bot } from 'lucide-react';
import type { ArtifactType } from '@hub/shared-types';

const map: Record<ArtifactType, React.ComponentType<{ className?: string }>> = {
  skill: BookOpen, plugin: Puzzle, command: Terminal, agent: Bot,
};

export function ArtifactTypeIcon({ type, className }: { type: ArtifactType; className?: string }) {
  const Icon = map[type];
  return <Icon className={className ?? 'h-4 w-4'} aria-label={type} />;
}
```

```tsx
// apps/dashboard/components/TypeFilterChips.tsx
// SPDX-License-Identifier: Apache-2.0
import { Button } from '@/components/ui/button';
import type { ArtifactType } from '@hub/shared-types';

export type TypeFilter = 'all' | ArtifactType;
const items: { value: TypeFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'skill', label: 'Skills' },
  { value: 'plugin', label: 'Plugins' },
  { value: 'command', label: 'Commands' },
  { value: 'agent', label: 'Agents' },
];

export function TypeFilterChips({ value, onChange }: { value: TypeFilter; onChange: (v: TypeFilter) => void }) {
  return (
    <div className="flex gap-2">
      {items.map((it) => (
        <Button key={it.value} size="sm"
          variant={value === it.value ? 'default' : 'outline'}
          onClick={() => onChange(it.value)}>
          {it.label}
        </Button>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Run test**

Run: `pnpm --filter dashboard test -- TypeFilterChips`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/components/ArtifactTypeIcon.tsx apps/dashboard/components/TypeFilterChips.tsx apps/dashboard/components/TypeFilterChips.test.tsx
git commit -m "feat(dashboard): add per-type icon and filter chip components"
```

---

## Task 21: Dashboard — Toggle switch with optimistic update

**Files:**
- Create: `apps/dashboard/components/ToggleSwitch.tsx`
- Test: `apps/dashboard/components/ToggleSwitch.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// apps/dashboard/components/ToggleSwitch.test.tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ToggleSwitch } from './ToggleSwitch';

describe('ToggleSwitch', () => {
  it('shows checked optimistically on click then confirms', async () => {
    const apiFn = vi.fn().mockResolvedValue(undefined);
    render(<ToggleSwitch initial={false} request={apiFn} />);
    const sw = screen.getByRole('switch');
    fireEvent.click(sw);
    expect(sw).toHaveAttribute('aria-checked', 'true'); // optimistic
    await waitFor(() => expect(apiFn).toHaveBeenCalledWith(true));
  });

  it('rolls back on API failure', async () => {
    const apiFn = vi.fn().mockRejectedValue(new Error('offline'));
    render(<ToggleSwitch initial={false} request={apiFn} />);
    const sw = screen.getByRole('switch');
    fireEvent.click(sw);
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'false'));
  });
});
```

- [ ] **Step 2: Run test**

Run: `pnpm --filter dashboard test -- ToggleSwitch`
Expected: FAIL

- [ ] **Step 3: Implement component**

```tsx
// apps/dashboard/components/ToggleSwitch.tsx
// SPDX-License-Identifier: Apache-2.0
'use client';
import { useState } from 'react';
import { Switch } from '@/components/ui/switch';
import { toast } from 'sonner';

export function ToggleSwitch({
  initial, request,
}: { initial: boolean; request: (next: boolean) => Promise<void> }) {
  const [checked, setChecked] = useState(initial);
  const [pending, setPending] = useState(false);

  async function onChange(next: boolean) {
    setChecked(next);
    setPending(true);
    try {
      await request(next);
    } catch (e) {
      setChecked(!next);
      toast.error((e as Error).message);
    } finally {
      setPending(false);
    }
  }
  return <Switch checked={checked} disabled={pending} onCheckedChange={onChange} />;
}
```

- [ ] **Step 4: Run test**

Run: `pnpm --filter dashboard test -- ToggleSwitch`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/components/ToggleSwitch.tsx apps/dashboard/components/ToggleSwitch.test.tsx
git commit -m "feat(dashboard): add toggle switch with optimistic update + rollback"
```

---

## Task 22: Dashboard — Local view per-type rendering

**Files:**
- Modify: `apps/dashboard/app/local/page.tsx`
- Test: `apps/dashboard/app/local/page.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// apps/dashboard/app/local/page.test.tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import LocalPage from './page';
import { mockInventory } from '@/test/fixtures';

describe('LocalPage', () => {
  it('shows toggle only for plugins', () => {
    render(<LocalPage initialItems={mockInventory()} />);
    const rows = screen.getAllByRole('row');
    const pluginRow = rows.find((r) => r.textContent?.includes('org-tooling'));
    expect(pluginRow!.querySelector('[role="switch"]')).toBeTruthy();
    const skillRow = rows.find((r) => r.textContent?.includes('helper'));
    expect(skillRow!.querySelector('[role="switch"]')).toBeNull();
  });

  it('filters by type via chips', () => {
    render(<LocalPage initialItems={mockInventory()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Commands' }));
    expect(screen.queryByText('org-tooling')).not.toBeInTheDocument();
    expect(screen.getByText('deploy')).toBeInTheDocument();
  });
});
```

`mockInventory()` returns one item per type using shapes from `InventoryItem` in shared-types.

- [ ] **Step 2: Run test**

Run: `pnpm --filter dashboard test -- local`
Expected: FAIL

- [ ] **Step 3: Implement page changes**

```tsx
// apps/dashboard/app/local/page.tsx
// SPDX-License-Identifier: Apache-2.0
'use client';
import { useMemo, useState } from 'react';
import type { InventoryItem } from '@hub/shared-types';
import { ArtifactTypeIcon } from '@/components/ArtifactTypeIcon';
import { TypeFilterChips, type TypeFilter } from '@/components/TypeFilterChips';
import { ToggleSwitch } from '@/components/ToggleSwitch';
import { toggleRequest } from '@/lib/api';

export default function LocalPage({ initialItems }: { initialItems: InventoryItem[] }) {
  const [items, setItems] = useState(initialItems);
  const [filter, setFilter] = useState<TypeFilter>('all');
  const visible = useMemo(
    () => items.filter((it) => filter === 'all' || it.type === filter),
    [items, filter],
  );

  return (
    <div className="space-y-4">
      <TypeFilterChips value={filter} onChange={setFilter} />
      <table>
        <thead><tr><th>Type</th><th>Slug</th><th>Version</th><th>Action</th></tr></thead>
        <tbody>
          {visible.map((it) => (
            <tr key={it.path}>
              <td><ArtifactTypeIcon type={it.type} /></td>
              <td>{it.slug}</td>
              <td>{it.version ?? '-'}</td>
              <td>
                {it.type === 'plugin' && it.publishedAs && (
                  <ToggleSwitch
                    initial={it.enabled ?? false}
                    request={(next) => toggleRequest(it.publishedAs!.artifactId, next)}
                  />
                )}
                {/* Publish/Uninstall buttons keep their Plan 3 wiring */}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

```ts
// apps/dashboard/lib/api.ts (append)
export async function toggleRequest(artifactId: string, enabled: boolean) {
  const daemonId = await getCurrentDaemonId();
  const res = await fetch(`/api/local/${daemonId}/toggle-request`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ artifactId, enabled }),
  });
  if (!res.ok) throw new Error(await res.text());
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter dashboard test -- local`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/app/local/page.tsx apps/dashboard/app/local/page.test.tsx apps/dashboard/lib/api.ts
git commit -m "feat(dashboard): per-type rendering and plugin toggle on Local page"
```

---

## Task 23: Dashboard — Catalog filter chips + per-type detail

**Files:**
- Modify: `apps/dashboard/app/catalog/page.tsx`
- Modify: `apps/dashboard/app/catalog/[slug]/page.tsx`
- Test: `apps/dashboard/app/catalog/page.test.tsx`
- Test: `apps/dashboard/app/catalog/[slug]/page.test.tsx`

- [ ] **Step 1: Write the failing tests**

```tsx
// apps/dashboard/app/catalog/page.test.tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import CatalogPage from './page';
import { mockCatalog } from '@/test/fixtures';

describe('CatalogPage', () => {
  it('filters by plugin chip', () => {
    render(<CatalogPage initialArtifacts={mockCatalog()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Plugins' }));
    expect(screen.getByText('org-tooling')).toBeInTheDocument();
    expect(screen.queryByText('helper')).not.toBeInTheDocument();
  });
});
```

```tsx
// apps/dashboard/app/catalog/[slug]/page.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import CatalogDetailPage from './page';
import { mockArtifact } from '@/test/fixtures';

describe('CatalogDetailPage', () => {
  it('plugin shows summary of bundled items', () => {
    render(<CatalogDetailPage artifact={mockArtifact('plugin', {
      typeMeta: { commands: 3, agents: 1, skills: 2, hooks: 0, mcp: 0 },
    })} />);
    expect(screen.getByText(/Contains: 2 skills, 3 commands, 1 agent/i)).toBeInTheDocument();
  });

  it('command shows argument hint', () => {
    render(<CatalogDetailPage artifact={mockArtifact('command', {
      typeMeta: { argumentHint: '[env]', allowedTools: ['Bash', 'Read'] },
    })} />);
    expect(screen.getByText(/argument: \[env\]/i)).toBeInTheDocument();
    expect(screen.getByText(/Bash, Read/)).toBeInTheDocument();
  });

  it('agent shows model + tools', () => {
    render(<CatalogDetailPage artifact={mockArtifact('agent', {
      typeMeta: { model: 'claude-opus-4-7', tools: ['Read'] },
    })} />);
    expect(screen.getByText(/claude-opus-4-7/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests**

Run: `pnpm --filter dashboard test -- catalog`
Expected: FAIL — pages don't render typeMeta

- [ ] **Step 3: Implement filter and detail rendering**

```tsx
// apps/dashboard/app/catalog/page.tsx (excerpt)
'use client';
import { useState, useMemo } from 'react';
import { TypeFilterChips, type TypeFilter } from '@/components/TypeFilterChips';
import { ArtifactTypeIcon } from '@/components/ArtifactTypeIcon';

export default function CatalogPage({ initialArtifacts }) {
  const [filter, setFilter] = useState<TypeFilter>('all');
  const items = useMemo(
    () => initialArtifacts.filter((a) => filter === 'all' || a.type === filter),
    [initialArtifacts, filter],
  );
  return (
    <>
      <TypeFilterChips value={filter} onChange={setFilter} />
      <ul>
        {items.map((a) => (
          <li key={a.id}><ArtifactTypeIcon type={a.type} /> {a.slug}</li>
        ))}
      </ul>
    </>
  );
}
```

```tsx
// apps/dashboard/app/catalog/[slug]/page.tsx (excerpt)
import type { ArtifactDTO, ArtifactVersionDTO } from '@hub/shared-types';

function TypeMetaPanel({ artifact, version }: {
  artifact: ArtifactDTO; version: ArtifactVersionDTO;
}) {
  const m = version.manifest.typeMeta as any;
  switch (artifact.type) {
    case 'plugin':
      return <p>{`Contains: ${m.skills} skills, ${m.commands} commands, ${m.agents} agents`}</p>;
    case 'command':
      return <p>argument: {m.argumentHint || '(none)'} · tools: {(m.allowedTools ?? []).join(', ')}</p>;
    case 'agent':
      return <p>model: {m.model} · tools: {(m.tools ?? []).join(', ')}</p>;
    default:
      return null;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter dashboard test -- catalog`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/app/catalog
git commit -m "feat(dashboard): per-type catalog filter and detail rendering"
```

---

## Task 24: Dashboard — PublishModal pre-fill per type

**Files:**
- Modify: `apps/dashboard/components/PublishModal.tsx`
- Test: `apps/dashboard/components/PublishModal.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// apps/dashboard/components/PublishModal.test.tsx (append)
it('shows the type explicitly and pre-fills description from manifest', () => {
  render(
    <PublishModal item={{
      type: 'plugin', slug: 'org-tooling', version: '0.1.0',
      path: '/u/.claude/plugins/org-tooling',
      manifest: { description: 'Internal tools', typeMeta: {} },
    }} />,
  );
  expect(screen.getByText(/Type:\s*plugin/)).toBeInTheDocument();
  expect((screen.getByLabelText('Description') as HTMLInputElement).value).toBe('Internal tools');
});

it.each(['command', 'agent'] as const)('renders for %s', (t) => {
  render(
    <PublishModal item={{
      type: t, slug: 'x', version: '0.1.0', path: `/x.md`,
      manifest: { description: 'd', typeMeta: {} },
    }} />,
  );
  expect(screen.getByText(new RegExp(`Type:\\s*${t}`))).toBeInTheDocument();
});
```

- [ ] **Step 2: Run tests**

Run: `pnpm --filter dashboard test -- PublishModal`
Expected: FAIL — modal hard-codes "skill" today

- [ ] **Step 3: Update modal**

```tsx
// apps/dashboard/components/PublishModal.tsx (excerpt)
export function PublishModal({ item }: { item: PublishCandidate }) {
  const [description, setDescription] = useState(item.manifest.description ?? '');
  return (
    <Dialog>
      <p>Type: <strong>{item.type}</strong></p>
      <Input label="Slug" defaultValue={item.slug} />
      <Input label="Version" defaultValue={item.version ?? '0.1.0'} />
      <Textarea label="Description" value={description}
        onChange={(e) => setDescription(e.target.value)} />
      <Button onClick={() => publish({ ...item, description })}>Publish</Button>
    </Dialog>
  );
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter dashboard test -- PublishModal`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/components/PublishModal.tsx apps/dashboard/components/PublishModal.test.tsx
git commit -m "feat(dashboard): publish modal renders type and pre-fills description for all types"
```

---

## Task 25: Daemon CLI integration test — toggle round-trip

**Files:**
- Create: `apps/agent/test/integration/toggle_roundtrip_test.go`

- [ ] **Step 1: Write the failing test**

```go
// apps/agent/test/integration/toggle_roundtrip_test.go
//go:build integration

package integration

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/claude-hub/agent/internal/api/local"
	"github.com/claude-hub/agent/internal/jobs"
)

func TestToggleRoundTrip_TogglesSettings(t *testing.T) {
	home := t.TempDir()
	os.WriteFile(filepath.Join(home, "settings.json"), []byte(`{}`), 0o644)
	srv := httptest.NewServer(local.NewRouter(jobs.Runner{Home: home}))
	defer srv.Close()

	body := `{"artifactId":"a-1","slug":"org-tooling","type":"plugin","enabled":true}`
	resp, err := http.Post(srv.URL+"/v1/toggle", "application/json", strings.NewReader(body))
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("status %d err %v", resp.StatusCode, err)
	}

	data, _ := os.ReadFile(filepath.Join(home, "settings.json"))
	var got map[string]any
	json.Unmarshal(data, &got)
	if got["enabledPlugins"].(map[string]any)["org-tooling"] != true {
		t.Fatalf("settings not flipped: %s", data)
	}
}
```

- [ ] **Step 2: Run integration suite**

Run: `go test -tags=integration ./test/integration/ -run TestToggleRoundTrip -v`
Expected: PASS (all pieces from Tasks 13–15 are wired).

- [ ] **Step 3: Commit**

```bash
git add apps/agent/test/integration/toggle_roundtrip_test.go
git commit -m "test(agent): integration test for plugin toggle round-trip"
```

---

## Task 26: E2E — multi-type publish/install/toggle flow

**Files:**
- Create: `e2e/multi-type-flow.spec.ts`
- Modify: `e2e/fixtures/mock-daemon.ts` (add toggle response handler)

- [ ] **Step 1: Write the failing test**

```ts
// e2e/multi-type-flow.spec.ts
import { test, expect } from '@playwright/test';
import { MockDaemon, seedInventoryAllTypes, login } from './fixtures';

test('publish each type, install on second daemon, toggle plugin', async ({ page, browser }) => {
  const daemonA = await MockDaemon.start({ user: 'alice@x.tld' });
  const daemonB = await MockDaemon.start({ user: 'bob@x.tld' });
  await seedInventoryAllTypes(daemonA);

  await login(page, 'alice@x.tld');
  await page.goto('/local');

  for (const slug of ['helper', 'org-tooling', 'deploy', 'rev']) {
    const row = page.getByRole('row', { name: new RegExp(slug) });
    await row.getByRole('button', { name: 'Publish' }).click();
    await page.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.getByText(`Published: ${slug}`)).toBeVisible();
  }

  const ctx = await browser.newContext();
  const bobPage = await ctx.newPage();
  await login(bobPage, 'bob@x.tld');
  await bobPage.goto('/catalog');
  for (const slug of ['helper', 'org-tooling', 'deploy', 'rev']) {
    await bobPage.getByRole('link', { name: slug }).click();
    await bobPage.getByRole('button', { name: 'Install' }).click();
    await expect(bobPage.getByText('Installed')).toBeVisible();
    await bobPage.goBack();
  }

  await bobPage.goto('/local');
  const pluginRow = bobPage.getByRole('row', { name: /org-tooling/ });
  const sw = pluginRow.getByRole('switch');
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  await sw.click();
  await expect(sw).toHaveAttribute('aria-checked', 'false');

  expect(daemonB.lastSettingsWrite()).toMatchObject({
    enabledPlugins: { 'org-tooling': false },
  });
});
```

- [ ] **Step 2: Run E2E suite**

Run: `pnpm exec playwright test e2e/multi-type-flow.spec.ts`
Expected: FAIL on first run; iterate on fixture wiring (mock daemon handlers, seedInventoryAllTypes) until PASS. Mock daemon must accept `job.toggle` and write the requested map into its in-memory settings store.

- [ ] **Step 3: Commit**

```bash
git add e2e/multi-type-flow.spec.ts e2e/fixtures/mock-daemon.ts
git commit -m "test(e2e): publish/install/toggle round-trip across all four types"
```

---

## Task 27: Self-review and CI gate

- [ ] **Step 1: Re-read the spec section 6.6 (Enable/Disable matrix)**

Confirm: only plugin renders a toggle in dashboard; skill/command/agent only show Publish or Uninstall (no Switch). Audit `LocalPage` JSX from Task 22.

- [ ] **Step 2: Re-read implementation contracts §"Local daemon HTTP API" and §"WSS protocol"**

Confirm payload shapes:
- `/v1/toggle` body uses `{ artifactId, slug, type, enabled }` (Task 15) — matches contracts.
- `job.toggle` payload uses `{ artifactId, slug, enabled }` (Task 1) — matches contracts (note the spec calls the message `job.enable`; Plan 4 names it `job.toggle` and rejects all non-plugin types). If the contracts file mandates `job.enable`, update Tasks 1, 16, 19 to use `job.enable` instead before merging.

- [ ] **Step 3: Run the full unit + integration test matrix**

Run:
```bash
pnpm -r test
go test ./... && go test -tags=integration ./...
pnpm exec playwright test
```
Expected: all green.

- [ ] **Step 4: Verify no placeholder strings remain**

Run a quick search for `TODO`, `FIXME`, `not_implemented` in the diff:
```bash
git diff origin/main -- apps/ | grep -E "TODO|FIXME|not_implemented" || true
```
Expected: empty.

- [ ] **Step 5: Commit (if anything changed during review)**

```bash
git add -p
git commit -m "chore(plan-4): self-review fixes"
```

---

## Self-Review Notes

- **Spec coverage**:
  - Section 4.2 (manifests for plugin/command/agent) → Tasks 3, 5, 6.
  - Section 5.1 `artifacts.type` enum → already present from Plan 3, used in scanner registry (Task 9) and install routing (Task 11).
  - Section 6.3 publish from dashboard for all types → Tasks 18 (server validation), 24 (modal pre-fill), 26 (E2E).
  - Section 6.5 install for all types → Task 11 (per-type extract), Task 12 (per-type uninstall), Task 26 (E2E).
  - Section 6.6 enable/disable plugin only → Tasks 13–16, 19, 22, 25, 26; explicit `not_supported_in_mvp` rejection in Task 14.
  - Section 7.6 daemon-side hardening (whitelist within `~/.claude/`) → Task 11 single-file extraction rejects extra archive entries; existing Plan 3 path traversal guard is preserved by `destinationFor`.
  - Section 7.7 sha256 verification → preserved through `verifySha256` reuse in Task 11.

- **Type consistency**: `ArtifactType` constants `ArtifactSkill / ArtifactPlugin / ArtifactCommand / ArtifactAgent` used in Go everywhere; TS uses lowercase string literals `'skill' | 'plugin' | 'command' | 'agent'`; `typeMeta` shapes match between Go parsers (Tasks 3, 5, 6) and zod validators (Task 17).

- **Open contract question**: WSS message named `job.toggle` here vs. `job.enable` in the spec. Decided to use `job.toggle` because (a) it carries explicit `enabled: bool`, (b) the daemon job is `ToggleJob`, and (c) future deferred unsupported-type errors map cleanly. Resolve via the contracts file before merge — Task 27 step 2 flags this.