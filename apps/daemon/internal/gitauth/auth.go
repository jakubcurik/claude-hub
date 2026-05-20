package gitauth

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
)

// AuthMethod popisuje, jak skončila autentizace v ladderu.
type AuthMethod string

const (
	// AuthMethodSystem znamená "Vrstva 1": git clone prošlo bez explicitních
	// credentials — uživatel má SSH agent, gh/glab CLI, nebo system credential
	// helper.
	AuthMethodSystem AuthMethod = "system"

	// AuthMethodKeyringPAT znamená "Vrstva 2": Vrstva 1 selhala na auth, daemon
	// natáhl PAT z OS keychainu a předal git přes GIT_ASKPASS.
	AuthMethodKeyringPAT AuthMethod = "keyring-pat"

	// AuthMethodNone znamená, že auth nebyl třeba (cache/local operace).
	AuthMethodNone AuthMethod = "none"
)

// Result obsahuje výsledek auth ladder operace.
type Result struct {
	AuthMethod AuthMethod
	HeadSHA    string // pro Clone vyplněno; pro Fetch/Pull zachycen po operaci
}

// Ladder orchestruje tří-vrstvý auth fallback pro git operace.
//
// Vrstva 1: Plain git call. Předpokládá, že user má systém-level credential
// (SSH agent, credential helper, gh auth). Pokud projde, končíme.
//
// Vrstva 2: Pokud Vrstva 1 selhala s *AuthRequiredError, daemon natáhne PAT z
// keychainu pro daný host a zopakuje git call s GIT_ASKPASS. Pokud PAT v
// keychainu není, vrátí *AuthRequiredError nahoru → server mapuje na HTTP 401.
//
// Vrstva 3: Pro veřejné repos žádné creds netřeba — to je Vrstva 1 success.
type Ladder struct {
	Runner  *Runner
	Keyring KeyringStore
	Logger  *slog.Logger
}

// NewLadder vytvoří Ladder s OS keychainem. Pro testy injektujte vlastní
// KeyringStore přes přímou strukturní inicializaci.
func NewLadder(runner *Runner, logger *slog.Logger) *Ladder {
	return &Ladder{
		Runner:  runner,
		Keyring: NewOSKeyring(),
		Logger:  logger,
	}
}

// Clone provede klon přes auth ladder. Vrací Result se zvolenou AuthMethod a
// HEAD SHA naklonovaného repa, nebo typed error.
func (l *Ladder) Clone(ctx context.Context, opts CloneOptions) (Result, error) {
	if l.Runner == nil {
		return Result{}, errors.New("ladder nemá Runner")
	}

	// Vrstva 1: plain clone.
	err := l.Runner.Clone(ctx, opts)
	if err == nil {
		sha, _ := l.Runner.HeadSHA(ctx, opts.Dest)
		return Result{AuthMethod: AuthMethodSystem, HeadSHA: sha}, nil
	}

	// Pokud to není auth chyba, vrátíme jak je (Network, NotFound, ostatní).
	if !IsAuthRequired(err) {
		return Result{}, err
	}

	// Vrstva 2: PAT z keychainu.
	host, hostErr := HostFromURL(opts.URL)
	if hostErr != nil {
		return Result{}, &AuthRequiredError{URL: opts.URL, Message: "hostname nelze extrahovat: " + hostErr.Error()}
	}
	token, kerr := l.Keyring.Get(host)
	if kerr != nil {
		if errors.Is(kerr, ErrKeyringMiss) {
			return Result{}, &AuthRequiredError{URL: opts.URL, Host: host, Message: "v keychainu chybí PAT"}
		}
		return Result{}, fmt.Errorf("čtení tokenu z keychainu: %w", kerr)
	}

	askpass, cleanup, askErr := WriteAskpassScript(token)
	if askErr != nil {
		return Result{}, fmt.Errorf("askpass: %w", askErr)
	}
	defer cleanup()

	if l.Logger != nil {
		l.Logger.Info("git clone retrying with keychain PAT", "host", host)
	}

	retryOpts := opts
	retryOpts.AskpassPath = askpass

	// Před retry smaž případně vzniklou částečnou složku — jinak `git clone`
	// odmítne s "destination path already exists".
	if err := removeIfExists(opts.Dest); err != nil {
		return Result{}, fmt.Errorf("nelze odklidit částečný clone: %w", err)
	}

	if err := l.Runner.Clone(ctx, retryOpts); err != nil {
		if IsAuthRequired(err) {
			// Token v keychainu byl, ale neprošel — možná expiroval. UI by si
			// měl říct uživateli "zkontroluj PAT".
			return Result{}, &AuthRequiredError{
				URL:     opts.URL,
				Host:    host,
				Message: "PAT z keychainu selhal — pravděpodobně expiroval nebo má špatný scope",
			}
		}
		return Result{}, err
	}
	sha, _ := l.Runner.HeadSHA(ctx, opts.Dest)
	return Result{AuthMethod: AuthMethodKeyringPAT, HeadSHA: sha}, nil
}

// Pull provede `git pull --ff-only` přes auth ladder.
func (l *Ladder) Pull(ctx context.Context, repoPath, remoteURL string) (Result, error) {
	if l.Runner == nil {
		return Result{}, errors.New("ladder nemá Runner")
	}

	// Vrstva 1: plain pull.
	err := l.Runner.PullFFOnly(ctx, FetchOptions{RepoPath: repoPath})
	if err == nil {
		sha, _ := l.Runner.HeadSHA(ctx, repoPath)
		return Result{AuthMethod: AuthMethodSystem, HeadSHA: sha}, nil
	}
	if !IsAuthRequired(err) {
		return Result{}, err
	}

	// Vrstva 2.
	host, hostErr := HostFromURL(remoteURL)
	if hostErr != nil {
		return Result{}, &AuthRequiredError{URL: remoteURL, Message: hostErr.Error()}
	}
	token, kerr := l.Keyring.Get(host)
	if kerr != nil {
		if errors.Is(kerr, ErrKeyringMiss) {
			return Result{}, &AuthRequiredError{URL: remoteURL, Host: host, Message: "v keychainu chybí PAT"}
		}
		return Result{}, fmt.Errorf("čtení tokenu z keychainu: %w", kerr)
	}
	askpass, cleanup, askErr := WriteAskpassScript(token)
	if askErr != nil {
		return Result{}, fmt.Errorf("askpass: %w", askErr)
	}
	defer cleanup()

	if err := l.Runner.PullFFOnly(ctx, FetchOptions{RepoPath: repoPath, AskpassPath: askpass}); err != nil {
		return Result{}, err
	}
	sha, _ := l.Runner.HeadSHA(ctx, repoPath)
	return Result{AuthMethod: AuthMethodKeyringPAT, HeadSHA: sha}, nil
}

func removeIfExists(path string) error {
	err := os.RemoveAll(path)
	if err == nil || errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}
