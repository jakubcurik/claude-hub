package gitauth

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"strings"
)

// Runner spouští `git` jako subprocess. Klíčový rozdíl proti Claude Code 2.0.67+:
// NIKDY nepoužíváme `-c credential.helper=` (které by zablokovalo credential
// helpery uživatele). Pro non-TTY použití nastavujeme `GIT_TERMINAL_PROMPT=0`,
// aby git nezamrzl na promptu, když mu chybí auth.
type Runner struct {
	GitPath string
	Logger  *slog.Logger
}

// NewRunner vrátí Runner s detekovanou cestou ke git binárce. Vrací error,
// pokud git není v PATH.
func NewRunner(logger *slog.Logger) (*Runner, error) {
	path, err := exec.LookPath("git")
	if err != nil {
		return nil, fmt.Errorf("git binárka nenalezena v PATH: %w", err)
	}
	return &Runner{GitPath: path, Logger: logger}, nil
}

// CloneOptions popisuje, co a kam klonovat.
type CloneOptions struct {
	URL  string
	Dest string
	Ref  string // branch, tag, SHA; prázdné = default branch repositáře
	// AskpassPath: pokud je nastaveno, exportuje se jako GIT_ASKPASS pro tento
	// jeden git call. Auth ladder ho vyplňuje při fallbacku na PAT.
	AskpassPath string
	// Depth: pokud > 0, použij --depth pro shallow clone. 1 = jen HEAD, šetří
	// místo a čas. Marketplace clone má cenu i bez plné historie.
	Depth int
}

// Clone provede `git clone` do CloneOptions.Dest. Vrací typed error
// (*AuthRequiredError, *NotFoundError, *NetworkError) podle stderr klasifikace.
func (r *Runner) Clone(ctx context.Context, opts CloneOptions) error {
	if opts.URL == "" {
		return errors.New("url je prázdná")
	}
	if opts.Dest == "" {
		return errors.New("dest je prázdný")
	}

	args := []string{
		"-c", "advice.detachedHead=false",
		"clone",
	}
	if opts.Depth > 0 {
		args = append(args, "--depth", fmt.Sprintf("%d", opts.Depth))
	}
	if opts.Ref != "" {
		args = append(args, "--branch", opts.Ref)
	}
	args = append(args, "--", opts.URL, opts.Dest)

	cmd := exec.CommandContext(ctx, r.GitPath, args...)
	cmd.Env = r.buildEnv(opts.AskpassPath)
	stderr, err := r.run(cmd)
	if err != nil {
		return classifyGitError(opts.URL, stderr, err)
	}
	return nil
}

// FetchOptions popisuje `git fetch` operaci v existujícím repu.
type FetchOptions struct {
	RepoPath    string
	AskpassPath string
}

// Fetch provede `git fetch origin` v RepoPath.
func (r *Runner) Fetch(ctx context.Context, opts FetchOptions) error {
	if opts.RepoPath == "" {
		return errors.New("repoPath je prázdný")
	}
	cmd := exec.CommandContext(ctx, r.GitPath, "-C", opts.RepoPath, "fetch", "--quiet", "origin")
	cmd.Env = r.buildEnv(opts.AskpassPath)
	stderr, err := r.run(cmd)
	if err != nil {
		return classifyGitError(opts.RepoPath, stderr, err)
	}
	return nil
}

// PullFFOnly provede `git pull --ff-only origin <ref>` v RepoPath. Vrátí error,
// pokud lokální HEAD diverguje od remote (žádné merge ani rebase).
func (r *Runner) PullFFOnly(ctx context.Context, opts FetchOptions) error {
	if opts.RepoPath == "" {
		return errors.New("repoPath je prázdný")
	}
	cmd := exec.CommandContext(ctx, r.GitPath, "-C", opts.RepoPath, "pull", "--ff-only", "--quiet")
	cmd.Env = r.buildEnv(opts.AskpassPath)
	stderr, err := r.run(cmd)
	if err != nil {
		return classifyGitError(opts.RepoPath, stderr, err)
	}
	return nil
}

// HeadSHA vrátí commit SHA HEAD v RepoPath.
func (r *Runner) HeadSHA(ctx context.Context, repoPath string) (string, error) {
	if repoPath == "" {
		return "", errors.New("repoPath je prázdný")
	}
	cmd := exec.CommandContext(ctx, r.GitPath, "-C", repoPath, "rev-parse", "HEAD")
	cmd.Env = r.buildEnv("")
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("git rev-parse HEAD selhal: %w", err)
	}
	return strings.TrimSpace(string(out)), nil
}

