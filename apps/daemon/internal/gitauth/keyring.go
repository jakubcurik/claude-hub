package gitauth

import (
	"errors"
	"fmt"
	"net/url"
	"strings"

	"github.com/zalando/go-keyring"
)

// KeyringStore abstrakce nad OS keychainem. V testech mockujeme přes
// in-memory implementaci, v produkci přes go-keyring.
type KeyringStore interface {
	Get(host string) (string, error)
	Set(host, token string) error
	Delete(host string) error
}

// keyringService je jméno služby používané v OS keychainu.
// macOS Keychain: Service field
// Windows Credential Manager: Target Name prefix
// libsecret: collection attribute "service"
const keyringService = "claude-hub-daemon"

// keyringAccountPrefix je prefix pro account/username field.
// Výsledný account je "git-pat:<host>", např. "git-pat:github.com".
const keyringAccountPrefix = "git-pat:"

// ErrKeyringMiss vrátí KeyringStore.Get, pokud token pro daný host neexistuje.
var ErrKeyringMiss = errors.New("token v keychainu neexistuje")

// OSKeyring implementuje KeyringStore přes systémový OS keychain.
//
// Windows: Credential Manager (přes danieljoos/wincred)
// macOS: Keychain Services
// Linux: libsecret / gnome-keyring přes D-Bus
type OSKeyring struct{}

// NewOSKeyring vrátí KeyringStore napojený na OS keychain.
func NewOSKeyring() *OSKeyring {
	return &OSKeyring{}
}

func keyringAccount(host string) string {
	return keyringAccountPrefix + strings.ToLower(host)
}

func (k *OSKeyring) Get(host string) (string, error) {
	if host == "" {
		return "", errors.New("host je prázdný")
	}
	token, err := keyring.Get(keyringService, keyringAccount(host))
	if err != nil {
		if errors.Is(err, keyring.ErrNotFound) {
			return "", ErrKeyringMiss
		}
		return "", fmt.Errorf("čtení tokenu z keychainu selhalo: %w", err)
	}
	return token, nil
}

func (k *OSKeyring) Set(host, token string) error {
	if host == "" {
		return errors.New("host je prázdný")
	}
	if token == "" {
		return errors.New("token je prázdný")
	}
	if err := keyring.Set(keyringService, keyringAccount(host), token); err != nil {
		return fmt.Errorf("zápis tokenu do keychainu selhal: %w", err)
	}
	return nil
}

func (k *OSKeyring) Delete(host string) error {
	if host == "" {
		return errors.New("host je prázdný")
	}
	if err := keyring.Delete(keyringService, keyringAccount(host)); err != nil {
		if errors.Is(err, keyring.ErrNotFound) {
			return nil
		}
		return fmt.Errorf("smazání tokenu z keychainu selhalo: %w", err)
	}
	return nil
}

// HostFromURL extrahuje hostname z git URL. Pro SSH (`git@github.com:owner/repo`)
// vrací "github.com". Pro HTTPS (`https://github.com/owner/repo.git`) totéž.
func HostFromURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", errors.New("url je prázdná")
	}

	// SSH zkrácený tvar: git@host:path
	if strings.HasPrefix(raw, "git@") || strings.Contains(raw, "@") && !strings.Contains(raw, "://") {
		at := strings.Index(raw, "@")
		colon := strings.Index(raw[at:], ":")
		if at >= 0 && colon > 0 {
			return strings.ToLower(raw[at+1 : at+colon]), nil
		}
	}

	parsed, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("nelze parsovat url: %w", err)
	}
	host := parsed.Hostname()
	if host == "" {
		return "", fmt.Errorf("url %q nemá hostname", raw)
	}
	return strings.ToLower(host), nil
}

// MemoryKeyring je in-memory implementace pro testy.
type MemoryKeyring struct {
	store map[string]string
}

func NewMemoryKeyring() *MemoryKeyring {
	return &MemoryKeyring{store: map[string]string{}}
}

func (m *MemoryKeyring) Get(host string) (string, error) {
	v, ok := m.store[strings.ToLower(host)]
	if !ok {
		return "", ErrKeyringMiss
	}
	return v, nil
}

func (m *MemoryKeyring) Set(host, token string) error {
	m.store[strings.ToLower(host)] = token
	return nil
}

func (m *MemoryKeyring) Delete(host string) error {
	delete(m.store, strings.ToLower(host))
	return nil
}
