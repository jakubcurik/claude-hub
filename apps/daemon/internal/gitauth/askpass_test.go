package gitauth

import (
	"os"
	"runtime"
	"strings"
	"testing"
)

func TestWriteAskpassScript_WritesAndCleansUp(t *testing.T) {
	token := "ghp_test_TOKEN_12345"
	path, cleanup, err := WriteAskpassScript(token)
	if err != nil {
		t.Fatalf("WriteAskpassScript: %v", err)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("Stat skriptu: %v", err)
	}
	if info.IsDir() {
		t.Fatal("askpass cesta je adresář, čekám soubor")
	}

	if runtime.GOOS != "windows" {
		// POSIX: mode 0700 (jen owner)
		if info.Mode().Perm() != 0o700 {
			t.Errorf("mode = %v, chci 0o700", info.Mode().Perm())
		}
	}

	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read script: %v", err)
	}
	if !strings.Contains(string(content), token) {
		t.Errorf("skript neobsahuje token: %s", string(content))
	}

	cleanup()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Errorf("po cleanup soubor stále existuje, err=%v", err)
	}
}

func TestWriteAskpassScript_EmptyToken(t *testing.T) {
	_, _, err := WriteAskpassScript("")
	if err == nil {
		t.Fatal("čekám error pro prázdný token")
	}
}

func TestShellQuote(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"simple", `'simple'`},
		{"with space", `'with space'`},
		{`with'quote`, `'with'\''quote'`},
	}
	for _, tc := range cases {
		got := shellQuote(tc.in)
		if got != tc.want {
			t.Errorf("shellQuote(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}
