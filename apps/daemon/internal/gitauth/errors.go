package gitauth

import "fmt"

// AuthRequiredError signalizuje, že git operace selhala kvůli chybějícím nebo
// neplatným credentials. Daemon ho mapuje na HTTP 401 s code "git_auth_required".
type AuthRequiredError struct {
	Host    string
	URL     string
	Message string
}

func (e *AuthRequiredError) Error() string {
	if e.Host != "" {
		return fmt.Sprintf("git autentizace selhala pro host %s: %s", e.Host, e.Message)
	}
	return fmt.Sprintf("git autentizace selhala: %s", e.Message)
}

// IsAuthRequired vrátí true, pokud err je *AuthRequiredError.
func IsAuthRequired(err error) bool {
	_, ok := err.(*AuthRequiredError)
	return ok
}

// NetworkError signalizuje síťovou chybu (DNS, timeout, connection refused).
// Není to auth problém — retry s tokenem nepomůže.
type NetworkError struct {
	URL     string
	Message string
}

func (e *NetworkError) Error() string {
	return fmt.Sprintf("síťová chyba při git operaci na %s: %s", e.URL, e.Message)
}

// NotFoundError signalizuje, že repo neexistuje nebo není dostupné. Stejně
// jako NetworkError — retry s tokenem nepomůže.
type NotFoundError struct {
	URL     string
	Message string
}

func (e *NotFoundError) Error() string {
	return fmt.Sprintf("git repo nenalezeno na %s: %s", e.URL, e.Message)
}
