// SPDX-License-Identifier: Apache-2.0
package jobs

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func makeTarGz(files map[string]string) ([]byte, string) {
	buf := &bytes.Buffer{}
	h := sha256.New()
	gz := gzip.NewWriter(buf)
	tw := tar.NewWriter(gz)
	for name, content := range files {
		hdr := &tar.Header{
			Name:     name,
			Mode:     0o644,
			Size:     int64(len(content)),
			Typeflag: tar.TypeReg,
		}
		_ = tw.WriteHeader(hdr)
		_, _ = tw.Write([]byte(content))
	}
	_ = tw.Close()
	_ = gz.Close()
	h.Write(buf.Bytes())
	return buf.Bytes(), hex.EncodeToString(h.Sum(nil))
}

func TestInstall_HappyPath(t *testing.T) {
	bytesGz, sha := makeTarGz(map[string]string{
		"SKILL.md":  "---\nname: foo\n---\n",
		"sub/a.txt": "hello",
	})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(bytesGz)
	}))
	defer srv.Close()

	home := t.TempDir()
	skillsRoot := filepath.Join(home, ".claude", "skills")
	if err := os.MkdirAll(skillsRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(skillsRoot, "foo")

	j := &Jobs{HTTPClient: srv.Client(), SkillsRoot: skillsRoot}
	if err := j.Install(InstallRequest{
		DownloadURL: srv.URL,
		Sha256:      sha,
		TargetPath:  target,
	}); err != nil {
		t.Fatalf("install: %v", err)
	}
	if _, err := os.Stat(filepath.Join(target, "SKILL.md")); err != nil {
		t.Fatalf("expected SKILL.md: %v", err)
	}
	if b, err := os.ReadFile(filepath.Join(target, "sub", "a.txt")); err != nil || string(b) != "hello" {
		t.Fatalf("sub file wrong: %v %s", err, b)
	}
}

func TestInstall_BackupOnReinstall(t *testing.T) {
	bytesGz, sha := makeTarGz(map[string]string{"SKILL.md": "---\nname: foo\n---\nv2"})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(bytesGz)
	}))
	defer srv.Close()

	skillsRoot := t.TempDir()
	target := filepath.Join(skillsRoot, "foo")
	_ = os.MkdirAll(target, 0o755)
	_ = os.WriteFile(filepath.Join(target, "OLD.md"), []byte("v1"), 0o644)

	j := &Jobs{HTTPClient: srv.Client(), SkillsRoot: skillsRoot}
	if err := j.Install(InstallRequest{
		DownloadURL: srv.URL, Sha256: sha, TargetPath: target,
	}); err != nil {
		t.Fatalf("install: %v", err)
	}
	backupRoot := filepath.Join(skillsRoot, ".claude-hub-backup")
	entries, err := os.ReadDir(backupRoot)
	if err != nil {
		t.Fatalf("backup root missing: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("expected 1 backup, got %d", len(entries))
	}
	if _, err := os.Stat(filepath.Join(backupRoot, entries[0].Name(), "OLD.md")); err != nil {
		t.Fatalf("expected OLD.md in backup: %v", err)
	}
}

func TestInstall_Sha256Mismatch(t *testing.T) {
	bytesGz, _ := makeTarGz(map[string]string{"SKILL.md": "---\nname: foo\n---\n"})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(bytesGz)
	}))
	defer srv.Close()

	skillsRoot := t.TempDir()
	target := filepath.Join(skillsRoot, "foo")
	j := &Jobs{HTTPClient: srv.Client(), SkillsRoot: skillsRoot}
	err := j.Install(InstallRequest{
		DownloadURL: srv.URL,
		Sha256:      strings.Repeat("a", 64),
		TargetPath:  target,
	})
	if err == nil {
		t.Fatal("expected sha mismatch error")
	}
	if _, statErr := os.Stat(target); !os.IsNotExist(statErr) {
		t.Fatalf("target should not exist on mismatch")
	}
}

func TestInstall_RejectsPathTraversal(t *testing.T) {
	var buf bytes.Buffer
	h := sha256.New()
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	payload := "pwned"
	_ = tw.WriteHeader(&tar.Header{
		Name:     "../../../etc/passwd",
		Mode:     0o644,
		Size:     int64(len(payload)),
		Typeflag: tar.TypeReg,
	})
	_, _ = tw.Write([]byte(payload))
	_ = tw.Close()
	_ = gz.Close()
	h.Write(buf.Bytes())
	sha := hex.EncodeToString(h.Sum(nil))

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(buf.Bytes())
	}))
	defer srv.Close()

	skillsRoot := t.TempDir()
	target := filepath.Join(skillsRoot, "foo")
	j := &Jobs{HTTPClient: srv.Client(), SkillsRoot: skillsRoot}
	err := j.Install(InstallRequest{DownloadURL: srv.URL, Sha256: sha, TargetPath: target})
	if err == nil {
		t.Fatal("expected path-traversal rejection")
	}
}

func TestInstall_RejectsTargetOutsideSkillsRoot(t *testing.T) {
	skillsRoot := t.TempDir()
	j := &Jobs{HTTPClient: http.DefaultClient, SkillsRoot: skillsRoot}
	err := j.Install(InstallRequest{
		DownloadURL: "http://x",
		Sha256:      "x",
		TargetPath:  filepath.Join(t.TempDir(), "elsewhere"),
	})
	if err == nil {
		t.Fatal("expected error for outside skills root")
	}
	if !strings.Contains(err.Error(), "outside skills root") {
		t.Fatalf("unexpected err: %v", err)
	}
}