// buildEnv staví environment pro git subprocess. Kritická pole:
//   - GIT_TERMINAL_PROMPT=0 — git nezamrzne na interaktivním promptu
//   - GIT_ASKPASS=<path> — pokud máme PAT, git ho vezme jako username/password
//   - LANG=C — předvídatelné error messages pro klasifikaci
//
// Inheritujeme zbytek od daemonu (PATH, HOME pro SSH, SSH_AUTH_SOCK pro agent),
// takže Vrstva 1 (SSH agent, system credential helper, gh/glab CLI) projde.
func (r *Runner) buildEnv(askpassPath string) []string {
	env := append([]string(nil), os.Environ()...)
	env = append(env, "GIT_TERMINAL_PROMPT=0")
	env = append(env, "LANG=C")
	if askpassPath != "" {
		env = append(env, "GIT_ASKPASS="+askpassPath)
		// SSH_ASKPASS taky — kdyby clone přes ssh:// volal ssh prompt na passphrase.
		// V naší architektuře používáme askpass jen pro HTTPS, ale defense-in-depth.
		env = append(env, "SSH_ASKPASS="+askpassPath)
		env = append(env, "DISPLAY=:0") // SSH_ASKPASS vyžaduje neprázdný DISPLAY
	}
	return env
}

// run spustí git, zachytí stdout+stderr (kvůli error klasifikaci) a redaktuje
// případný token v error textu.
func (r *Runner) run(cmd *exec.Cmd) (string, error) {
	var stderr strings.Builder
	cmd.Stderr = &stderr
	cmd.Stdout = nil // nikomu nezáleží na stdout `git clone --quiet`
	err := cmd.Run()
	stderrStr := Redact(stderr.String())
	if r.Logger != nil && err != nil {
		r.Logger.Debug("git command failed",
			"args", redactArgs(cmd.Args),
			"stderr_preview", truncate(stderrStr, 500))
	}
	return stderrStr, err
}

// redactArgs odstraní embedded tokeny z URL argumentů — git může logovat URL
// s basic auth do error logu.
func redactArgs(args []string) []string {
	out := make([]string, len(args))
	for i, a := range args {
		out[i] = Redact(a)
	}
	return out
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "..."
}

// classifyGitError dělá nejlepší možnou klasifikaci git error textu na typed
// error. Stderr je už redactovaný (Redact()).
//
// Pattern matching na stderr je křehký, ale neexistuje strukturovaný git error
// format. LANG=C zaručuje anglické zprávy.
func classifyGitError(target, stderr string, err error) error {
	lower := strings.ToLower(stderr)

	authPhrases := []string{
		"authentication failed",
		"could not read username",
		"could not read password",
		"remote: http basic",
		"remote: invalid username or password",
		"403 forbidden",
		"401 unauthorized",
		"permission denied (publickey)",
		"fatal: authentication failed",
		"terminal prompts disabled",
	}
	for _, phrase := range authPhrases {
		if strings.Contains(lower, phrase) {
			return &AuthRequiredError{URL: target, Message: firstLine(stderr)}
		}
	}

	notFoundPhrases := []string{
		"repository not found",
		"could not find remote ref",
		"remote branch ", // typicky "remote branch X not found"
		"404 not found",
	}
	for _, phrase := range notFoundPhrases {
		if strings.Contains(lower, phrase) {
			return &NotFoundError{URL: target, Message: firstLine(stderr)}
		}
	}
	// "repository '<url>' not found" — git zobrazuje URL mezi slovy
	if strings.Contains(lower, "repository") && strings.Contains(lower, "not found") {
		return &NotFoundError{URL: target, Message: firstLine(stderr)}
	}

	networkPhrases := []string{
		"could not resolve host",
		"connection refused",
		"network is unreachable",
		"operation timed out",
		"failed to connect",
		"ssl_error",
	}
	for _, phrase := range networkPhrases {
		if strings.Contains(lower, phrase) {
			return &NetworkError{URL: target, Message: firstLine(stderr)}
		}
	}

	// Neklasifikovaný — vrátíme původní s redactovaným kontextem.
	return fmt.Errorf("git operace selhala: %s: %w", firstLine(stderr), err)
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.Index(s, "\n"); i >= 0 {
		return strings.TrimSpace(s[:i])
	}
	return s
}
