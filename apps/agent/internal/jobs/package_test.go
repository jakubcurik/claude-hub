// SPDX-License-Identifier: Apache-2.0
package jobs

import (
	"archive/tar"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"path/filepath"
	"testing"
)

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestPackageDir_RoundTrip(t *testing.T) {
	src := t.TempDir()
	writeFile(t, filepath.Join(src, "SKILL.md"), "---\nname: x\n---\n")
	writeFile(t, filepath.Join(src, "sub", "a.txt"), "hello")

	dest := filepath.Join(t.TempDir(), "out.tar.gz")
	sha, err := PackageDir(src, dest)
	if err != nil {
		t.Fatalf("PackageDir: %v", err)
	}
	if len(sha) != 64 {
		t.Fatalf("sha256 length: %d", len(sha))
	}

	f, err := os.Open(dest)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		t.Fatal(err)
	}
	if hex.EncodeToString(h.Sum(nil)) != sha {
		t.Fatalf("sha mismatch")
	}

	if _, err := f.Seek(0, 0); err != nil {
		t.Fatal(err)
	}
	gz, err := gzip.NewReader(f)
	if err != nil {
		t.Fatal(err)
	}
	tr := tar.NewReader(gz)
	seen := map[string]string{}
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		if hdr.Typeflag == tar.TypeReg {
			b, _ := io.ReadAll(tr)
			seen[hdr.Name] = string(b)
		}
	}
	if seen["SKILL.md"] == "" || seen["sub/a.txt"] != "hello" {
		t.Fatalf("missing files: %+v", seen)
	}
}
