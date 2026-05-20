package scheduler

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/claude-hub/claude-hub/apps/daemon/internal/claudecode"
)

type fakeManager struct {
	recipes      []claudecode.InstalledRecipe
	updateCalls  []string // AssetIDs whose UpdateRecipeMarketplace was invoked
	updateErr    error
	newSHA       string
	mu           sync.Mutex
}

func (f *fakeManager) ListInstalledRecipes() ([]claudecode.InstalledRecipe, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]claudecode.InstalledRecipe, len(f.recipes))
	copy(out, f.recipes)
	return out, nil
}

func (f *fakeManager) UpdateRecipeMarketplace(_ context.Context, info claudecode.InstalledRecipe) (string, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.updateCalls = append(f.updateCalls, info.AssetID)
	if f.updateErr != nil {
		return "", false, f.updateErr
	}
	changed := f.newSHA != "" && f.newSHA != info.HeadSHA
	return f.newSHA, changed, nil
}

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError}))
}

func TestRunOnce_OnlyAutoUpdateRecipes(t *testing.T) {
	mgr := &fakeManager{
		recipes: []claudecode.InstalledRecipe{
			{AssetID: "asset-A", AutoUpdate: true, HeadSHA: "aaa"},
			{AssetID: "asset-B", AutoUpdate: false, HeadSHA: "bbb"}, // skip
			{AssetID: "asset-C", AutoUpdate: true, HeadSHA: "ccc"},
		},
		newSHA: "newsha",
	}
	s := New(mgr, testLogger())
	s.runOnce(context.Background())

	want := []string{"asset-A", "asset-C"}
	if len(mgr.updateCalls) != len(want) {
		t.Fatalf("update calls = %v, want %v", mgr.updateCalls, want)
	}
	for i, wantID := range want {
		if mgr.updateCalls[i] != wantID {
			t.Errorf("call %d = %q, want %q", i, mgr.updateCalls[i], wantID)
		}
	}
}

func TestRunOnce_ErrorsDontStopIteration(t *testing.T) {
	mgr := &fakeManager{
		recipes: []claudecode.InstalledRecipe{
			{AssetID: "asset-A", AutoUpdate: true},
			{AssetID: "asset-B", AutoUpdate: true},
		},
		updateErr: errors.New("simulated git error"),
	}
	s := New(mgr, testLogger())
	s.runOnce(context.Background())

	if len(mgr.updateCalls) != 2 {
		t.Errorf("expected both recipes attempted, got %v", mgr.updateCalls)
	}
}

func TestRun_StopsOnContextCancel(t *testing.T) {
	mgr := &fakeManager{
		recipes: []claudecode.InstalledRecipe{
			{AssetID: "asset-A", AutoUpdate: true},
		},
	}
	s := New(mgr, testLogger())
	s.SetInterval(10 * time.Millisecond)
	s.SetJitterMax(0)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		s.Run(ctx)
		close(done)
	}()

	// Po krátkém čase cancelem ukončit.
	time.Sleep(50 * time.Millisecond)
	cancel()
	select {
	case <-done:
		// ok
	case <-time.After(2 * time.Second):
		t.Fatal("scheduler nezareagoval na cancel")
	}

	mgr.mu.Lock()
	calls := len(mgr.updateCalls)
	mgr.mu.Unlock()
	if calls == 0 {
		t.Errorf("scheduler nezavolal žádný update — runOnce neproběhl")
	}
}
