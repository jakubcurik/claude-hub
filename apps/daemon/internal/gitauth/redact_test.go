package gitauth

import "testing"

func TestRedact_BasicAuthURL(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{
			name: "x-access-token in URL",
			in:   "fatal: unable to access 'https://x-access-token:ghp_secret123@github.com/owner/repo.git/'",
			want: "fatal: unable to access 'https://x-access-token:[REDACTED]@github.com/owner/repo.git/'",
		},
		{
			name: "oauth2 PAT",
			in:   "Cloning into '/tmp/x'... fatal: ... https://oauth2:glpat_abc@gitlab.com/foo.git",
			want: "Cloning into '/tmp/x'... fatal: ... https://oauth2:[REDACTED]@gitlab.com/foo.git",
		},
		{
			name: "no token in url",
			in:   "fatal: repository not found at https://github.com/owner/missing.git",
			want: "fatal: repository not found at https://github.com/owner/missing.git",
		},
		{
			name: "multiple URLs",
			in:   "first https://u1:t1@host1.com/r second https://u2:t2@host2.com/r",
			want: "first https://u1:[REDACTED]@host1.com/r second https://u2:[REDACTED]@host2.com/r",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := Redact(tc.in)
			if got != tc.want {
				t.Errorf("Redact:\n got: %s\nwant: %s", got, tc.want)
			}
		})
	}
}
