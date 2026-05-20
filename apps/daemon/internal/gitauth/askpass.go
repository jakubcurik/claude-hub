package gitauth

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

// WriteAskpassScript vytvoří dočasný executable, který git zavolá místo
// interaktivního Username/Password promptu (`GIT_ASKPASS`). Skript prostě
// vypíše token na stdout — git ho použije jako password v HTTPS basic auth.
//
// Vrací cestu ke skriptu, cleanup funkci, kterou je nutné zavolat v defer
// (smaže soubor), a případně error.
//
// Permission model:
//   - POSIX: mode 0700 (jen owner read+execute, žádný group/other)
//   - Windows: výchozí ACL temp adresáře omezuje na current user
//
// Skript je v `os.TempDir()` s náhodným prefixem, takže paralelní operace
// si nepřepisují.
func WriteAskpassScript(token string) (path string, cleanup func(), err error) {
	if token == "" {
		return "", nil, fmt.Errorf("token je prázdný")
	}

	dir, err := os.MkdirTemp("", "claude-hub-askpass-*")
	if err != nil {
		return "", nil, fmt.Errorf("nelze vytvořit temp adresář: %w", err)
	}

	var filename, content string
	if runtime.GOOS == "windows" {
		filename = "askpass.cmd"
		// @echo off potlačí echo příkazu samotného, jen vypíše token.
		// Token escapování: cmd.exe interpretuje %, ^, &, |, <, >. Token je
		// stored v souboru, ne v command line, takže žádný shell escape
		// nepotřebujeme. Pokud by token obsahoval CR/LF, git by se zmátl,
		// ale GitHub/GitLab PAT to nemají.
		content = "@echo off\r\necho " + token + "\r\n"
	} else {
		filename = "askpass.sh"
		content = "#!/bin/sh\nprintf '%s\\n' " + shellQuote(token) + "\n"
	}

	scriptPath := filepath.Join(dir, filename)

	mode := os.FileMode(0o700)
	if err := os.WriteFile(scriptPath, []byte(content), mode); err != nil {
		_ = os.RemoveAll(dir)
		return "", nil, fmt.Errorf("nelze zapsat askpass skript: %w", err)
	}

	// Windows ignoruje POSIX permission bits — temp adresář má ACL omezený
	// na current user, takže to stačí.
	cleanup = func() {
		_ = os.RemoveAll(dir)
	}
	return scriptPath, cleanup, nil
}

// shellQuote zabaluje hodnotu do single-quotes pro bezpečné POSIX shell
// předání. Single quotes nepotřebují escape ničeho kromě samotného single quote.
func shellQuote(s string) string {
	out := []byte{'\''}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == '\'' {
			// uzavři quote, dej escaped quote, otevři quote
			out = append(out, '\'', '\\', '\'', '\'')
			continue
		}
		out = append(out, c)
	}
	out = append(out, '\'')
	return string(out)
}
