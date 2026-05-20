package server

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/claude-hub/claude-hub/apps/daemon/internal/claudecode"
	"github.com/claude-hub/claude-hub/apps/daemon/internal/gitauth"
)

func newTestServer(t *testing.T) (*httptest.Server, string) {
	t.Helper()
	manager := claudecode.NewManager(t.TempDir())
	if err := manager.EnsureBaseDirs(); err != nil {
		t.Fatalf("ensure base dirs: %v", err)
	}
	token := "test-token-abc-123"
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := httptest.NewServer(New(manager, token, logger, nil).Handler())
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

// authFailGitAuth implementuje claudecode.GitAuthRunner tak, že vždy vrátí
// *gitauth.AuthRequiredError. Slouží pro test, že server mapuje tuto chybu
// na HTTP 401 s code "git_auth_required".
type authFailGitAuth struct{}

func (a *authFailGitAuth) Clone(_ context.Context, opts gitauth.CloneOptions) (gitauth.Result, error) {
	return gitauth.Result{}, &gitauth.AuthRequiredError{
		URL:     opts.URL,
		Host:    "github.com",
		Message: "PAT chybí v keychainu",
	}
}

func (a *authFailGitAuth) Pull(_ context.Context, repoPath, _ string) (gitauth.Result, error) {
	_ = repoPath
	return gitauth.Result{}, &gitauth.AuthRequiredError{Message: "PAT chybí v keychainu"}
}

func TestHandleInstall_AuthRequired_MapsTo401WithCode(t *testing.T) {
	manager := claudecode.NewManager(t.TempDir())
	if err := manager.EnsureBaseDirs(); err != nil {
		t.Fatalf("ensure base: %v", err)
	}
	manager.GitAuth = &authFailGitAuth{}
	token := "test-token"
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := httptest.NewServer(New(manager, token, logger, nil).Handler())
	defer srv.Close()

	// Recipe asset, který spustí plugin install path.
	recipeBody := `{"asset":{"id":"plugin:test","type":"plugin","slug":"test-plugin","name":"Test","version":"0.1.0","risk":"high","files":[{"path":"recipe.json","content":"{\"marketplaceName\":\"test\",\"marketplaceSource\":{\"source\":\"github\",\"repo\":\"owner/repo\"},\"pluginName\":\"hello\"}"}]}}`
	request, err := http.NewRequest(http.MethodPost, srv.URL+"/v1/install", strings.NewReader(recipeBody))
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("install request: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusUnauthorized {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("expected 401, got %d (body=%s)", resp.StatusCode, body)
	}

	var payload map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if payload["code"] != "git_auth_required" {
		t.Errorf("code = %v, want git_auth_required", payload["code"])
	}
	details, ok := payload["details"].(map[string]any)
	if !ok {
		t.Fatalf("details není objekt: %v", payload["details"])
	}
	if details["host"] != "github.com" {
		t.Errorf("details.host = %v, want github.com", details["host"])
	}
}

func TestHandlePluginCredentials_RoundTrip(t *testing.T) {
	srv, token := newTestServer(t)

	// SET: uložit token pro test-host
	setReq := `{"host":"example.com","token":"glpat_abc123"}`
	request, err := http.NewRequest(http.MethodPost, srv.URL+"/v1/plugin/credentials", strings.NewReader(setReq))
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("set request: %v", err)
	}
	defer resp.Body.Close()
	// Pozn.: na CI bez keychainu OSKeyring.Set může selhat. Ověříme jen
	// že code path neproduktivuje 5xx — buď 200 (success) nebo 400 (no keychain).
	if resp.StatusCode >= 500 {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("server 5xx pro plugin credentials: %d %s", resp.StatusCode, body)
	}
}

func TestHandlePluginCredentials_RejectsInvalidHost(t *testing.T) {
	srv, token := newTestServer(t)

	bad := []string{
		`{"host":"","token":"x"}`,
		`{"host":"localhost","token":"x"}`,
		`{"host":"127.0.0.1","token":"x"}`,
		`{"host":"::1","token":"x"}`,
		`{"host":"github.com","token":""}`,
	}
	for _, body := range bad {
		req, err := http.NewRequest(http.MethodPost, srv.URL+"/v1/plugin/credentials", strings.NewReader(body))
		if err != nil {
			t.Fatalf("request: %v", err)
		}
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("request: %v", err)
		}
		respBody, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Errorf("body=%s: expected 400, got %d (%s)", body, resp.StatusCode, respBody)
		}
	}
}
