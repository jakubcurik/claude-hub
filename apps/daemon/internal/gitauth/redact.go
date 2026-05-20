package gitauth

import "regexp"

// tokenInURLPattern matchuje tokeny zapsané přímo v URL (basic auth):
//
//	https://user:token@host/path
//	https://x-access-token:TOKEN@github.com/...
//	https://oauth2:TOKEN@gitlab.com/...
//
// Git je takhle někdy logguje při chybě, což by se nemělo dostat do daemon
// stderr ani manifestů.
var tokenInURLPattern = regexp.MustCompile(`(https?://)([^:/@\s]+):([^@\s]+)@`)

// redactedURLReplacement zachová schema a userinfo část (např. "x-access-token"),
// ale tajnou hodnotu nahradí konstantou. Tím se ani v logu nedozvíme, jak token
// vypadá (délka, prefix), kdyby mezi něj a Hub byl proxy logger.
const redactedURLReplacement = `${1}${2}:[REDACTED]@`

// Redact odstraní embedded tokeny z libovolného textu (typicky git stderr).
// Volej před logem nebo před returnem error message uživateli.
func Redact(text string) string {
	return tokenInURLPattern.ReplaceAllString(text, redactedURLReplacement)
}
