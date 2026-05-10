// SPDX-License-Identifier: Apache-2.0
package scanner

import "github.com/animato/claude-hub/agent/internal/api"

type Scanner interface {
	Scan(claudeHome string) ([]api.InventoryItem, error)
}

type Noop struct{}

func NewNoop() *Noop { return &Noop{} }

func (n *Noop) Scan(_ string) ([]api.InventoryItem, error) {
	return []api.InventoryItem{}, nil
}
