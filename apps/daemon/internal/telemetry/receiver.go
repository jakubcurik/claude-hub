package telemetry

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"time"
)

// Receiver vystavuje OTLP/HTTP-JSON endpointy, parsuje payloady, filtruje
// metriky/eventy přes whitelist a zapisuje normalizovaná data do bufferu.
type Receiver struct {
	buffer *Buffer
	logger *slog.Logger
	mux    *http.ServeMux
}

func NewReceiver(buffer *Buffer, logger *slog.Logger) *Receiver {
	r := &Receiver{
		buffer: buffer,
		logger: logger,
		mux:    http.NewServeMux(),
	}
	r.mux.HandleFunc("POST /v1/metrics", r.handleMetrics)
	r.mux.HandleFunc("POST /v1/logs", r.handleLogs)
	r.mux.HandleFunc("POST /v1/traces", r.handleTracesDrop)
	r.mux.HandleFunc("GET /healthz", r.handleHealth)
	return r
}

func (r *Receiver) Handler() http.Handler {
	return r.mux
}

func (r *Receiver) handleHealth(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"ok":true}`))
}

func (r *Receiver) handleMetrics(w http.ResponseWriter, req *http.Request) {
	defer req.Body.Close()
	var payload OtlpMetricsRequest
	if err := json.NewDecoder(req.Body).Decode(&payload); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	count := 0
	for _, rm := range payload.ResourceMetrics {
		resource := flattenAttributes(rm.Resource.Attributes)
		for _, sm := range rm.ScopeMetrics {
			for _, metric := range sm.Metrics {
				if !isMetricAllowed(metric.Name) {
					continue
				}
				if metric.Sum == nil {
					continue
				}
				for _, dp := range metric.Sum.DataPoints {
					normalized := normalizeDataPoint(metric.Name, resource, dp)
					if normalized == nil {
						continue
					}
					if err := r.buffer.Append(BufferItem{Kind: "metric", Metric: normalized}); err != nil {
						r.logger.Warn("telemetry buffer append failed", "error", err)
						continue
					}
					count++
				}
			}
		}
	}
	r.logger.Debug("telemetry metrics ingested", "count", count)
	writeOTLPSuccess(w)
}

func (r *Receiver) handleLogs(w http.ResponseWriter, req *http.Request) {
	defer req.Body.Close()
	var payload OtlpLogsRequest
	if err := json.NewDecoder(req.Body).Decode(&payload); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	count := 0
	for _, rl := range payload.ResourceLogs {
		resource := flattenAttributes(rl.Resource.Attributes)
		for _, sl := range rl.ScopeLogs {
			for _, record := range sl.LogRecords {
				eventName := record.EventName
				if eventName == "" {
					// Některé verze Claude Code emitují event name jako atribut event.name.
					for _, attr := range record.Attributes {
						if attr.Key == "event.name" && attr.Value.StringValue != nil {
							eventName = *attr.Value.StringValue
							break
						}
					}
				}
				if !isEventAllowed(eventName) {
					continue
				}
				normalized := normalizeLogRecord(eventName, resource, record)
				if normalized == nil {
					continue
				}
				if err := r.buffer.Append(BufferItem{Kind: "event", Event: normalized}); err != nil {
					r.logger.Warn("telemetry buffer append failed", "error", err)
					continue
				}
				count++
			}
		}
	}
	r.logger.Debug("telemetry events ingested", "count", count)
	writeOTLPSuccess(w)
}

func (r *Receiver) handleTracesDrop(w http.ResponseWriter, req *http.Request) {
	// Traces zatím nepoužíváme — vrátíme 200 a payload zahodíme, aby si Claude
	// Code nemyslel, že má retry-ovat. Stream necháme nahltnout, aby spojení
	// nezůstalo otevřené.
	_, _ = io.Copy(io.Discard, req.Body)
	_ = req.Body.Close()
	writeOTLPSuccess(w)
}

func writeOTLPSuccess(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(`{}`))
}

// normalizeDataPoint převede OTLP datapoint na náš plochý NormalizedMetric.
func normalizeDataPoint(name string, resource map[string]string, dp NumberDataPoint) *NormalizedMetric {
	value, ok := numberValue(dp)
	if !ok {
		return nil
	}
	attrs := flattenAttributes(dp.Attributes)
	timestamp := parseUnixNanoToMs(dp.TimeUnixNano)
	if timestamp == 0 {
		timestamp = time.Now().UnixMilli()
	}
	return &NormalizedMetric{
		Name:        name,
		Value:       value,
		TimestampMs: timestamp,
		Attributes:  sanitizeAttrs(attrs),
		Resource:    sanitizeAttrs(resource),
	}
}

func normalizeLogRecord(eventName string, resource map[string]string, record LogRecord) *NormalizedEvent {
	attrs := flattenAttributes(record.Attributes)
	timestamp := parseUnixNanoToMs(record.TimeUnixNano)
	if timestamp == 0 {
		timestamp = time.Now().UnixMilli()
	}
	// Body se nikdy neukládá — i s redactem by mohl nést prompty.
	return &NormalizedEvent{
		Name:        eventName,
		TimestampMs: timestamp,
		Attributes:  sanitizeAttrs(attrs),
		Resource:    sanitizeAttrs(resource),
	}
}

func numberValue(dp NumberDataPoint) (float64, bool) {
	if dp.AsDouble != nil {
		return *dp.AsDouble, true
	}
	if dp.AsInt != nil {
		n, err := strconv.ParseInt(*dp.AsInt, 10, 64)
		if err != nil {
			return 0, false
		}
		return float64(n), true
	}
	return 0, false
}

func flattenAttributes(attrs []KeyValue) map[string]string {
	out := make(map[string]string, len(attrs))
	for _, attr := range attrs {
		value, ok := anyValueToString(attr.Value)
		if !ok {
			continue
		}
		out[attr.Key] = value
	}
	return out
}

func anyValueToString(value AnyValue) (string, bool) {
	switch {
	case value.StringValue != nil:
		return *value.StringValue, true
	case value.IntValue != nil:
		return *value.IntValue, true
	case value.DoubleValue != nil:
		return strconv.FormatFloat(*value.DoubleValue, 'f', -1, 64), true
	case value.BoolValue != nil:
		if *value.BoolValue {
			return "true", true
		}
		return "false", true
	}
	return "", false
}

func parseUnixNanoToMs(raw string) int64 {
	if raw == "" {
		return 0
	}
	n, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 0
	}
	return n / int64(time.Millisecond)
}
