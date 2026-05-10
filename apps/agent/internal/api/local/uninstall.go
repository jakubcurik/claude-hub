// SPDX-License-Identifier: Apache-2.0
package local

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type uninstallBody struct {
	Slug string `json:"slug"`
}

// UninstallHandler returns a handler for POST /v1/uninstall. It moves
// <skillsRoot>/<slug> into <skillsRoot>/.claude-hub-backup/<slug>-<unix-ts>/.
// Returns 404 if the target doesn't exist; 400 for invalid slug.
func UninstallHandler(skillsRoot, token string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !checkToken(r, token) {
			writeErr(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		var body uninstallBody
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, "bad json")
			return
		}
		if body.Slug == "" || strings.ContainsAny(body.Slug, "/\\") || strings.Contains(body.Slug, "..") {
			writeErr(w, http.StatusBadRequest, "invalid slug")
			return
		}
		target := filepath.Join(skillsRoot, body.Slug)
		if _, err := os.Stat(target); os.IsNotExist(err) {
			writeErr(w, http.StatusNotFound, "not found")
			return
		}
		backupRoot := filepath.Join(skillsRoot, ".claude-hub-backup")
		if err := os.MkdirAll(backupRoot, 0o755); err != nil {
			writeErr(w, http.StatusInternalServerError, "backup dir")
			return
		}
		backupDir := filepath.Join(backupRoot, fmt.Sprintf("%s-%d", body.Slug, time.Now().Unix()))
		if err := os.Rename(target, backupDir); err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "backup": backupDir})
	})
}
