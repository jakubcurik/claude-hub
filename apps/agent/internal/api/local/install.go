// SPDX-License-Identifier: Apache-2.0
package local

import (
	"encoding/json"
	"fmt"
	"net/http"
	"path/filepath"

	"github.com/animato/claude-hub/agent/internal/jobs"
)

type Installer interface {
	Install(req jobs.InstallRequest) error
}

type installBody struct {
	ArtifactSlug string `json:"artifact_slug"`
	Version      string `json:"version"`
}

// InstallHandler returns a handler for POST /v1/install. It first calls the hub
// to resolve the artifact's presigned download URL + sha256, then delegates to
// the local Installer.
func InstallHandler(inst Installer, hubURL string, hubClient *http.Client, token, skillsRoot string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !checkToken(r, token) {
			writeErr(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		var body installBody
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, "bad json")
			return
		}
		url := fmt.Sprintf("%s/api/artifacts/%s/versions/%s/download", hubURL, body.ArtifactSlug, body.Version)
		req, _ := http.NewRequest(http.MethodGet, url, nil)
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err := hubClient.Do(req)
		if err != nil {
			writeErr(w, http.StatusBadGateway, "hub unreachable")
			return
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			writeErr(w, http.StatusBadGateway, "hub error")
			return
		}
		var meta struct {
			DownloadURL string `json:"downloadUrl"`
			Sha256      string `json:"sha256"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&meta); err != nil {
			writeErr(w, http.StatusBadGateway, "bad hub response")
			return
		}
		target := filepath.Join(skillsRoot, body.ArtifactSlug)
		if err := inst.Install(jobs.InstallRequest{
			DownloadURL: meta.DownloadURL,
			Sha256:      meta.Sha256,
			TargetPath:  target,
		}); err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "path": target})
	})
}
