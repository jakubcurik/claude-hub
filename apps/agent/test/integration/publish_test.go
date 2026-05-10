// SPDX-License-Identifier: Apache-2.0
package integration

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/animato/claude-hub/agent/internal/api/local"
	"github.com/animato/claude-hub/agent/internal/jobs"
)

func TestPublish_LocalAPIHitsHub(t *testing.T) {
	skillDir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(skillDir, "demo"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		filepath.Join(skillDir, "demo", "SKILL.md"),
		[]byte("---\nname: demo\ndescription: d\n---\n"),
		0o644,
	); err != nil {
		t.Fatal(err)
	}

	var receivedSlug string
	var receivedSha string
	hub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/artifacts/upload" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		if err := r.ParseMultipartForm(32 << 20); err != nil {
			t.Fatal(err)
		}
		receivedSlug = r.FormValue("slug")
		receivedSha = r.FormValue("sha256")
		f, _, err := r.FormFile("file")
		if err != nil {
			t.Fatal(err)
		}
		defer f.Close()
		_, _ = io.Copy(io.Discard, f)
		w.WriteHeader(201)
		_, _ = w.Write([]byte(`{"artifactId":"a-1","versionId":"v-1"}`))
	}))
	defer hub.Close()

	j := jobs.New(hub.URL, "tok-abc", skillDir)
	j.HTTPClient = hub.Client()

	h := local.PublishHandler(j, "tok-abc")
	body, _ := json.Marshal(map[string]string{
		"slug":        "demo",
		"type":        "skill",
		"version":     "0.1.0",
		"description": "d",
		"source_path": filepath.Join(skillDir, "demo"),
	})
	req := httptest.NewRequest("POST", "/v1/publish", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer tok-abc")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	if w.Code != 200 {
		t.Fatalf("status %d body %s", w.Code, w.Body.String())
	}
	if receivedSlug != "demo" {
		t.Fatalf("hub got slug=%s", receivedSlug)
	}
	if len(receivedSha) != 64 {
		t.Fatalf("sha256 length: %d", len(receivedSha))
	}
}
