// SPDX-License-Identifier: Apache-2.0
package local

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestUninstallHandler_MovesToBackup(t *testing.T) {
	skillsRoot := t.TempDir()
	target := filepath.Join(skillsRoot, "foo")
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(target, "SKILL.md"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	h := UninstallHandler(skillsRoot, "tok")
	body, _ := json.Marshal(map[string]string{"slug": "foo"})
	req := httptest.NewRequest("POST", "/v1/uninstall", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer tok")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("code: %d body: %s", w.Code, w.Body.String())
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatal("expected target removed")
	}
	backups, _ := os.ReadDir(filepath.Join(skillsRoot, ".claude-hub-backup"))
	if len(backups) != 1 {
		t.Fatalf("expected 1 backup, got %d", len(backups))
	}
}

func TestUninstallHandler_NotFound(t *testing.T) {
	skillsRoot := t.TempDir()
	h := UninstallHandler(skillsRoot, "tok")
	body, _ := json.Marshal(map[string]string{"slug": "missing"})
	req := httptest.NewRequest("POST", "/v1/uninstall", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer tok")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 404 {
		t.Fatalf("expected 404, got %d", w.Code)
	}
}
