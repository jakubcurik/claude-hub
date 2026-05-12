package telemetry

// Tento balíček implementuje subset OpenTelemetry OTLP/HTTP-JSON protokolu nutný
// pro příjem metrik a logů z Claude Code. Plné OTel SDK je pro náš případ
// zbytečný balast — potřebujeme jen parsovat protobuf-shaped JSON a forwardovat
// dále. Datové struktury kopírují OpenTelemetry Protocol v1.

// OtlpMetricsRequest odpovídá `ExportMetricsServiceRequest` z OTLP.
type OtlpMetricsRequest struct {
	ResourceMetrics []ResourceMetrics `json:"resourceMetrics"`
}

type ResourceMetrics struct {
	Resource     Resource       `json:"resource"`
	ScopeMetrics []ScopeMetrics `json:"scopeMetrics"`
}

type ScopeMetrics struct {
	Scope   Scope    `json:"scope"`
	Metrics []Metric `json:"metrics"`
}

type Metric struct {
	Name string `json:"name"`
	Unit string `json:"unit"`
	Sum  *Sum   `json:"sum,omitempty"`
	// Gauge a Histogram zatím nezpracováváme — Claude Code emituje sumy.
}

type Sum struct {
	DataPoints             []NumberDataPoint `json:"dataPoints"`
	AggregationTemporality int               `json:"aggregationTemporality"`
	IsMonotonic            bool              `json:"isMonotonic"`
}

type NumberDataPoint struct {
	Attributes        []KeyValue `json:"attributes"`
	StartTimeUnixNano string     `json:"startTimeUnixNano"`
	TimeUnixNano      string     `json:"timeUnixNano"`
	AsInt             *string    `json:"asInt,omitempty"`
	AsDouble          *float64   `json:"asDouble,omitempty"`
}

// OtlpLogsRequest odpovídá `ExportLogsServiceRequest` z OTLP.
type OtlpLogsRequest struct {
	ResourceLogs []ResourceLogs `json:"resourceLogs"`
}

type ResourceLogs struct {
	Resource  Resource    `json:"resource"`
	ScopeLogs []ScopeLogs `json:"scopeLogs"`
}

type ScopeLogs struct {
	Scope      Scope       `json:"scope"`
	LogRecords []LogRecord `json:"logRecords"`
}

type LogRecord struct {
	TimeUnixNano string     `json:"timeUnixNano"`
	SeverityText string     `json:"severityText"`
	Body         AnyValue   `json:"body"`
	Attributes   []KeyValue `json:"attributes"`
	EventName    string     `json:"eventName,omitempty"`
}

type Resource struct {
	Attributes []KeyValue `json:"attributes"`
}

type Scope struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

type KeyValue struct {
	Key   string   `json:"key"`
	Value AnyValue `json:"value"`
}

// AnyValue je tagged union — z JSON přijde právě jedna varianta. OTLP-JSON
// kóduje int64 jako string (JSON čísla mají max 2^53), proto IntValue je *string.
type AnyValue struct {
	StringValue *string  `json:"stringValue,omitempty"`
	IntValue    *string  `json:"intValue,omitempty"`
	DoubleValue *float64 `json:"doubleValue,omitempty"`
	BoolValue   *bool    `json:"boolValue,omitempty"`
}

// NormalizedMetric je plochá interní reprezentace, kterou forwarder posílá do API.
type NormalizedMetric struct {
	Name        string            `json:"name"`
	Value       float64           `json:"value"`
	TimestampMs int64             `json:"timestampMs"`
	Attributes  map[string]string `json:"attributes"`
	Resource    map[string]string `json:"resource"`
}

type NormalizedEvent struct {
	Name        string            `json:"name"`
	TimestampMs int64             `json:"timestampMs"`
	Attributes  map[string]string `json:"attributes"`
	Resource    map[string]string `json:"resource"`
}

// BufferItem je jednotka serializovaná v JSONL bufferu.
type BufferItem struct {
	Kind   string            `json:"kind"`
	Metric *NormalizedMetric `json:"metric,omitempty"`
	Event  *NormalizedEvent  `json:"event,omitempty"`
}
