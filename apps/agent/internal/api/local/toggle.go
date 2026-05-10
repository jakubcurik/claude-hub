// SPDX-License-Identifier: Apache-2.0
package local

import (
	"encoding/json"
	"net/http"
)

// Registry resolves a local artifactId to its type (skill/plugin/command/agent).
// In Plan 3 only skills are present, but the toggle endpoint must answer
// correctly for future types.
type Registry interface {
	FindByArtifactID(id string) (string, bool)
}

type toggleBody struct {
	ArtifactID string `json:"artifact_id"`
	Enabled    bool   `json:"enabled"`
}

// ToggleHandler returns 400 for skills (no toggle in MVP), 404 for unknown
// artifact, 501 for non-skill types (deferred to Plan 4).
func ToggleHandler(reg Registry, token string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !checkToken(r, token) {
			writeErr(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		var body toggleBody
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, "bad json")
			return
		}
		artType, ok := reg.FindByArtifactID(body.ArtifactID)
		if !ok {
			writeErr(w, http.StatusNotFound, "not found")
			return
		}
		if artType == "skill" {
			writeErr(w, http.StatusBadRequest, "skills don't support toggle in MVP")
			return
		}
		writeErr(w, http.StatusNotImplemented, "type not supported in Plan 3")
	})
}
