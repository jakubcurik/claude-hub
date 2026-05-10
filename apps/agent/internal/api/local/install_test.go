// SPDX-License-Identifier: Apache-2.0
package local

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/animato/claude-hub/agent/internal/jobs"
)

type stubInstaller struct{ got jobs.InstallRequest }

func (s *stubInstaller) Install(req jobs.InstallRequest) error {
	s.got = req
	return nil
}

func TestInstallHandler_HappyPath(t *testing.T) {
	inst := &stubInstaller{}
	hubMux := http.NewServeMux()
	hubMux.HandleFunc("/api/artifacts/", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{
			"downloadUrl": "https://blob/x.tar.gz",
			"sha256":      strings.Repeat("a", 64),
		})
	})
	hub := httptest.NewServer(hubMux)
	defer hub.Close()

	h := InstallHandler(inst, hub.URL, hub.Client(), "tok", "/skills")
	body, _ := json.Marshal(map[string]string{
		"artifact_slug": "foo",
		"version":       "0.1.0",
	})
	req := httptest.NewRequest("POST", "/v1/install", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer tok")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status %d body %s", w.Code, w.Body.String())
	}
	if inst.got.DownloadURL != "https://blob/x.tar.gz" {
		t.Fatalf("forwarded URL wrong: %+v", inst.got)
	}
}

func TestInstallHandler_HubErrorReturns502(t *testing.T) {
	hubMux := http.NewServeMux()
	hubMux.HandleFunc("/api/artifacts/", func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "no", http.StatusNotFound)
	})
	hub := httptest.NewServer(hubMux)
	defer hub.Close()

	h := InstallHandler(&stubInstaller{}, hub.URL, hub.Client(), "tok", "/skills")
	body, _ := json.Marshal(map[string]string{"artifact_slug": "foo", "version": "0.1.0"})
	req := httptest.NewRequest("POST", "/v1/install", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer tok")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusBadGateway {
		t.Fatalf("expected 502, got %d", w.Code)
	}
}
