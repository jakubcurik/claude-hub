package claudecode

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// AssetDiffLine reprezentuje jeden řádek diff výstupu.
type AssetDiffLine struct {
	Type    string `json:"type"`              // "context" | "add" | "remove"
	Text    string `json:"text"`
	OldLine int    `json:"oldLine,omitempty"`
	NewLine int    `json:"newLine,omitempty"`
}

type AssetFileDiff struct {
	Path   string          `json:"path"`
	Status string          `json:"status"` // added | removed | modified | unchanged
	Lines  []AssetDiffLine `json:"lines"`
}

type AssetDiff struct {
	AssetID string          `json:"assetId"`
	Files   []AssetFileDiff `json:"files"`
}

// Diff vrací srovnání lokálního obsahu s katalogovou verzí pro skill/command assety.
// Pro merge typy (MCP/hook) by diff vyžadoval semantické porovnání struktury — to
// zatím není implementované a vrací chybu.
func (m *Manager) Diff(asset CatalogAsset) (AssetDiff, error) {
	asset = normalizeAsset(asset)
	if err := validateSupported(asset); err != nil {
		return AssetDiff{}, err
	}
	if asset.Type != AssetTypeSkill && asset.Type != AssetTypeCommand {
		return AssetDiff{}, errors.New("diff je zatím implementovaný jen pro skill a command")
	}

	paths := m.paths(asset)
	root := paths.TargetRoot
	isFile := asset.Type == AssetTypeCommand
	if !exists(root) {
		root = paths.DisabledRoot
	}

	localFiles := map[string]string{}
	if exists(root) {
		if isFile {
			content, _ := os.ReadFile(root)
			localFiles[filepath.Base(root)] = string(content)
		} else {
			_ = filepath.WalkDir(root, func(current string, entry os.DirEntry, _ error) error {
				if entry == nil || entry.IsDir() {
					return nil
				}
				relative, err := filepath.Rel(root, current)
				if err != nil {
					return nil
				}
				content, _ := os.ReadFile(current)
				localFiles[filepath.ToSlash(relative)] = string(content)
				return nil
			})
		}
	}

	catalogFiles := map[string]string{}
	for _, file := range asset.Files {
		catalogFiles[file.Path] = file.Content
	}

	allPaths := map[string]struct{}{}
	for path := range localFiles {
		allPaths[path] = struct{}{}
	}
	for path := range catalogFiles {
		allPaths[path] = struct{}{}
	}

	diff := AssetDiff{AssetID: asset.ID, Files: make([]AssetFileDiff, 0, len(allPaths))}
	for path := range allPaths {
		local, hasLocal := localFiles[path]
		remote, hasRemote := catalogFiles[path]

		fileDiff := AssetFileDiff{Path: path}
		switch {
		case !hasLocal && hasRemote:
			fileDiff.Status = "added"
			fileDiff.Lines = makeLines("add", remote)
		case hasLocal && !hasRemote:
			fileDiff.Status = "removed"
			fileDiff.Lines = makeLines("remove", local)
		case local == remote:
			fileDiff.Status = "unchanged"
			fileDiff.Lines = makeLines("context", local)
		default:
			fileDiff.Status = "modified"
			fileDiff.Lines = computeLineDiff(local, remote)
		}
		diff.Files = append(diff.Files, fileDiff)
	}

	return diff, nil
}

func makeLines(kind, content string) []AssetDiffLine {
	lines := splitLines(content)
	out := make([]AssetDiffLine, len(lines))
	for i, line := range lines {
		entry := AssetDiffLine{Type: kind, Text: line}
		switch kind {
		case "add":
			entry.NewLine = i + 1
		case "remove":
			entry.OldLine = i + 1
		default:
			entry.OldLine = i + 1
			entry.NewLine = i + 1
		}
		out[i] = entry
	}
	return out
}

// computeLineDiff vrátí line-level diff pomocí klasického LCS (Longest Common Subsequence).
// Pro běžné velikosti souborů (pod 10 000 řádků) je to dostatečně rychlé.
func computeLineDiff(oldText, newText string) []AssetDiffLine {
	oldLines := splitLines(oldText)
	newLines := splitLines(newText)

	n := len(oldLines)
	m := len(newLines)
	// LCS tabulka
	dp := make([][]int, n+1)
	for i := range dp {
		dp[i] = make([]int, m+1)
	}
	for i := n - 1; i >= 0; i-- {
		for j := m - 1; j >= 0; j-- {
			if oldLines[i] == newLines[j] {
				dp[i][j] = dp[i+1][j+1] + 1
			} else if dp[i+1][j] >= dp[i][j+1] {
				dp[i][j] = dp[i+1][j]
			} else {
				dp[i][j] = dp[i][j+1]
			}
		}
	}

	result := make([]AssetDiffLine, 0, n+m)
	i, j := 0, 0
	for i < n && j < m {
		if oldLines[i] == newLines[j] {
			result = append(result, AssetDiffLine{Type: "context", Text: oldLines[i], OldLine: i + 1, NewLine: j + 1})
			i++
			j++
			continue
		}
		if dp[i+1][j] >= dp[i][j+1] {
			result = append(result, AssetDiffLine{Type: "remove", Text: oldLines[i], OldLine: i + 1})
			i++
		} else {
			result = append(result, AssetDiffLine{Type: "add", Text: newLines[j], NewLine: j + 1})
			j++
		}
	}
	for ; i < n; i++ {
		result = append(result, AssetDiffLine{Type: "remove", Text: oldLines[i], OldLine: i + 1})
	}
	for ; j < m; j++ {
		result = append(result, AssetDiffLine{Type: "add", Text: newLines[j], NewLine: j + 1})
	}
	return result
}

func splitLines(s string) []string {
	if s == "" {
		return []string{}
	}
	return strings.Split(strings.TrimSuffix(s, "\n"), "\n")
}
