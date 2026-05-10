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
)

// PackageDir produces dest as a gzipped tar of src's contents.
// Returns the hex SHA-256 of the produced bytes.
func PackageDir(src, dest string) (string, error) {
	f, err := os.Create(dest)
	if err != nil {
		return "", err
	}
	defer f.Close()

	h := sha256.New()
	mw := io.MultiWriter(f, h)
	gz := gzip.NewWriter(mw)
	tw := tar.NewWriter(gz)

	walkErr := filepath.Walk(src, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, p)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		hdr, err := tar.FileInfoHeader(info, "")
		if err != nil {
			return err
		}
		hdr.Name = filepath.ToSlash(rel)
		if err := tw.WriteHeader(hdr); err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		rf, err := os.Open(p)
		if err != nil {
			return err
		}
		defer rf.Close()
		_, err = io.Copy(tw, rf)
		return err
	})
	if walkErr != nil {
		return "", walkErr
	}
	if err := tw.Close(); err != nil {
		return "", err
	}
	if err := gz.Close(); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
