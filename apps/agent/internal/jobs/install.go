// SPDX-License-Identifier: Apache-2.0
package jobs

import (
	"archive/tar"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type InstallRequest struct {
	DownloadURL string
	Sha256      string
	TargetPath  string
}

func (j *Jobs) Install(req InstallRequest) error {
	abs, err := filepath.Abs(req.TargetPath)
	if err != nil {
		return err
	}
	rootAbs, err := filepath.Abs(j.SkillsRoot)
	if err != nil {
		return err
	}
	if !strings.HasPrefix(abs+string(os.PathSeparator), rootAbs+string(os.PathSeparator)) {
		return fmt.Errorf("target outside skills root")
	}

	httpReq, err := http.NewRequest("GET", req.DownloadURL, nil)
	if err != nil {
		return err
	}
	resp, err := j.HTTPClient.Do(httpReq)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("download status %d", resp.StatusCode)
	}

	tmp, err := os.CreateTemp("", "hub-install-*.tar.gz")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	h := sha256.New()
	if _, err := io.Copy(io.MultiWriter(tmp, h), resp.Body); err != nil {
		return err
	}
	if hex.EncodeToString(h.Sum(nil)) != req.Sha256 {
		return fmt.Errorf("sha256 mismatch")
	}
	if _, err := tmp.Seek(0, 0); err != nil {
		return err
	}

	if _, err := os.Stat(abs); err == nil {
		backupRoot := filepath.Join(rootAbs, ".claude-hub-backup")
		if err := os.MkdirAll(backupRoot, 0o755); err != nil {
			return err
		}
		backupDir := filepath.Join(backupRoot, fmt.Sprintf("%s-%d", filepath.Base(abs), time.Now().Unix()))
		if err := os.Rename(abs, backupDir); err != nil {
			return err
		}
	}
	if err := os.MkdirAll(abs, 0o755); err != nil {
		return err
	}

	gz, err := gzip.NewReader(tmp)
	if err != nil {
		return err
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		clean := filepath.Clean(hdr.Name)
		if strings.HasPrefix(clean, "..") || strings.Contains(clean, ".."+string(os.PathSeparator)) || filepath.IsAbs(clean) {
			return fmt.Errorf("unsafe path in archive: %s", hdr.Name)
		}
		out := filepath.Join(abs, filepath.FromSlash(clean))
		outAbs, err := filepath.Abs(out)
		if err != nil {
			return err
		}
		if !strings.HasPrefix(outAbs+string(os.PathSeparator), abs+string(os.PathSeparator)) && outAbs != abs {
			return fmt.Errorf("escape attempt: %s", hdr.Name)
		}
		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(out, os.FileMode(hdr.Mode)); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
				return err
			}
			f, err := os.OpenFile(out, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, os.FileMode(hdr.Mode))
			if err != nil {
				return err
			}
			if _, err := io.Copy(f, tr); err != nil {
				f.Close()
				return err
			}
			f.Close()
		}
	}
	return nil
}
