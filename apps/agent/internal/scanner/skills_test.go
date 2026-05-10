// SPDX-License-Identifier: Apache-2.0
package scanner

import (
	"os"
	"path/filepath"
	"sort"
	"testing"

	"github.com/animato/claude-hub/agent/internal/api"
)

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestSkillScanner_ScansValidDirs(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "foo", "SKILL.md"),
		"---\nname: foo\ndescription: a\n---\n")
	writeFile(t, filepath.Join(root, "bar", "SKILL.md"),
		"---\nname: bar\ndescription: b\n---\n")
	if err := os.MkdirAll(filepath.Join(root, "broken"), 0o755); err != nil {
		t.Fatal(err)
	}

	items, err := SkillScanner{Root: root}.Scan()
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	sort.Slice(items, func(i, j int) bool { return items[i].Slug < items[j].Slug })
	if len(items) != 2 {
		t.Fatalf("expected 2 items, got %d", len(items))
	}
	if items[0].Slug != "bar" || items[1].Slug != "foo" {
		t.Fatalf("unexpected slugs: %+v", items)
	}
	if items[0].Type != api.ArtifactSkill {
		t.Fatalf("expected skill type")
	}
}

func TestSkillScanner_MissingRootReturnsEmpty(t *testing.T) {
	items, err := SkillScanner{Root: "/nonexistent/path/that/does/not/exist"}.Scan()
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if len(items) != 0 {
		t.Fatalf("expected empty, got %d", len(items))
	}
}

func TestSkillScanner_SkipsBackupDir(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, ".claude-hub-backup", "old", "SKILL.md"),
		"---\nname: old\ndescription: x\n---\n")
	items, err := SkillScanner{Root: root}.Scan()
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 0 {
		t.Fatalf("expected backup dir to be skipped, got %d", len(items))
	}
}
