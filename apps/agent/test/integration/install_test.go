// SPDX-License-Identifier: Apache-2.0
package integration

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/animato/claude-hub/agent/internal/api/local"
	"github.com/animato/claude-hub/agent/internal/jobs"
)

func makeSampleTarGz(t *testing.T) ([]byte, string) {
	t.Helper()
	buf := &bytes.Buffer{}
	gz := gzip.NewWriter(buf)
	tw := tar.NewWriter(gz)
	payload := "body"
	if err := tw.WriteHeader(&tar.Header{
		Name:     "SKILL.md",
		Mode:     0o644,
		Size:     int64(len(payload)),
		Typeflag: tar.TypeReg,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write([]byte(payload)); err != nil {
		t.Fatal(err)
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	h := sha256.New()
	h.Write(buf.Bytes())
	return buf.Bytes(), hex.EncodeToString(h.Sum(nil))
}

func TestInstall_RoundTrip(t *testing.T) {
	bytesGz, sha := makeSampleTarGz(t)
	blob := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(bytesGz)
	}))
	defer blob.Close()

	hub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{
			"downloadUrl": blob.URL,
			"sha256":      sha,
		})
	}))
	defer hub.Close()

	home := t.TempDir()
	skillsRoot := filepath.Join(home, ".claude", "skills")
	if err := os.MkdirAll(skillsRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	j := jobs.New(hub.URL, "tok", skillsRoot)
	j.HTTPClient = hub.Client()

	h := local.InstallHandler(j, hub.URL, hub.Client(), "tok", skillsRoot)
	body, _ := json.Marshal(map[string]string{
		"artifact_slug": "demo",
		"version":       "0.1.0",
	})
	req := httptest.NewRequest("POST", "/v1/install", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer tok")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("status %d body %s", w.Code, w.Body.String())
	}
	if _, err := os.Stat(filepath.Join(skillsRoot, "demo", "SKILL.md")); err != nil {
		t.Fatalf("expected installed file: %v", err)
	}

	// Re-install to verify backup
	req2 := httptest.NewRequest("POST", "/v1/install", bytes.NewReader(body))
	req2.Header.Set("Authorization", "Bearer tok")
	w2 := httptest.NewRecorder()
	h.ServeHTTP(w2, req2)
	if w2.Code != 200 {
		t.Fatalf("reinstall status %d", w2.Code)
	}
	backups, _ := os.ReadDir(filepath.Join(skillsRoot, ".claude-hub-backup"))
	if len(backups) != 1 {
		t.Fatalf("expected 1 backup, got %d", len(backups))
	}
}

func TestInstall_ShaMismatchPreservesTarget(t *testing.T) {
	bytesGz, _ := makeSampleTarGz(t)
	blob := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(bytesGz)
	}))
	defer blob.Close()
	hub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{
			"downloadUrl": blob.URL,
			"sha256":      "deadbeef" + hex.EncodeToString(make([]byte, 28)),
		})
	}))
	defer hub.Close()

	skillsRoot := t.TempDir()
	j := jobs.New(hub.URL, "tok", skillsRoot)
	j.HTTPClient = hub.Client()

	h := local.InstallHandler(j, hub.URL, hub.Client(), "tok", skillsRoot)
	body, _ := json.Marshal(map[string]string{
		"artifact_slug": "demo",
		"version":       "0.1.0",
	})
	req := httptest.NewRequest("POST", "/v1/install", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer tok")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code == 200 {
		t.Fatal("expected install to fail on sha mismatch")
	}
	if _, err := os.Stat(filepath.Join(skillsRoot, "demo")); !os.IsNotExist(err) {
		t.Fatal("expected target dir untouched on mismatch")
	}
}
