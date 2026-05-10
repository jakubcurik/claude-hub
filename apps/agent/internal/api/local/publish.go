// SPDX-License-Identifier: Apache-2.0
package local

import (
	"encoding/json"
	"net/http"

	"github.com/animato/claude-hub/agent/internal/jobs"
)

type Publisher interface {
	Publish(req jobs.PublishRequest) (*jobs.PublishResult, error)
}

type publishBody struct {
	Slug        string `json:"slug"`
	Type        string `json:"type"`
	Version     string `json:"version"`
	Description string `json:"description"`
	SourcePath  string `json:"source_path"`
}

func PublishHandler(p Publisher, expectedToken string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !checkToken(r, expectedToken) {
			writeErr(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		var body publishBody
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, "bad json")
			return
		}
		if body.Type != "skill" {
			writeErr(w, http.StatusBadRequest, "only skill in MVP")
			return
		}
		res, err := p.Publish(jobs.PublishRequest{
			Slug:        body.Slug,
			Type:        body.Type,
			Version:     body.Version,
			Description: body.Description,
			SourcePath:  body.SourcePath,
		})
		if err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{
			"artifactId": res.ArtifactID,
			"versionId":  res.VersionID,
		})
	})
}

// checkToken validates the Authorization header. Shared by local-API handler
// factories (T27-T30) so each can be tested in isolation while keeping the
// bearer-token convention consistent with the Server middleware.
func checkToken(r *http.Request, expected string) bool {
	auth := r.Header.Get("Authorization")
	return auth == "Bearer "+expected
}

// writeErr emits a JSON error envelope.
func writeErr(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
