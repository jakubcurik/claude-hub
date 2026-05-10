// SPDX-License-Identifier: Apache-2.0
package manifest

import (
	"os"
	"path/filepath"
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

func TestSkillParser_ValidFrontmatter(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "SKILL.md"),
		"---\nname: foo\ndescription: bar\n---\nbody\n")
	m, err := SkillParser{}.Parse(dir)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if m.Name != "foo" || m.Type != api.ArtifactSkill || m.Description != "bar" || m.SchemaVersion != 1 {
		t.Fatalf("unexpected manifest: %+v", m)
	}
}

func TestSkillParser_FallsBackToBasenameMd(t *testing.T) {
	dir := t.TempDir()
	base := filepath.Base(dir)
	writeFile(t, filepath.Join(dir, base+".md"),
		"---\nname: alt\ndescription: alt-desc\n---\n")
	m, err := SkillParser{}.Parse(dir)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if m.Name != "alt" {
		t.Fatalf("expected alt, got %s", m.Name)
	}
}

func TestSkillParser_MissingFile(t *testing.T) {
	dir := t.TempDir()
	if _, err := (SkillParser{}).Parse(dir); err == nil {
		t.Fatal("expected error")
	}
}

func TestSkillParser_MissingFrontmatter(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "SKILL.md"), "no frontmatter here")
	if _, err := (SkillParser{}).Parse(dir); err == nil {
		t.Fatal("expected error")
	}
}

func TestSkillParser_MissingName(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "SKILL.md"),
		"---\ndescription: only desc\n---\n")
	if _, err := (SkillParser{}).Parse(dir); err == nil {
		t.Fatal("expected error")
	}
}
