// SPDX-License-Identifier: Apache-2.0
package wss

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/rs/zerolog"
	"github.com/stretchr/testify/require"
)

func TestClientConnectsAuthenticatesAndReceivesPing(t *testing.T) {
	var pongs int32
	upgrader := websocket.Upgrader{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "Bearer device-tok", r.Header.Get("Authorization"))
		c, err := upgrader.Upgrade(w, r, nil)
		require.NoError(t, err)
		defer c.Close()
		require.NoError(t, c.WriteJSON(Message{Type: TypePing, ID: "p1", Payload: json.RawMessage(`{}`)}))
		var got Message
		require.NoError(t, c.ReadJSON(&got))
		if got.Type == TypePong {
			atomic.AddInt32(&pongs, 1)
		}
	}))
	defer srv.Close()

	url := "ws" + strings.TrimPrefix(srv.URL, "http")
	cli := NewClient(url, "device-tok", NewRouter(), zerolog.Nop())
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	require.NoError(t, cli.RunOnce(ctx))
	require.EqualValues(t, 1, atomic.LoadInt32(&pongs))
}
