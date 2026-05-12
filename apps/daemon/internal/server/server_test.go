package server

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/claude-hub/claude-hub/apps/daemon/internal/claudecode"
)

func newTestServer(t *testing.T) (*httptest.Server, string) {
	t.Helper()
	manager := claudecode.NewManager(t.TempDir())
	if err := manager.EnsureBaseDirs(); err != nil {
		t.Fatalf("ensure base dirs: %v", err)
	}
	token := "test-token-abc-123"
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := httptest.NewServer(New(manager, token, logger).Handler())
	t.Cleanup(srv.Close)
	return srv, token
}

func TestHelloDoesNotRequireAuth(t *testing.T) {
	srv, _ := newTestServer(t)

	resp, err := http.Get(srv.URL + "/v1/hello")
	if err != nil {
		t.Fatalf("hello request failed: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}

	var payload map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if payload["app"] != "claude-hub-daemon" {
		t.Fatalf("unexpected app field: %v", payload["app"])
	}
	if payload["paired"] != false {
		t.Fatalf("expected paired=false without auth, got %v", payload["paired"])
	}
}

func TestStateRequiresAuth(t *testing.T) {
	srv, _ := newTestServer(t)

	resp, err := http.Post(srv.URL+"/v1/state", "application/json", strings.NewReader(`{"catalog":[]}`))
	if err != nil {
		t.Fatalf("state request failed: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", resp.StatusCode)
	}

	var payload map[string]string
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if payload["code"] != "unauthorized" {
		t.Fatalf("expected structured error code, got %q", payload["code"])
	}
}

func TestStateWithAuth(t *testing.T) {
	srv, token := newTestServer(t)

	request, err := http.NewRequest(http.MethodPost, srv.URL+"/v1/state", strings.NewReader(`{"catalog":[]}`))
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("state request failed: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("expected 200, got %d (%s)", resp.StatusCode, body)
	}
}

func TestUninstallFailsWhenNotInstalled(t *testing.T) {
	srv, token := newTestServer(t)

	body := strings.NewReader(`{"asset":{"id":"skill:none","type":"skill","slug":"missing","name":"Missing","version":"1.0.0","risk":"low","files":[{"path":"SKILL.md","content":"# x"}]}}`)
	request, err := http.NewRequest(http.MethodPost, srv.URL+"/v1/uninstall", body)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("uninstall request failed: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", resp.StatusCode)
	}
}

func TestPairRequiresAllowedOrigin(t *testing.T) {
	srv, _ := newTestServer(t)
	resp, err := http.Get(srv.URL + "/pair?returnUrl=https://evil.example.com/")
	if err != nil {
		t.Fatalf("pair request failed: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 for disallowed origin, got %d", resp.StatusCode)
	}
}

func TestAllowedOriginEnvOverride(t *testing.T) {
	t.Setenv("CLAUDE_HUB_ALLOWED_WEB_ORIGINS", "https://hub.example.com")
	if !isAllowedWebOrigin("https://hub.example.com") {
		t.Fatalf("expected configured origin to be allowed")
	}
	if isAllowedWebOrigin("https://other.example.com") {
		t.Fatalf("non-listed origin should not be allowed")
	}
	_ = os.Unsetenv("CLAUDE_HUB_ALLOWED_WEB_ORIGINS")
}
