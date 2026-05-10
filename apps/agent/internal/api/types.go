// SPDX-License-Identifier: Apache-2.0
package api

type ArtifactType string

const (
	ArtifactSkill   ArtifactType = "skill"
	ArtifactPlugin  ArtifactType = "plugin"
	ArtifactCommand ArtifactType = "command"
	ArtifactAgent   ArtifactType = "agent"
)

type PublishedAsRef struct {
	ArtifactID string `json:"artifactId"`
	Version    string `json:"version"`
}

type InventoryItem struct {
	Type        ArtifactType    `json:"type"`
	Slug        string          `json:"slug"`
	Version     string          `json:"version,omitempty"`
	Path        string          `json:"path"`
	Enabled     *bool           `json:"enabled,omitempty"`
	PublishedAs *PublishedAsRef `json:"publishedAs,omitempty"`
}

type DaemonOS string

const (
	OSWindows DaemonOS = "windows"
	OSMacOS   DaemonOS = "macos"
	OSLinux   DaemonOS = "linux"
)
