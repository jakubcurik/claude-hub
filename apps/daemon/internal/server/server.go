package server

import (
	"encoding/json"
	"html/template"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"

	"github.com/claude-hub/claude-hub/apps/daemon/internal/claudecode"
)

var localOriginPattern = regexp.MustCompile(`^https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$`)

type Server struct {
	manager *claudecode.Manager
	token   string
	logger  *slog.Logger
	mux     *http.ServeMux
}

type stateRequest struct {
	Catalog []claudecode.CatalogAsset `json:"catalog"`
}

type assetRequest struct {
	Asset claudecode.CatalogAsset `json:"asset"`
}

type enabledRequest struct {
	Asset   claudecode.CatalogAsset `json:"asset"`
	Enabled bool                    `json:"enabled"`
}

type localAssetExportRequest struct {
	LocalAssetID string `json:"localAssetId"`
}

func New(manager *claudecode.Manager, token string, logger *slog.Logger) *Server {
	server := &Server{
		manager: manager,
		token:   token,
		logger:  logger,
		mux:     http.NewServeMux(),
	}
	server.routes()
	return server
}

func (s *Server) Handler() http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		s.applyCORS(response, request)
		if request.Method == http.MethodOptions {
			response.WriteHeader(http.StatusNoContent)
			return
		}
		s.mux.ServeHTTP(response, request)
	})
}

func (s *Server) routes() {
	s.mux.HandleFunc("GET /pair", s.handlePairPage)
	s.mux.HandleFunc("GET /v1/hello", s.handleHello)
	s.mux.HandleFunc("POST /v1/state", s.withAuth(s.handleState))
	s.mux.HandleFunc("POST /v1/install-preview", s.withAuth(s.handleInstallPreview))
	s.mux.HandleFunc("POST /v1/install", s.withAuth(s.handleInstall))
	s.mux.HandleFunc("POST /v1/set-enabled", s.withAuth(s.handleSetEnabled))
	s.mux.HandleFunc("GET /v1/local-assets", s.withAuth(s.handleLocalAssets))
	s.mux.HandleFunc("POST /v1/local-assets/export", s.withAuth(s.handleLocalAssetExport))
}

func (s *Server) handlePairPage(response http.ResponseWriter, request *http.Request) {
	returnURL := request.URL.Query().Get("returnUrl")
	parsedReturnURL, err := url.Parse(returnURL)
	if err != nil || !parsedReturnURL.IsAbs() || !isAllowedWebOrigin(parsedReturnURL.Scheme+"://"+parsedReturnURL.Host) {
		response.WriteHeader(http.StatusBadRequest)
		_, _ = response.Write([]byte("Návratová URL Claude Hubu není povolená."))
		return
	}

	response.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := pairPageTemplate.Execute(response, map[string]string{
		"ClaudeHome": s.manager.ClaudeHome,
		"ReturnURL":  parsedReturnURL.String(),
		"Token":      s.token,
	}); err != nil {
		s.logger.Error("failed to render pair page", "error", err)
	}
}

func (s *Server) handleHello(response http.ResponseWriter, request *http.Request) {
	writeJSON(response, http.StatusOK, map[string]any{
		"ok":            true,
		"app":           "claude-hub-daemon",
		"version":       "0.1.0",
		"paired":        s.isAuthorized(request),
		"tokenRequired": true,
		"claudeHome":    s.manager.ClaudeHome,
		"capabilities": []string{
			"catalog-state",
			"install-preview",
			"install",
			"enable-disable",
			"local-assets",
			"local-asset-export",
		},
	})
}

func (s *Server) handleState(response http.ResponseWriter, request *http.Request) {
	var body stateRequest
	if !decodeBody(response, request, &body) {
		return
	}
	state, err := s.manager.State(body.Catalog)
	if err != nil {
		writeError(response, http.StatusBadRequest, err)
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"state": state})
}

func (s *Server) handleInstallPreview(response http.ResponseWriter, request *http.Request) {
	var body assetRequest
	if !decodeBody(response, request, &body) {
		return
	}
	preview, err := s.manager.PreviewInstall(body.Asset)
	if err != nil {
		writeError(response, http.StatusBadRequest, err)
		return
	}
	writeJSON(response, http.StatusOK, preview)
}

func (s *Server) handleInstall(response http.ResponseWriter, request *http.Request) {
	var body assetRequest
	if !decodeBody(response, request, &body) {
		return
	}
	state, err := s.manager.Install(body.Asset)
	if err != nil {
		writeError(response, http.StatusBadRequest, err)
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"state": state})
}

func (s *Server) handleSetEnabled(response http.ResponseWriter, request *http.Request) {
	var body enabledRequest
	if !decodeBody(response, request, &body) {
		return
	}
	state, err := s.manager.SetEnabled(body.Asset, body.Enabled)
	if err != nil {
		writeError(response, http.StatusBadRequest, err)
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"state": state})
}

func (s *Server) handleLocalAssets(response http.ResponseWriter, request *http.Request) {
	assets, err := s.manager.LocalAssets()
	if err != nil {
		writeError(response, http.StatusBadRequest, err)
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"assets": assets})
}

