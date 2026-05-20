package gitauth

import (
	"errors"
	"testing"
)

func TestHostFromURL(t *testing.T) {
	cases := []struct {
		name    string
		in      string
		want    string
		wantErr bool
	}{
		{"https github", "https://github.com/owner/repo.git", "github.com", false},
		{"https gitlab port", "https://gitlab.example.com:8080/foo.git", "gitlab.example.com", false},
		{"ssh shorthand", "git@github.com:owner/repo.git", "github.com", false},
		{"ssh url", "ssh://git@gitlab.com/owner/repo.git", "gitlab.com", false},
		{"empty", "", "", true},
		{"no host", "::nonsense::", "", true},
		{"uppercase host", "https://GitHub.com/owner/repo", "github.com", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := HostFromURL(tc.in)
			if (err != nil) != tc.wantErr {
				t.Fatalf("err = %v, wantErr=%v", err, tc.wantErr)
			}
			if got != tc.want {
				t.Errorf("HostFromURL(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestMemoryKeyring(t *testing.T) {
	k := NewMemoryKeyring()

	if _, err := k.Get("github.com"); !errors.Is(err, ErrKeyringMiss) {
		t.Fatalf("expected miss, got %v", err)
	}

	if err := k.Set("github.com", "token-abc"); err != nil {
		t.Fatalf("Set: %v", err)
	}

	got, err := k.Get("GitHub.com") // case-insensitive lookup
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got != "token-abc" {
		t.Errorf("got %q, want token-abc", got)
	}

	if err := k.Delete("github.com"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err := k.Get("github.com"); !errors.Is(err, ErrKeyringMiss) {
		t.Fatalf("expected miss after delete, got %v", err)
	}
}
