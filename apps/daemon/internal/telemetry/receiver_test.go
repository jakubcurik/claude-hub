package telemetry

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
)

func newTestReceiver(t *testing.T) (*Receiver, *Buffer, string) {
	t.Helper()
	dir := t.TempDir()
	buffer, err := NewBuffer(filepath.Join(dir, "queue"))
	if err != nil {
		t.Fatalf("buffer init: %v", err)
	}
	t.Cleanup(func() { _ = buffer.Close() })
	receiver := NewReceiver(buffer, slog.New(slog.NewTextHandler(io.Discard, nil)))
	return receiver, buffer, dir
}

func postOTLP(t *testing.T, handler http.Handler, path string, payload any) *http.Response {
	t.Helper()
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec.Result()
}

func drainItems(t *testing.T, buf *Buffer) []BufferItem {
	t.Helper()
	items, commit, err := buf.DrainBatch(0)
	if err != nil {
		t.Fatalf("drain: %v", err)
	}
	_ = commit()
	return items
}

func strPtr(s string) *string { return &s }

func TestReceiverMetricsHappyPath(t *testing.T) {
	receiver, buffer, _ := newTestReceiver(t)

	value := "1500"
	payload := OtlpMetricsRequest{
		ResourceMetrics: []ResourceMetrics{{
			Resource: Resource{Attributes: []KeyValue{
				{Key: "session.id", Value: AnyValue{StringValue: strPtr("sess-1")}},
				{Key: "user.email", Value: AnyValue{StringValue: strPtr("kuba@animato.cz")}},
				{Key: "cwd", Value: AnyValue{StringValue: strPtr("/home/kuba/projekt")}},
			}},
			ScopeMetrics: []ScopeMetrics{{
				Metrics: []Metric{{
					Name: "claude_code.token.usage",
					Sum: &Sum{
						DataPoints: []NumberDataPoint{{
							TimeUnixNano: "1715000000000000000",
							Attributes: []KeyValue{
								{Key: "type", Value: AnyValue{StringValue: strPtr("input")}},
								{Key: "model", Value: AnyValue{StringValue: strPtr("claude-sonnet-4-6")}},
							},
							AsInt: &value,
						}},
					},
				}},
			}},
		}},
	}

	res := postOTLP(t, receiver.Handler(), "/v1/metrics", payload)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", res.StatusCode)
	}

	items := drainItems(t, buffer)
	if len(items) != 1 {
		t.Fatalf("expected 1 buffered item, got %d", len(items))
	}
	metric := items[0].Metric
	if metric == nil {
		t.Fatalf("expected metric, got %#v", items[0])
	}
	if metric.Name != "claude_code.token.usage" || metric.Value != 1500 {
		t.Fatalf("unexpected metric: %#v", metric)
	}
	if metric.Resource["session.id"] != "sess-1" {
		t.Fatalf("session.id missing from resource: %#v", metric.Resource)
	}
	if metric.Resource["cwd"] != "/home/kuba/projekt" {
		t.Fatalf("cwd missing from resource: %#v", metric.Resource)
	}
	if metric.Attributes["type"] != "input" || metric.Attributes["model"] != "claude-sonnet-4-6" {
		t.Fatalf("unexpected attributes: %#v", metric.Attributes)
	}
}

func TestReceiverFiltersDisallowedMetrics(t *testing.T) {
	receiver, buffer, _ := newTestReceiver(t)

	value := "10"
	payload := OtlpMetricsRequest{
		ResourceMetrics: []ResourceMetrics{{
			ScopeMetrics: []ScopeMetrics{{
				Metrics: []Metric{
					{
						// Není v allowlist — musí být zahozeno.
						Name: "claude_code.lines_of_code.count",
						Sum: &Sum{
							DataPoints: []NumberDataPoint{{
								TimeUnixNano: "1715000000000000000",
								AsInt:        &value,
							}},
						},
					},
					{
						// Je v allowlist.
						Name: "claude_code.session.count",
						Sum: &Sum{
							DataPoints: []NumberDataPoint{{
								TimeUnixNano: "1715000000000000000",
								AsInt:        &value,
							}},
						},
					},
				},
			}},
		}},
	}
	_ = postOTLP(t, receiver.Handler(), "/v1/metrics", payload)

	items := drainItems(t, buffer)
	if len(items) != 1 {
		t.Fatalf("expected 1 item (only allowed metric), got %d", len(items))
	}
	if items[0].Metric.Name != "claude_code.session.count" {
		t.Fatalf("unexpected metric: %#v", items[0].Metric)
	}
}

