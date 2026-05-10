// SPDX-License-Identifier: Apache-2.0
package local

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/animato/claude-hub/agent/internal/jobs"
)

type stubPub struct{ called bool }

func (s *stubPub) Publish(req jobs.PublishRequest) (*jobs.PublishResult, error) {
	s.called = true
	return &jobs.PublishResult{ArtifactID: "a-1", VersionID: "v-1"}, nil
}

func TestPublishHandler_Authorized(t *testing.T) {
	p := &stubPub{}
	h := PublishHandler(p, "tok-abc")
	body, _ := json.Marshal(map[string]string{
		"slug":        "foo",
		"type":        "skill",
		"version":     "0.1.0",
		"description": "d",
		"source_path": "/x",
	})
	req := httptest.NewRequest("POST", "/v1/publish", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer tok-abc")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("status %d body %s", w.Code, w.Body.String())
	}
	var got map[string]string
	_ = json.Unmarshal(w.Body.Bytes(), &got)
	if got["artifactId"] != "a-1" {
		t.Fatalf("body: %+v", got)
	}
	if !p.called {
		t.Fatal("publisher not invoked")
	}
}

func TestPublishHandler_BadToken(t *testing.T) {
	h := PublishHandler(&stubPub{}, "tok-abc")
	req := httptest.NewRequest("POST", "/v1/publish", bytes.NewReader([]byte("{}")))
	req.Header.Set("Authorization", "Bearer wrong")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
}

func TestPublishHandler_RejectNonSkillType(t *testing.T) {
	h := PublishHandler(&stubPub{}, "tok-abc")
	body, _ := json.Marshal(map[string]string{
		"slug":        "p",
		"type":        "plugin",
		"version":     "0.1.0",
		"description": "d",
		"source_path": "/x",
	})
	req := httptest.NewRequest("POST", "/v1/publish", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer tok-abc")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}
