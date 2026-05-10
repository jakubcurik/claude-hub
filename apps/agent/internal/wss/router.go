// SPDX-License-Identifier: Apache-2.0
package wss

import (
	"errors"
	"fmt"
	"sync"
)

var ErrUnknownMessageType = errors.New("wss: unknown message type")

type Handler func(*Message) (*Message, error)

type Router struct {
	mu       sync.RWMutex
	handlers map[string]Handler
}

func NewRouter() *Router {
	r := &Router{handlers: map[string]Handler{}}
	r.Handle(TypePing, func(m *Message) (*Message, error) {
		out := NewPong(m.ID)
		return &out, nil
	})
	return r
}

func (r *Router) Handle(t string, h Handler) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.handlers[t] = h
}

func (r *Router) Dispatch(m *Message) (*Message, error) {
	r.mu.RLock()
	h, ok := r.handlers[m.Type]
	r.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("%w: %s", ErrUnknownMessageType, m.Type)
	}
	return h(m)
}