func TestReceiverRedactsSensitiveAttributes(t *testing.T) {
	receiver, buffer, _ := newTestReceiver(t)

	value := "1.50"
	doubleValue, _ := numberFromString(value)
	payload := OtlpMetricsRequest{
		ResourceMetrics: []ResourceMetrics{{
			Resource: Resource{Attributes: []KeyValue{
				{Key: "prompt", Value: AnyValue{StringValue: strPtr("secret password")}},
				{Key: "user.email", Value: AnyValue{StringValue: strPtr("kuba@animato.cz")}},
			}},
			ScopeMetrics: []ScopeMetrics{{
				Metrics: []Metric{{
					Name: "claude_code.cost.usage",
					Sum: &Sum{
						DataPoints: []NumberDataPoint{{
							TimeUnixNano: "1715000000000000000",
							Attributes: []KeyValue{
								{Key: "model", Value: AnyValue{StringValue: strPtr("claude-opus-4-7")}},
								{Key: "file_path", Value: AnyValue{StringValue: strPtr("/secret/path")}},
							},
							AsDouble: &doubleValue,
						}},
					},
				}},
			}},
		}},
	}
	_ = postOTLP(t, receiver.Handler(), "/v1/metrics", payload)
	items := drainItems(t, buffer)
	if len(items) != 1 {
		t.Fatalf("expected 1 item, got %d", len(items))
	}
	metric := items[0].Metric
	if _, ok := metric.Resource["prompt"]; ok {
		t.Fatalf("sensitive resource attribute prompt was not redacted: %#v", metric.Resource)
	}
	if _, ok := metric.Attributes["file_path"]; ok {
		t.Fatalf("sensitive attribute file_path was not redacted: %#v", metric.Attributes)
	}
	if metric.Resource["user.email"] != "kuba@animato.cz" {
		t.Fatalf("user.email lost during redaction: %#v", metric.Resource)
	}
	if metric.Attributes["model"] != "claude-opus-4-7" {
		t.Fatalf("model lost during redaction: %#v", metric.Attributes)
	}
}

func TestReceiverLogsFilteredAndBodyDropped(t *testing.T) {
	receiver, buffer, _ := newTestReceiver(t)

	payload := OtlpLogsRequest{
		ResourceLogs: []ResourceLogs{{
			ScopeLogs: []ScopeLogs{{
				LogRecords: []LogRecord{
					{
						EventName:    "claude_code.user_prompt",
						TimeUnixNano: "1715000000000000000",
						Body:         AnyValue{StringValue: strPtr("send this to backend please")},
						Attributes: []KeyValue{
							{Key: "prompt_length", Value: AnyValue{IntValue: strPtr("42")}},
						},
					},
					{
						EventName:    "claude_code.skill_activated",
						TimeUnixNano: "1715000000000000000",
						Body:         AnyValue{StringValue: strPtr("ignored body")},
						Attributes: []KeyValue{
							{Key: "skill.name", Value: AnyValue{StringValue: strPtr("git-workflow")}},
							{Key: "invocation_trigger", Value: AnyValue{StringValue: strPtr("user-slash")}},
						},
					},
				},
			}},
		}},
	}
	_ = postOTLP(t, receiver.Handler(), "/v1/logs", payload)

	items := drainItems(t, buffer)
	if len(items) != 1 {
		t.Fatalf("expected 1 event (user_prompt should be dropped), got %d", len(items))
	}
	event := items[0].Event
	if event == nil || event.Name != "claude_code.skill_activated" {
		t.Fatalf("unexpected event: %#v", items[0])
	}
	if event.Attributes["skill.name"] != "git-workflow" {
		t.Fatalf("skill.name lost: %#v", event.Attributes)
	}
}

func TestReceiverMalformedJSONReturns400(t *testing.T) {
	receiver, _, _ := newTestReceiver(t)
	req := httptest.NewRequest(http.MethodPost, "/v1/metrics", bytes.NewReader([]byte("{not json")))
	rec := httptest.NewRecorder()
	receiver.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}
}

func TestReceiverTracesAlwaysOK(t *testing.T) {
	receiver, buffer, _ := newTestReceiver(t)
	req := httptest.NewRequest(http.MethodPost, "/v1/traces", bytes.NewReader([]byte(`{"resourceSpans":[]}`)))
	rec := httptest.NewRecorder()
	receiver.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	items := drainItems(t, buffer)
	if len(items) != 0 {
		t.Fatalf("traces should not have buffered items, got %d", len(items))
	}
}

func numberFromString(s string) (float64, error) {
	var f float64
	err := json.Unmarshal([]byte(s), &f)
	return f, err
}
