// SPDX-License-Identifier: Apache-2.0
package manifest

import (
	"errors"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/animato/claude-hub/agent/internal/api"
)

type SkillParser struct{}

func (SkillParser) Type() api.ArtifactType { return api.ArtifactSkill }

func (SkillParser) Parse(rootDir string) (*ArtifactManifest, error) {
	candidates := []string{
		filepath.Join(rootDir, "SKILL.md"),
		filepath.Join(rootDir, filepath.Base(rootDir)+".md"),
	}
	var data []byte
	var lastErr error
	for _, p := range candidates {
		b, err := os.ReadFile(p)
		if err == nil {
			data = b
			lastErr = nil
			break
		}
		lastErr = err
	}
	if data == nil {
		return nil, errors.New("no SKILL.md or <basename>.md found: " + lastErr.Error())
	}
	text := string(data)
	if !strings.HasPrefix(text, "---\n") {
		return nil, errors.New("missing frontmatter")
	}
	rest := text[4:]
	end := strings.Index(rest, "\n---")
	if end < 0 {
		return nil, errors.New("unterminated frontmatter")
	}
	fm := rest[:end]
	var raw struct {
		Name        string `yaml:"name"`
		Description string `yaml:"description"`
	}
	if err := yaml.Unmarshal([]byte(fm), &raw); err != nil {
		return nil, err
	}
	if raw.Name == "" {
		return nil, errors.New("name required")
	}
	return &ArtifactManifest{
		SchemaVersion: 1,
		Name:          raw.Name,
		Type:          api.ArtifactSkill,
		Description:   raw.Description,
		TypeMeta:      map[string]interface{}{},
	}, nil
}
