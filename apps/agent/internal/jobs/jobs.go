// SPDX-License-Identifier: Apache-2.0
package jobs

import (
	"net/http"

	"github.com/animato/claude-hub/agent/internal/api"
	"github.com/animato/claude-hub/agent/internal/manifest"
)

type Jobs struct {
	HubURL      string
	DeviceToken string
	HTTPClient  *http.Client
	Parsers     map[api.ArtifactType]manifest.Parser
	SkillsRoot  string
}

func New(hubURL, deviceToken, skillsRoot string) *Jobs {
	return &Jobs{
		HubURL:      hubURL,
		DeviceToken: deviceToken,
		HTTPClient:  &http.Client{},
		SkillsRoot:  skillsRoot,
		Parsers: map[api.ArtifactType]manifest.Parser{
			api.ArtifactSkill: manifest.SkillParser{},
		},
	}
}
