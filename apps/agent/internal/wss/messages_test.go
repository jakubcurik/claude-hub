// SPDX-License-Identifier: Apache-2.0
package wss

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestPingMarshalRoundtrip(t *testing.T) {
	m := Message{Type: "ping", ID: "id-1", Payload: json.RawMessage(`{}`)}
	b, err := json.Marshal(m)
	require.NoError(t, err)

	var got Message
	require.NoError(t, json.Unmarshal(b, &got))
	require.Equal(t, "ping", got.Type)
	require.Equal(t, "id-1", got.ID)
}

func TestParseMessageRejectsMissingType(t *testing.T) {
	_, err := ParseMessage([]byte(`{"id":"x","payload":{}}`))
	require.Error(t, err)
}
