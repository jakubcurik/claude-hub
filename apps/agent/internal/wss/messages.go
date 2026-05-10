// SPDX-License-Identifier: Apache-2.0
package wss

import (
	"encoding/json"
	"errors"
)

const (
	TypePing           = "ping"
	TypePong           = "pong"
	TypeInventorySnap  = "inventory.snapshot"
	TypeInventoryDelta = "inventory.delta"
	TypeJobInstall     = "job.install"
	TypeJobUninstall   = "job.uninstall"
	TypeJobToggle      = "job.toggle"
	TypeJobPackage     = "job.package"
	TypeJobResult      = "job.result"
)

type Message struct {
	Type    string          `json:"type"`
	ID      string          `json:"id"`
	Payload json.RawMessage `json:"payload"`
}

func ParseMessage(raw []byte) (*Message, error) {
	var m Message
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, err
	}
	if m.Type == "" {
		return nil, errors.New("wss: missing type")
	}
	if m.ID == "" {
		return nil, errors.New("wss: missing id")
	}
	if len(m.Payload) == 0 {
		m.Payload = json.RawMessage(`{}`)
	}
	return &m, nil
}

func NewPong(id string) Message {
	return Message{Type: TypePong, ID: id, Payload: json.RawMessage(`{}`)}
}
