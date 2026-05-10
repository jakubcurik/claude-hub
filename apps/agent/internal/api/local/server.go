// SPDX-License-Identifier: Apache-2.0
package local

import "net/http"

type State interface {
	Status() StatusResponse
	Pair(hubURL, pin string) error
}

type Server struct {
	token string
	state State
}

func NewServer(token string, state State) *Server {
	return &Server{token: token, state: state}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/status", s.handleStatus)
	mux.HandleFunc("/v1/pair", s.handlePair)
	return s.withMiddleware(mux)
}
