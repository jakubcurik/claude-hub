// SPDX-License-Identifier: Apache-2.0
package local

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
)

type fakeState struct{}

func (fakeState) Status() StatusResponse {
	return StatusResponse{Paired: true, HubURL: "https://hub.example", AgentVersion: "0.1.0", Online: false}
}

func (fakeState) Pair(_, _ string) error { return nil }

func TestStatusRequiresBearerToken(t *testing.T) {
	h := NewServer("test-token", fakeState{}).Handler()
	req := httptest.NewRequest(http.MethodGet, "/v1/status", nil)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	require.Equal(t, http.StatusUnauthorized, rr.Code)
}

func TestStatusReturnsJSONWhenAuthorized(t *testing.T) {
	h := NewServer("test-token", fakeState{}).Handler()
	req := httptest.NewRequest(http.MethodGet, "/v1/status", nil)
	req.Header.Set("Authorization", "Bearer test-token")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	require.Equal(t, http.StatusOK, rr.Code)
	var got StatusResponse
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &got))
	require.True(t, got.Paired)
	require.Equal(t, "https://hub.example", got.HubURL)
}

func TestCORSDeniedByDefault(t *testing.T) {
	h := NewServer("test-token", fakeState{}).Handler()
	req := httptest.NewRequest(http.MethodOptions, "/v1/status", nil)
	req.Header.Set("Origin", "http://evil.example")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	require.Empty(t, rr.Header().Get("Access-Control-Allow-Origin"))
}
