// SPDX-License-Identifier: Apache-2.0
package jobs

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/animato/claude-hub/agent/internal/api"
	"github.com/animato/claude-hub/agent/internal/manifest"
)

func TestPublish_SendsExpectedMultipart(t *testing.T) {
	src := t.TempDir()
	if err := os.WriteFile(
		filepath.Join(src, "SKILL.md"),
		[]byte("---\nname: foo\ndescription: d\n---\n"),
		0o644,
	); err != nil {
		t.Fatal(err)
	}

	var gotForm map[string]string
	var gotFile []byte
	mux := http.NewServeMux()
	mux.HandleFunc("/api/artifacts/upload", func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer dev-tok" {
			t.Errorf("auth: %s", got)
		}
		if err := r.ParseMultipartForm(32 << 20); err != nil {
			t.Fatal(err)
		}
		gotForm = map[string]string{}
		for k := range r.MultipartForm.Value {
			gotForm[k] = r.FormValue(k)
		}
		f, _, err := r.FormFile("file")
		if err != nil {
			t.Fatal(err)
		}
		gotFile, _ = io.ReadAll(f)
		w.WriteHeader(201)
		_, _ = w.Write([]byte(`{"artifactId":"a-1","versionId":"v-1"}`))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	j := &Jobs{
		HubURL:      srv.URL,
		DeviceToken: "dev-tok",
		HTTPClient:  srv.Client(),
		Parsers: map[api.ArtifactType]manifest.Parser{
			api.ArtifactSkill: manifest.SkillParser{},
		},
	}
	res, err := j.Publish(PublishRequest{
		Slug:        "foo",
		Type:        "skill",
		Version:     "0.1.0",
		Description: "d",
		SourcePath:  src,
	})
	if err != nil {
		t.Fatalf("publish err: %v", err)
	}
	if res.ArtifactID != "a-1" || res.VersionID != "v-1" {
		t.Fatalf("unexpected result: %+v", res)
	}
	if gotForm["slug"] != "foo" || gotForm["type"] != "skill" || gotForm["version"] != "0.1.0" {
		t.Fatalf("form: %+v", gotForm)
	}
	if len(gotForm["sha256"]) != 64 {
		t.Fatalf("sha length: %d", len(gotForm["sha256"]))
	}
	if len(gotFile) == 0 {
		t.Fatal("empty file")
	}
	var m struct{ Name, Type, Description string }
	if err := json.Unmarshal([]byte(gotForm["manifest"]), &m); err != nil {
		t.Fatalf("manifest json: %v", err)
	}
	if m.Name != "foo" || m.Type != "skill" {
		t.Fatalf("manifest: %+v", m)
	}
}
