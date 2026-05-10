// SPDX-License-Identifier: Apache-2.0
package pairing

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
)

type fakeStore struct{ kv map[string]string }

func (f *fakeStore) Set(k, v string) error        { f.kv[k] = v; return nil }
func (f *fakeStore) Get(k string) (string, error) { return f.kv[k], nil }
func (f *fakeStore) Delete(k string) error        { delete(f.kv, k); return nil }

func TestPairCallsRegisterAndStoresToken(t *testing.T) {
	var got struct{ Pin, Hostname, OS, AgentVersion string }
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/api/daemons/register", r.URL.Path)
		require.NoError(t, json.NewDecoder(r.Body).Decode(&struct {
			Pin          *string `json:"pin"`
			Hostname     *string `json:"hostname"`
			OS           *string `json:"os"`
			AgentVersion *string `json:"agentVersion"`
		}{&got.Pin, &got.Hostname, &got.OS, &got.AgentVersion}))
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"daemonId": "d-123", "deviceToken": "tok-xyz"})
	}))
	defer srv.Close()

	store := &fakeStore{kv: map[string]string{}}
	err := Pair(srv.URL, "482913", "myhost", "macos", "0.1.0", store)
	require.NoError(t, err)
	require.Equal(t, "482913", got.Pin)
	require.Equal(t, "tok-xyz", store.kv["device_token"])
	require.Equal(t, "d-123", store.kv["daemon_id"])
	require.Equal(t, srv.URL, store.kv["hub_url"])
}
