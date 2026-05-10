// SPDX-License-Identifier: Apache-2.0
package jobs

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"

	"github.com/animato/claude-hub/agent/internal/api"
)

type PublishRequest struct {
	Slug        string
	Type        string
	Version     string
	Description string
	SourcePath  string
}

type PublishResult struct {
	ArtifactID string `json:"artifactId"`
	VersionID  string `json:"versionId"`
}

func (j *Jobs) Publish(req PublishRequest) (*PublishResult, error) {
	parser, ok := j.Parsers[api.ArtifactType(req.Type)]
	if !ok {
		return nil, fmt.Errorf("no parser for type %s", req.Type)
	}
	m, err := parser.Parse(req.SourcePath)
	if err != nil {
		return nil, fmt.Errorf("parse manifest: %w", err)
	}
	if req.Description != "" {
		m.Description = req.Description
	}

	tmp := filepath.Join(os.TempDir(), fmt.Sprintf("hub-pub-%s-%s.tar.gz", req.Slug, req.Version))
	defer os.Remove(tmp)
	sha, err := PackageDir(req.SourcePath, tmp)
	if err != nil {
		return nil, fmt.Errorf("package: %w", err)
	}

	body := &bytes.Buffer{}
	w := multipart.NewWriter(body)
	if err := w.WriteField("slug", req.Slug); err != nil {
		return nil, err
	}
	if err := w.WriteField("type", req.Type); err != nil {
		return nil, err
	}
	if err := w.WriteField("version", req.Version); err != nil {
		return nil, err
	}
	if err := w.WriteField("description", req.Description); err != nil {
		return nil, err
	}
	if err := w.WriteField("sha256", sha); err != nil {
		return nil, err
	}
	mj, err := json.Marshal(m)
	if err != nil {
		return nil, err
	}
	if err := w.WriteField("manifest", string(mj)); err != nil {
		return nil, err
	}
	fw, err := w.CreateFormFile("file", filepath.Base(tmp))
	if err != nil {
		return nil, err
	}
	f, err := os.Open(tmp)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	if _, err := io.Copy(fw, f); err != nil {
		return nil, err
	}
	if err := w.Close(); err != nil {
		return nil, err
	}

	httpReq, err := http.NewRequest("POST", j.HubURL+"/api/artifacts/upload", body)
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", w.FormDataContentType())
	httpReq.Header.Set("Authorization", "Bearer "+j.DeviceToken)
	resp, err := j.HTTPClient.Do(httpReq)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		b, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("upload failed: %d %s", resp.StatusCode, string(b))
	}
	var out PublishResult
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	return &out, nil
}
