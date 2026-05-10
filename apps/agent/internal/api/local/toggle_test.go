// SPDX-License-Identifier: Apache-2.0
package local

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"testing"
)

type stubRegistry struct{ items map[string]string } // artifactId -> type

func (s *stubRegistry) FindByArtifactID(id string) (string, bool) {
	t, ok := s.items[id]
	return t, ok
}

func TestToggleHandler_SkillReturns400(t *testing.T) {
	reg := &stubRegistry{items: map[string]string{"a-1": "skill"}}
	h := ToggleHandler(reg, "tok")
	body, _ := json.Marshal(map[string]any{"artifact_id": "a-1", "enabled": false})
	req := httptest.NewRequest("POST", "/v1/toggle", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer tok")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 400 {
		t.Fatalf("expected 400, got %d", w.Code)
	}
	var resp map[string]string
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["error"] != "skills don't support toggle in MVP" {
		t.Fatalf("error msg: %+v", resp)
	}
}

func TestToggleHandler_NotFound(t *testing.T) {
	reg := &stubRegistry{items: map[string]string{}}
	h := ToggleHandler(reg, "tok")
	body, _ := json.Marshal(map[string]any{"artifact_id": "missing", "enabled": true})
	req := httptest.NewRequest("POST", "/v1/toggle", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer tok")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 404 {
		t.Fatalf("expected 404, got %d", w.Code)
	}
}

func TestToggleHandler_NonSkillTypeNotSupportedYet(t *testing.T) {
	reg := &stubRegistry{items: map[string]string{"p-1": "plugin"}}
	h := ToggleHandler(reg, "tok")
	body, _ := json.Marshal(map[string]any{"artifact_id": "p-1", "enabled": true})
	req := httptest.NewRequest("POST", "/v1/toggle", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer tok")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 501 {
		t.Fatalf("expected 501, got %d", w.Code)
	}
}
