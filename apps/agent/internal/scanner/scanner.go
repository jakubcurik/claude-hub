// SPDX-License-Identifier: Apache-2.0
package scanner

import (
	"github.com/animato/claude-hub/agent/internal/api"
)

type Scanner interface {
	Type() api.ArtifactType
	Scan() ([]api.InventoryItem, error)
}

type Registry struct {
	scanners []Scanner
}

func NewRegistry(scs ...Scanner) *Registry {
	return &Registry{scanners: scs}
}

func (r *Registry) ScanAll() ([]api.InventoryItem, error) {
	out := []api.InventoryItem{}
	for _, s := range r.scanners {
		items, err := s.Scan()
		if err != nil {
			return nil, err
		}
		out = append(out, items...)
	}
	return out, nil
}
