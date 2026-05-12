package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/claude-hub/claude-hub/apps/daemon/internal/claudecode"
	"github.com/claude-hub/claude-hub/apps/daemon/internal/server"
)

func main() {
	var (
		hostFlag       = flag.String("host", envOrDefault("CLAUDE_HUB_DAEMON_HOST", "127.0.0.1"), "host to bind")
		portFlag       = flag.String("port", envOrDefault("CLAUDE_HUB_DAEMON_PORT", "17373"), "port to bind")
		claudeHomeFlag = flag.String("claude-home", os.Getenv("CLAUDE_HOME"), "Claude home directory")
	)
	flag.Parse()

	logger := slog.New(slog.NewTextHandler(os.Stdout, nil))
	claudeHome, err := claudecode.ResolveClaudeHome(*claudeHomeFlag)
	if err != nil {
		logger.Error("failed to resolve Claude home", "error", err)
		os.Exit(1)
	}

	manager := claudecode.NewManager(claudeHome)
	token, tokenPath, err := manager.Token()
	if err != nil {
		logger.Error("failed to create pairing token", "error", err)
		os.Exit(1)
	}

	address := fmt.Sprintf("%s:%s", *hostFlag, *portFlag)
	httpServer := &http.Server{
		Addr:              address,
		Handler:           server.New(manager, token, logger).Handler(),
		ReadHeaderTimeout: 5 * time.Second,
	}

	go func() {
		logger.Info("Claude Hub daemon listening", "address", "http://"+address)
		logger.Info("Claude home", "path", claudeHome)
		logger.Info("Pairing token", "token", token)
		logger.Info("Token file", "path", tokenPath)
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Error("daemon stopped unexpectedly", "error", err)
			os.Exit(1)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := httpServer.Shutdown(ctx); err != nil {
		logger.Error("failed to stop daemon cleanly", "error", err)
		os.Exit(1)
	}
	logger.Info("Claude Hub daemon stopped")
}

func envOrDefault(name string, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
