package gitauth

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
)

// callResponse popisuje jedno volání fake gitu: exit kód + stderr (\\n je literál
// pro multi-line, fake_git_main.go ho expanduje na newline).
type callResponse struct {
	exit   int
	stderr string
}

var (
	fakeGitOnce sync.Once
	fakeGitPath string
	fakeGitErr  error
)

// buildFakeGit zkompiluje testdata/fake_git_main.go do binárky v cache adresáři
// (per-test-binary, sdílené napříč test runy v této session).
func buildFakeGit(t *testing.T) string {
	t.Helper()
	fakeGitOnce.Do(func() {
		dir, err := os.MkdirTemp("", "claude-hub-fakegit-*")
		if err != nil {
			fakeGitErr = err
			return
		}
		name := "fakegit"
		if runtime.GOOS == "windows" {
			name = "fakegit.exe"
		}
		out := filepath.Join(dir, name)
		src, err := filepath.Abs(filepath.Join("testdata", "fake_git_main.go"))
		if err != nil {
			fakeGitErr = err
			return
		}
		cmd := exec.Command("go", "build", "-o", out, src)
		if buf, err := cmd.CombinedOutput(); err != nil {
			fakeGitErr = fmt.Errorf("go build fake_git: %v\n%s", err, buf)
			return
		}
		fakeGitPath = out
	})
	if fakeGitErr != nil {
		t.Fatalf("buildFakeGit: %v", fakeGitErr)
	}
	return fakeGitPath
}

// newFakeRunner vrátí Runner, který používá zkompilovaný fake git s danou
// sekvencí callResponse.
func newFakeRunner(t *testing.T, behavior []callResponse) (*Runner, string) {
	t.Helper()
	gitPath := buildFakeGit(t)

	scratch := t.TempDir()
	behaviorPath := filepath.Join(scratch, "behavior.txt")
	logPath := filepath.Join(scratch, "calls.log")

	var bb strings.Builder
	for _, r := range behavior {
		bb.WriteString(fmt.Sprintf("%d\t%s\n", r.exit, strings.ReplaceAll(r.stderr, "\n", `\n`)))
	}
	if err := os.WriteFile(behaviorPath, []byte(bb.String()), 0o600); err != nil {
		t.Fatalf("write behavior: %v", err)
	}

	// Runner si přebírá env z os.Environ() — proto musíme nastavit FAKE_GIT_*
	// na úrovni testovacího procesu.
	t.Setenv("FAKE_GIT_BEHAVIOR", behaviorPath)
	t.Setenv("FAKE_GIT_LOG", logPath)

	return &Runner{GitPath: gitPath, Logger: testLogger()}, logPath
}

func loadCalls(t *testing.T, path string) []string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		t.Fatalf("read log: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
	if len(lines) == 1 && lines[0] == "" {
		return nil
	}
	return lines
}

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError}))
}

func TestLadder_L1_Success(t *testing.T) {
	runner, logPath := newFakeRunner(t, []callResponse{
		{exit: 0}, // clone success
		{exit: 0}, // rev-parse HEAD
	})

	ladder := &Ladder{Runner: runner, Keyring: NewMemoryKeyring(), Logger: testLogger()}

	dest := filepath.Join(t.TempDir(), "out")
	res, err := ladder.Clone(context.Background(), CloneOptions{
		URL:  "https://github.com/owner/repo.git",
		Dest: dest,
	})
	if err != nil {
		t.Fatalf("Clone: %v", err)
	}
	if res.AuthMethod != AuthMethodSystem {
		t.Errorf("AuthMethod = %q, want system", res.AuthMethod)
	}

	calls := loadCalls(t, logPath)
	if len(calls) != 2 {
		t.Errorf("expected 2 calls (clone + rev-parse), got %d: %v", len(calls), calls)
	}
}

func TestLadder_L1_FailsAuth_L2_KeyringSuccess(t *testing.T) {
	runner, logPath := newFakeRunner(t, []callResponse{
		// 1) Plain clone — auth fail
		{exit: 128, stderr: "fatal: Authentication failed for 'https://github.com/owner/private.git/'"},
		// 2) Retry clone s GIT_ASKPASS — success
		{exit: 0},
		// 3) rev-parse HEAD
		{exit: 0},
	})

	keyring := NewMemoryKeyring()
	_ = keyring.Set("github.com", "ghp_test_TOKEN")

	ladder := &Ladder{Runner: runner, Keyring: keyring, Logger: testLogger()}

	dest := filepath.Join(t.TempDir(), "out")
	res, err := ladder.Clone(context.Background(), CloneOptions{
		URL:  "https://github.com/owner/private.git",
		Dest: dest,
	})
	if err != nil {
		t.Fatalf("Clone: %v", err)
	}
	if res.AuthMethod != AuthMethodKeyringPAT {
		t.Errorf("AuthMethod = %q, want keyring-pat", res.AuthMethod)
	}

	calls := loadCalls(t, logPath)
	if len(calls) < 3 {
		t.Errorf("expected ≥3 calls (clone, retry-clone, rev-parse), got %d: %v", len(calls), calls)
	}
}

func TestLadder_L1_FailsAuth_NoKeyringToken_ReturnsAuthRequired(t *testing.T) {
	runner, _ := newFakeRunner(t, []callResponse{
		{exit: 128, stderr: "fatal: Authentication failed"},
	})

	ladder := &Ladder{Runner: runner, Keyring: NewMemoryKeyring(), Logger: testLogger()}

	_, err := ladder.Clone(context.Background(), CloneOptions{
		URL:  "https://github.com/owner/private.git",
		Dest: filepath.Join(t.TempDir(), "out"),
	})
	if err == nil {
		t.Fatal("čekám error")
	}
	var authErr *AuthRequiredError
	if !errors.As(err, &authErr) {
		t.Fatalf("err není *AuthRequiredError: %T %v", err, err)
	}
	if authErr.Host != "github.com" {
		t.Errorf("Host = %q, want github.com", authErr.Host)
	}
}

func TestLadder_L1_FailsNonAuth_NoRetry(t *testing.T) {
	runner, logPath := newFakeRunner(t, []callResponse{
		{exit: 128, stderr: "fatal: repository 'https://github.com/owner/missing.git/' not found"},
	})
	keyring := NewMemoryKeyring()
	_ = keyring.Set("github.com", "token") // i s tokenem nesmí retryovat

	ladder := &Ladder{Runner: runner, Keyring: keyring, Logger: testLogger()}

	_, err := ladder.Clone(context.Background(), CloneOptions{
		URL:  "https://github.com/owner/missing.git",
		Dest: filepath.Join(t.TempDir(), "out"),
	})
	if err == nil {
		t.Fatal("čekám error")
	}
	var notFound *NotFoundError
	if !errors.As(err, &notFound) {
		t.Fatalf("err není *NotFoundError: %T %v", err, err)
	}

	calls := loadCalls(t, logPath)
	if len(calls) != 1 {
		t.Errorf("expected exactly 1 call (no retry), got %d: %v", len(calls), calls)
	}
}
