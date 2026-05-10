// SPDX-License-Identifier: Apache-2.0
package wss

import (
	"encoding/json"
	"testing"

	"github.com/animato/claude-hub/agent/internal/api"
)

func TestDiffInventory_AddedRemovedModified(t *testing.T) {
	prev := []api.InventoryItem{
		{Type: api.ArtifactSkill, Slug: "kept", Path: "/a"},
		{Type: api.ArtifactSkill, Slug: "removed", Path: "/b"},
		{Type: api.ArtifactSkill, Slug: "modified", Path: "/c", Version: "0.1.0"},
	}
	cur := []api.InventoryItem{
		{Type: api.ArtifactSkill, Slug: "kept", Path: "/a"},
		{Type: api.ArtifactSkill, Slug: "added", Path: "/d"},
		{Type: api.ArtifactSkill, Slug: "modified", Path: "/c", Version: "0.2.0"},
	}
	diff := DiffInventory(prev, cur)
	if len(diff.Added) != 1 || diff.Added[0].Slug != "added" {
		t.Fatalf("added wrong: %+v", diff.Added)
	}
	if len(diff.Removed) != 1 || diff.Removed[0].Slug != "removed" {
		t.Fatalf("removed wrong: %+v", diff.Removed)
	}
	if len(diff.Modified) != 1 || diff.Modified[0].Slug != "modified" {
		t.Fatalf("modified wrong: %+v", diff.Modified)
	}
}

func TestSnapshotPayload_Serializes(t *testing.T) {
	items := []api.InventoryItem{{Type: api.ArtifactSkill, Slug: "foo", Path: "/x"}}
	payload := SnapshotPayload(items)
	b, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	if string(b) == "" {
		t.Fatal("empty payload")
	}
}
