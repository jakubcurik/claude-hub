// SPDX-License-Identifier: Apache-2.0
package wss

import (
	"context"
	"math"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
	"github.com/rs/zerolog"
)

const (
	keepalivePeriod = 30 * time.Second
	writeWait       = 10 * time.Second
	readWait        = 60 * time.Second
)

type Client struct {
	url    string
	token  string
	router *Router
	log    zerolog.Logger
}

func NewClient(url, token string, router *Router, log zerolog.Logger) *Client {
	return &Client{url: url, token: token, router: router, log: log}
}

// Run reconnects with exponential backoff until ctx is done.
func (c *Client) Run(ctx context.Context) {
	attempt := 0
	for {
		if err := c.RunOnce(ctx); err != nil {
			c.log.Warn().Err(err).Msg("wss connection ended")
		}
		if ctx.Err() != nil {
			return
		}
		delay := time.Duration(math.Min(float64(time.Minute), float64(time.Second)*math.Pow(2, float64(attempt))))
		attempt++
		select {
		case <-time.After(delay):
		case <-ctx.Done():
			return
		}
	}
}

// RunOnce performs a single connection lifecycle.
func (c *Client) RunOnce(ctx context.Context) error {
	hdr := http.Header{"Authorization": []string{"Bearer " + c.token}}
	conn, _, err := websocket.DefaultDialer.DialContext(ctx, c.url, hdr)
	if err != nil {
		return err
	}
	defer conn.Close()

	conn.SetReadDeadline(time.Now().Add(readWait))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(readWait))
	})

	done := make(chan struct{})
	// keepalive
	go func() {
		t := time.NewTicker(keepalivePeriod)
		defer t.Stop()
		for {
			select {
			case <-t.C:
				_ = conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(writeWait))
			case <-done:
				return
			case <-ctx.Done():
				return
			}
		}
	}()
	defer close(done)

	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		_, raw, err := conn.ReadMessage()
		if err != nil {
			if websocket.IsCloseError(err,
				websocket.CloseNormalClosure,
				websocket.CloseGoingAway,
				websocket.CloseNoStatusReceived,
				websocket.CloseAbnormalClosure,
			) {
				return nil
			}
			return err
		}
		msg, err := ParseMessage(raw)
		if err != nil {
			c.log.Warn().Err(err).Msg("wss: parse error")
			continue
		}
		out, err := c.router.Dispatch(msg)
		if err != nil {
			c.log.Warn().Err(err).Str("type", msg.Type).Msg("wss: dispatch error")
			continue
		}
		if out != nil {
			conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := conn.WriteJSON(out); err != nil {
				return err
			}
		}
	}
}
