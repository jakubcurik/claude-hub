// SPDX-License-Identifier: Apache-2.0
package wss

import (
	"encoding/json"
	"log/slog"
	"sync"
)

type Sender interface {
	Send(msgType string, payload map[string]any) error
}

type JobRunner interface {
	RunInstall(payload map[string]any) error
	RunPackage(payload map[string]any) (map[string]any, error)
}

type JobRouter struct {
	sender Sender
	jobs   JobRunner
	wg     sync.WaitGroup
	queue  chan func()
	once   sync.Once
}

func NewJobRouter(sender Sender, jobs JobRunner) *JobRouter {
	r := &JobRouter{sender: sender, jobs: jobs, queue: make(chan func(), 16)}
	r.once.Do(func() {
		go r.consume()
	})
	return r
}

func (r *JobRouter) consume() {
	for fn := range r.queue {
		fn()
		r.wg.Done()
	}
}

// Wait blocks until all queued jobs have completed.
func (r *JobRouter) Wait() {
	r.wg.Wait()
}

type rawJobMessage struct {
	Type    string          `json:"type"`
	ID      string          `json:"id"`
	Payload json.RawMessage `json:"payload"`
}

// Handle parses a raw WSS frame and dispatches the message. Ping is replied
// synchronously; jobs are enqueued and run on the consumer goroutine.
func (r *JobRouter) Handle(raw []byte) {
	var msg rawJobMessage
	if err := json.Unmarshal(raw, &msg); err != nil {
		slog.Warn("malformed wss message", "err", err)
		return
	}
	var payload map[string]any
	if len(msg.Payload) > 0 {
		_ = json.Unmarshal(msg.Payload, &payload)
	}
	if payload == nil {
		payload = map[string]any{}
	}

	switch msg.Type {
	case "ping":
		if err := r.sender.Send("pong", map[string]any{}); err != nil {
			slog.Warn("failed to send pong", "err", err)
		}
	case "job.install":
		r.wg.Add(1)
		r.queue <- func() {
			requestID, _ := payload["requestId"].(string)
			err := r.jobs.RunInstall(payload)
			r.emitResult(requestID, err, nil)
		}
	case "job.package":
		r.wg.Add(1)
		r.queue <- func() {
			requestID, _ := payload["requestId"].(string)
			data, err := r.jobs.RunPackage(payload)
			r.emitResult(requestID, err, data)
		}
	default:
		slog.Debug("ignoring unknown wss message type", "type", msg.Type)
	}
}

func (r *JobRouter) emitResult(requestID string, err error, data map[string]any) {
	payload := map[string]any{"requestId": requestID, "ok": err == nil}
	if err != nil {
		payload["error"] = err.Error()
	} else if data != nil {
		payload["data"] = data
	}
	if sendErr := r.sender.Send("job.result", payload); sendErr != nil {
		slog.Warn("failed to send job.result", "err", sendErr)
	}
}
