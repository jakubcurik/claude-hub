// SPDX-License-Identifier: Apache-2.0
package scanner

import (
	"log/slog"
	"os"
	"path/filepath"

	"github.com/animato/claude-hub/agent/internal/api"
	"github.com/animato/claude-hub/agent/internal/manifest"
)

type SkillScanner struct {
	Root string
}

func (s SkillScanner) Type() api.ArtifactType { return api.ArtifactSkill }

func (s SkillScanner) Scan() ([]api.InventoryItem, error) {
	entries, err := os.ReadDir(s.Root)
	if err != nil {
		if os.IsNotExist(err) {
			return []api.InventoryItem{}, nil
		}
		return nil, err
	}
	parser := manifest.SkillParser{}
	out := make([]api.InventoryItem, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		if e.Name() == ".claude-hub-backup" {
			continue
		}
		sub := filepath.Join(s.Root, e.Name())
		m, err := parser.Parse(sub)
		if err != nil {
			slog.Debug("skill scan: skipping dir", "dir", sub, "err", err)
			continue
		}
		out = append(out, api.InventoryItem{
			Type: api.ArtifactSkill,
			Slug: m.Name,
			Path: sub,
		})
	}
	return out, nil
}
