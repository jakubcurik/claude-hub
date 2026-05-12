package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/claude-hub/claude-hub/apps/daemon/internal/claudecode"
	"github.com/claude-hub/claude-hub/apps/daemon/internal/server"
	"github.com/claude-hub/claude-hub/apps/daemon/internal/telemetry"
)

func main() {
	var (
		hostFlag       = flag.String("host", envOrDefault("CLAUDE_HUB_DAEMON_HOST", "127.0.0.1"), "host to bind")
		portFlag       = flag.String("port", envOrDefault("CLAUDE_HUB_DAEMON_PORT", "17373"), "port to bind")
		otlpHostFlag   = flag.String("otlp-host", envOrDefault("CLAUDE_HUB_OTLP_HOST", "127.0.0.1"), "host for OTLP receiver")
		otlpPortFlag   = flag.String("otlp-port", envOrDefault("CLAUDE_HUB_OTLP_PORT", "4318"), "port for OTLP receiver")
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

	// Telemetry buffer + forwarder se startují vždy. Forwarder zůstává nečinný,
	// pokud daemon ještě nezná centrální API endpoint (uloženo přes EnableTelemetry).
	telemetryDir := filepath.Join(manager.HubHome, "telemetry", "queue")
	buffer, err := telemetry.NewBuffer(telemetryDir)
	if err != nil {
		logger.Error("failed to init telemetry buffer", "error", err)
		os.Exit(1)
	}
	defer buffer.Close()

	_, apiEndpoint, _ := manager.LoadTelemetryConfig()
	forwarder := telemetry.NewForwarder(buffer, telemetry.Config{
		APIEndpoint:  apiEndpoint,
		PairingToken: token,
		OnPersistentDisable: func() {
			logger.Info("telemetry disabled by remote — removing local env keys")
			if err := manager.DisableTelemetry(); err != nil {
				logger.Warn("failed to disable telemetry locally", "error", err)
			}
		},
	}, logger)
	receiver := telemetry.NewReceiver(buffer, logger)

	srv := server.New(manager, token, logger, forwarder)
	address := fmt.Sprintf("%s:%s", *hostFlag, *portFlag)
	httpServer := &http.Server{
		Addr:              address,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
	}

	otlpAddress := fmt.Sprintf("%s:%s", *otlpHostFlag, *otlpPortFlag)
	otlpServer := &http.Server{
		Addr:              otlpAddress,
		Handler:           receiver.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
	}

	ctx, cancelForwarder := context.WithCancel(context.Background())
	go forwarder.Run(ctx)

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

	go func() {
		logger.Info("OTLP receiver listening", "address", "http://"+otlpAddress)
		if err := otlpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Error("OTLP receiver stopped unexpectedly", "error", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop

	cancelForwarder()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		logger.Error("failed to stop daemon cleanly", "error", err)
	}
	if err := otlpServer.Shutdown(shutdownCtx); err != nil {
		logger.Error("failed to stop OTLP receiver cleanly", "error", err)
	}
	logger.Info("Claude Hub daemon stopped")
}

func envOrDefault(name string, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
