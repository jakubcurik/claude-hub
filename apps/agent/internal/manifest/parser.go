// SPDX-License-Identifier: Apache-2.0
package manifest

import "github.com/animato/claude-hub/agent/internal/api"

type Parser interface {
	Parse(path string) (api.InventoryItem, error)
}

type Noop struct{}

func NewNoop() *Noop { return &Noop{} }

func (n *Noop) Parse(_ string) (api.InventoryItem, error) {
	return api.InventoryItem{}, nil
}
