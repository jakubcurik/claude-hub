// SPDX-License-Identifier: Apache-2.0
package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestStatusPrintsJSONFromLocalAPI(t *testing.T) {
	tokenPath := t.TempDir() + "/agent.token"
	require.NoError(t, os.WriteFile(tokenPath, []byte("local-tok"), 0o600))

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "Bearer local-tok", r.Header.Get("Authorization"))
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"paired":        true,
			"hub_url":       "https://hub",
			"agent_version": "0.1.0",
			"online":        true,
		})
	}))
	defer srv.Close()

	var out bytes.Buffer
	cmd := newStatusCmdWithDeps(srv.URL, tokenPath)
	cmd.SetOut(&out)
	require.NoError(t, cmd.Execute())
	require.Contains(t, out.String(), `"paired":true`)
}
