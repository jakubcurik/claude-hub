// Build with: go build -o <path> ./testdata/fake_git_main.go
// (build tag "ignore" zajistí, že balík to nepřibalí do běžných buildů)
//go:build ignore

package main

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

// Fake `git` pro auth_test.go. Chování řízené dvěma env proměnnými:
//
//	FAKE_GIT_BEHAVIOR — cesta k souboru, kde jsou řádky "<exit>\t<stderr>".
//	FAKE_GIT_LOG      — cesta k souboru, do něhož se appenduje args každého volání.
//
// Po N-tém volání použije N-tý řádek behavior souboru (1-indexed). Pokud
// behavior soubor nemá tolik řádků, použije poslední.
func main() {
	behaviorPath := os.Getenv("FAKE_GIT_BEHAVIOR")
	logPath := os.Getenv("FAKE_GIT_LOG")

	// Append args do logu (tab-separated argumenty per řádek volání).
	if logPath != "" {
		f, err := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
		if err != nil {
			fmt.Fprintln(os.Stderr, "fake-git: log open:", err)
			os.Exit(99)
		}
		fmt.Fprintln(f, strings.Join(os.Args[1:], "\t"))
		_ = f.Close()
	}

	if behaviorPath == "" {
		os.Exit(0)
	}

	// Zjisti pořadí volání (= počet řádků v logu).
	callIdx := 1
	if logPath != "" {
		raw, err := os.ReadFile(logPath)
		if err == nil {
			callIdx = strings.Count(string(raw), "\n")
			if callIdx == 0 {
				callIdx = 1
			}
		}
	}

	behavior, err := os.ReadFile(behaviorPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "fake-git: behavior:", err)
		os.Exit(99)
	}
	lines := strings.Split(strings.TrimRight(string(behavior), "\n"), "\n")
	if len(lines) == 0 {
		os.Exit(0)
	}
	idx := callIdx - 1
	if idx >= len(lines) {
		idx = len(lines) - 1
	}
	parts := strings.SplitN(lines[idx], "\t", 2)
	exitCode := 0
	if v, err := strconv.Atoi(parts[0]); err == nil {
		exitCode = v
	}
	if len(parts) > 1 && parts[1] != "" {
		// \n v behavior pseudo-escape — reálné newlines
		stderr := strings.ReplaceAll(parts[1], `\n`, "\n")
		fmt.Fprintln(os.Stderr, stderr)
	}
	os.Exit(exitCode)
}
