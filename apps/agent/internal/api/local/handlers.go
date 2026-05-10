// SPDX-License-Identifier: Apache-2.0
package local

import (
	"encoding/json"
	"net/http"
)

type StatusResponse struct {
	Paired       bool   `json:"paired"`
	HubURL       string `json:"hub_url"`
	AgentVersion string `json:"agent_version"`
	Online       bool   `json:"online"`
}

type PairRequest struct {
	HubURL string `json:"hub_url"`
	Pin    string `json:"pin"`
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	writeJSON(w, http.StatusOK, s.state.Status())
}

func (s *Server) handlePair(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	var req PairRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	if err := s.state.Pair(req.HubURL, req.Pin); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "paired"})
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
