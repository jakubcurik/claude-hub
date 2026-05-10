// SPDX-License-Identifier: Apache-2.0
package manifest

import "github.com/animato/claude-hub/agent/internal/api"

type ArtifactManifest struct {
	SchemaVersion int                    `json:"schemaVersion"`
	Name          string                 `json:"name"`
	Type          api.ArtifactType       `json:"type"`
	Description   string                 `json:"description"`
	TypeMeta      map[string]interface{} `json:"typeMeta"`
}

type Parser interface {
	Type() api.ArtifactType
	Parse(rootDir string) (*ArtifactManifest, error)
}
