// Package scheduler periodicky aktualizuje nainstalované plugin recipes (git
// pull marketplace klonů). Jeden goroutine, time.Ticker s denní periodou plus
// 0-30 min random jitter (spread napříč daemony na téže síti).
package scheduler

import (
	"context"
	"log/slog"
	"math/rand"
	"time"

	"github.com/claude-hub/claude-hub/apps/daemon/internal/claudecode"
)

// Recipes API, který scheduler potřebuje. Manager satisfies — extrahováno do
// rozhraní kvůli testovatelnosti (mock v testech).
type Recipes interface {
	ListInstalledRecipes() ([]claudecode.InstalledRecipe, error)
	UpdateRecipeMarketplace(ctx context.Context, info claudecode.InstalledRecipe) (string, bool, error)
}

// Scheduler řídí periodický auto-update recipes.
type Scheduler struct {
	manager      Recipes
	logger       *slog.Logger
	interval     time.Duration
	jitterMax    time.Duration
	updateCalled func(info claudecode.InstalledRecipe, newSHA string, changed bool, err error) // test hook
}

// New vrátí scheduler s default denní periodou.
func New(manager Recipes, logger *slog.Logger) *Scheduler {
	return &Scheduler{
		manager:   manager,
		logger:    logger,
		interval:  24 * time.Hour,
		jitterMax: 30 * time.Minute,
	}
}

// SetInterval změní periodu mezi auto-update běhy (např. v testech na 100ms).
func (s *Scheduler) SetInterval(d time.Duration) {
	s.interval = d
}

// SetJitterMax změní maximální jitter (default 30 min, v testech 0).
func (s *Scheduler) SetJitterMax(d time.Duration) {
	s.jitterMax = d
}

// Run blokuje, dokud ctx není zrušen. Volá runOnce s periodou interval+jitter.
func (s *Scheduler) Run(ctx context.Context) {
	first := s.jitter()
	timer := time.NewTimer(first)
	defer timer.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			s.runOnce(ctx)
			timer.Reset(s.interval + s.jitter())
		}
	}
}

func (s *Scheduler) jitter() time.Duration {
	if s.jitterMax <= 0 {
		return 0
	}
	return time.Duration(rand.Int63n(int64(s.jitterMax)))
}

// runOnce iteruje všechny recipe s autoUpdate=true a volá pull. Chyby
// jednotlivých recipes nezablokují zbytek — log + pokračovat.
func (s *Scheduler) runOnce(ctx context.Context) {
	recipes, err := s.manager.ListInstalledRecipes()
	if err != nil {
		if s.logger != nil {
			s.logger.Warn("scheduler: nelze načíst recipes", "error", err)
		}
		return
	}
	if s.logger != nil {
		s.logger.Debug("scheduler: kontroluju aktualizace", "count", len(recipes))
	}
	for _, recipe := range recipes {
		if !recipe.AutoUpdate {
			continue
		}
		updateCtx, cancel := context.WithTimeout(ctx, 90*time.Second)
		newSHA, changed, err := s.manager.UpdateRecipeMarketplace(updateCtx, recipe)
		cancel()
		if s.updateCalled != nil {
			s.updateCalled(recipe, newSHA, changed, err)
		}
		if err != nil {
			if s.logger != nil {
				s.logger.Warn("scheduler: auto-update selhal",
					"recipe", recipe.AssetID,
					"marketplace", recipe.MarketplaceName,
					"error", err)
			}
			continue
		}
		if changed && s.logger != nil {
			s.logger.Info("scheduler: marketplace aktualizován",
				"recipe", recipe.AssetID,
				"marketplace", recipe.MarketplaceName,
				"newSHA", shortSHA(newSHA),
				"oldSHA", shortSHA(recipe.HeadSHA))
		}
	}
}

func shortSHA(sha string) string {
	if len(sha) <= 8 {
		return sha
	}
	return sha[:8]
}
