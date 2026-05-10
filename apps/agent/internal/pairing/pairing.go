// SPDX-License-Identifier: Apache-2.0
package pairing

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	"github.com/animato/claude-hub/agent/internal/storage/keychain"
)

type registerReq struct {
	Pin          string `json:"pin"`
	Hostname     string `json:"hostname"`
	OS           string `json:"os"`
	AgentVersion string `json:"agentVersion"`
}

type registerResp struct {
	DaemonID    string `json:"daemonId"`
	DeviceToken string `json:"deviceToken"`
}

func Pair(hubURL, pin, hostname, osName, agentVersion string, store keychain.Store) error {
	body, err := json.Marshal(registerReq{Pin: pin, Hostname: hostname, OS: osName, AgentVersion: agentVersion})
	if err != nil {
		return fmt.Errorf("pairing: marshal: %w", err)
	}
	resp, err := http.Post(hubURL+"/api/daemons/register", "application/json", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("pairing: post failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("pairing: hub returned %d: %s", resp.StatusCode, string(b))
	}
	var rr registerResp
	if err := json.NewDecoder(resp.Body).Decode(&rr); err != nil {
		return fmt.Errorf("pairing: decode: %w", err)
	}
	if err := store.Set("device_token", rr.DeviceToken); err != nil {
		return err
	}
	if err := store.Set("daemon_id", rr.DaemonID); err != nil {
		return err
	}
	if err := store.Set("hub_url", hubURL); err != nil {
		return err
	}
	return nil
}
