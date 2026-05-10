// SPDX-License-Identifier: Apache-2.0
package wss

import (
	"errors"
	"testing"
)

type fakeSender struct{ sent []map[string]any }

func (f *fakeSender) Send(msgType string, payload map[string]any) error {
	f.sent = append(f.sent, map[string]any{"type": msgType, "payload": payload})
	return nil
}

type fakeJobs struct {
	installErr error
	pubResult  map[string]any
	pubErr     error
}

func (j *fakeJobs) RunInstall(payload map[string]any) error {
	return j.installErr
}

func (j *fakeJobs) RunPackage(payload map[string]any) (map[string]any, error) {
	return j.pubResult, j.pubErr
}

func TestJobRouter_PingResponds(t *testing.T) {
	snd := &fakeSender{}
	r := NewJobRouter(snd, &fakeJobs{})
	r.Handle([]byte(`{"type":"ping","id":"1","payload":{}}`))
	if len(snd.sent) != 1 || snd.sent[0]["type"] != "pong" {
		t.Fatalf("expected pong, got %+v", snd.sent)
	}
}

func TestJobRouter_JobInstallSuccess(t *testing.T) {
	snd := &fakeSender{}
	r := NewJobRouter(snd, &fakeJobs{})
	r.Handle([]byte(`{"type":"job.install","id":"1","payload":{"requestId":"rq","sha256":"a"}}`))
	r.Wait()
	if len(snd.sent) != 1 {
		t.Fatalf("expected 1 message, got %d", len(snd.sent))
	}
	msg := snd.sent[0]
	if msg["type"] != "job.result" {
		t.Fatalf("type: %v", msg["type"])
	}
	p := msg["payload"].(map[string]any)
	if p["ok"] != true || p["requestId"] != "rq" {
		t.Fatalf("payload: %+v", p)
	}
}

func TestJobRouter_JobInstallFailure(t *testing.T) {
	snd := &fakeSender{}
	r := NewJobRouter(snd, &fakeJobs{installErr: errors.New("boom")})
	r.Handle([]byte(`{"type":"job.install","id":"1","payload":{"requestId":"rq"}}`))
	r.Wait()
	p := snd.sent[0]["payload"].(map[string]any)
	if p["ok"] != false || p["error"] != "boom" {
		t.Fatalf("expected failure, got %+v", p)
	}
}

func TestJobRouter_JobPackage(t *testing.T) {
	snd := &fakeSender{}
	r := NewJobRouter(snd, &fakeJobs{pubResult: map[string]any{"artifactId": "a", "versionId": "v"}})
	r.Handle([]byte(`{"type":"job.package","id":"1","payload":{"requestId":"rq"}}`))
	r.Wait()
	p := snd.sent[0]["payload"].(map[string]any)
	if p["ok"] != true {
		t.Fatalf("expected ok, got %+v", p)
	}
	data := p["data"].(map[string]any)
	if data["artifactId"] != "a" {
		t.Fatalf("data: %+v", data)
	}
}
