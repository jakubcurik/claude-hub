// SPDX-License-Identifier: Apache-2.0
package wss

import "github.com/animato/claude-hub/agent/internal/api"

type InventoryDelta struct {
	Added    []api.InventoryItem `json:"added"`
	Removed  []RemovedRef        `json:"removed"`
	Modified []api.InventoryItem `json:"modified"`
}

type RemovedRef struct {
	Type string `json:"type"`
	Slug string `json:"slug"`
}

func itemKey(i api.InventoryItem) string { return string(i.Type) + ":" + i.Slug }

func DiffInventory(prev, cur []api.InventoryItem) InventoryDelta {
	prevIdx := make(map[string]api.InventoryItem, len(prev))
	for _, p := range prev {
		prevIdx[itemKey(p)] = p
	}
	curIdx := make(map[string]api.InventoryItem, len(cur))
	for _, c := range cur {
		curIdx[itemKey(c)] = c
	}

	var added, modified []api.InventoryItem
	var removed []RemovedRef
	for k, c := range curIdx {
		p, ok := prevIdx[k]
		if !ok {
			added = append(added, c)
			continue
		}
		if p.Version != c.Version || !equalEnabled(p.Enabled, c.Enabled) {
			modified = append(modified, c)
		}
	}
	for k, p := range prevIdx {
		if _, ok := curIdx[k]; !ok {
			removed = append(removed, RemovedRef{Type: string(p.Type), Slug: p.Slug})
		}
	}
	return InventoryDelta{
		Added:    nilToEmpty(added),
		Removed:  nilRefsToEmpty(removed),
		Modified: nilToEmpty(modified),
	}
}

func equalEnabled(a, b *bool) bool {
	if a == nil && b == nil {
		return true
	}
	if a == nil || b == nil {
		return false
	}
	return *a == *b
}

func nilToEmpty(s []api.InventoryItem) []api.InventoryItem {
	if s == nil {
		return []api.InventoryItem{}
	}
	return s
}

func nilRefsToEmpty(s []RemovedRef) []RemovedRef {
	if s == nil {
		return []RemovedRef{}
	}
	return s
}

func SnapshotPayload(items []api.InventoryItem) map[string]any {
	return map[string]any{"items": items}
}

func DeltaPayload(d InventoryDelta) map[string]any {
	return map[string]any{
		"added":    d.Added,
		"removed":  d.Removed,
		"modified": d.Modified,
	}
}