func (s *Server) handleLocalAssetExport(response http.ResponseWriter, request *http.Request) {
	var body localAssetExportRequest
	if !decodeBody(response, request, &body) {
		return
	}
	export, err := s.manager.ExportLocalAsset(body.LocalAssetID)
	if err != nil {
		writeError(response, http.StatusBadRequest, err)
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"asset": export})
}

func (s *Server) withAuth(handler http.HandlerFunc) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		if !s.isAuthorized(request) {
			writeJSON(response, http.StatusUnauthorized, map[string]string{
				"error":   "Unauthorized",
				"message": "Vložte do webové aplikace párovací token lokální služby.",
			})
			return
		}
		handler(response, request)
	}
}

func (s *Server) isAuthorized(request *http.Request) bool {
	return request.Header.Get("Authorization") == "Bearer "+s.token
}

func (s *Server) applyCORS(response http.ResponseWriter, request *http.Request) {
	origin := request.Header.Get("Origin")
	if origin != "" && (origin == "null" || isAllowedWebOrigin(origin)) {
		response.Header().Set("Access-Control-Allow-Origin", origin)
	}
	response.Header().Set("Vary", "Origin")
	response.Header().Set("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
	response.Header().Set("Access-Control-Allow-Headers", "content-type, authorization")
	if request.Header.Get("Access-Control-Request-Private-Network") == "true" {
		response.Header().Set("Access-Control-Allow-Private-Network", "true")
	}
}

func isAllowedWebOrigin(origin string) bool {
	if localOriginPattern.MatchString(origin) {
		return true
	}

	for _, allowedOrigin := range configuredWebOrigins() {
		if origin == allowedOrigin {
			return true
		}
	}
	return false
}

func configuredWebOrigins() []string {
	raw := os.Getenv("CLAUDE_HUB_ALLOWED_WEB_ORIGINS")
	if strings.TrimSpace(raw) == "" {
		return nil
	}

	origins := make([]string, 0)
	for _, item := range strings.FieldsFunc(raw, func(r rune) bool {
		return r == ',' || r == ';' || r == '\n' || r == '\t' || r == ' '
	}) {
		origin := strings.TrimRight(strings.TrimSpace(item), "/")
		if origin != "" {
			origins = append(origins, origin)
		}
	}
	return origins
}

func decodeBody(response http.ResponseWriter, request *http.Request, target any) bool {
	defer request.Body.Close()
	if err := json.NewDecoder(request.Body).Decode(target); err != nil {
		writeError(response, http.StatusBadRequest, err)
		return false
	}
	return true
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}

func writeError(response http.ResponseWriter, status int, err error) {
	writeJSON(response, status, map[string]string{
		"error":   "Požadavek selhal",
		"message": err.Error(),
	})
}

var pairPageTemplate = template.Must(template.New("pair").Parse(`<!doctype html>
<html lang="cs">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Párování zařízení | Claude Hub</title>
  <style>
    :root {
      color-scheme: light;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #172126;
      background: #f4f1ea;
    }
    body {
      display: grid;
      min-height: 100vh;
      margin: 0;
      place-items: center;
      padding: 24px;
    }
    main {
      display: grid;
      width: min(440px, 100%);
      gap: 18px;
      padding: 24px;
      border: 1px solid #ded8cc;
      border-radius: 8px;
      background: #ffffff;
      box-shadow: 0 18px 46px rgba(23, 33, 38, 0.08);
    }
    h1 {
      margin: 0;
      font-size: 24px;
      line-height: 1.15;
    }
    p {
      margin: 0;
      color: #66737a;
      line-height: 1.5;
    }
    code {
      display: block;
      overflow-wrap: anywhere;
      padding: 10px;
      border-radius: 7px;
      background: #fbfaf7;
      color: #172126;
      font-size: 13px;
    }
    button {
      min-height: 42px;
      border: 1px solid #1f8a70;
      border-radius: 8px;
      background: #1f8a70;
      color: #ffffff;
      font: inherit;
      font-weight: 800;
      cursor: pointer;
    }
    button:hover {
      background: #12604e;
      border-color: #12604e;
    }
    .success {
      color: #12604e;
      font-weight: 800;
    }
  </style>
</head>
<body>
  <main>
    <h1>Povolit propojení zařízení</h1>
    <p>Claude Hub chce propojit webový katalog s lokální službou Claude Code na tomto počítači.</p>
    <code>{{.ClaudeHome}}</code>
    <button id="approve" type="button">Povolit propojení</button>
    <p id="status"></p>
  </main>
  <script>
    const token = {{.Token}};
    const returnUrl = {{.ReturnURL}};
    document.getElementById("approve").addEventListener("click", async () => {
      if (window.opener) {
        window.opener.postMessage({ source: "claude-hub-daemon", type: "pairing-token", token }, new URL(returnUrl).origin);
        document.getElementById("status").className = "success";
        document.getElementById("status").textContent = "Zařízení je spárované. Okno se zavře automaticky.";
        window.setTimeout(() => window.close(), 700);
        return;
      }

      document.getElementById("status").className = "success";
      document.getElementById("status").textContent = "Propojení je povolené. Vracíme vás do Claude Hubu.";
      window.location.href = returnUrl + "#daemonToken=" + encodeURIComponent(token);
    });
  </script>
</body>
</html>`))
