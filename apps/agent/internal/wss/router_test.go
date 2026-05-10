// SPDX-License-Identifier: Apache-2.0
package wss

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestRouterDispatchesPingToPongHandler(t *testing.T) {
	r := NewRouter()
	var seen string
	r.Handle(TypePing, func(m *Message) (*Message, error) {
		seen = m.ID
		return ptr(NewPong(m.ID)), nil
	})
	out, err := r.Dispatch(&Message{Type: TypePing, ID: "id-1", Payload: json.RawMessage(`{}`)})
	require.NoError(t, err)
	require.Equal(t, "id-1", seen)
	require.Equal(t, TypePong, out.Type)
}

func TestRouterReturnsErrorForUnknown(t *testing.T) {
	r := NewRouter()
	_, err := r.Dispatch(&Message{Type: "job.alien", ID: "x", Payload: json.RawMessage(`{}`)})
	require.True(t, errors.Is(err, ErrUnknownMessageType))
}

func ptr[T any](v T) *T { return &v }
