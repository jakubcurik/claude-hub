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
	Asset   claudecode.CatalogAsset  `json:"asset"`
	Options claudecode.InstallOptions `json:"options"`
}

type enabledRequest struct {
	Asset   claudecode.CatalogAsset  `json:"asset"`
	Enabled bool                     `json:"enabled"`
	Options claudecode.InstallOptions `json:"options"`
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
	s.mux.HandleFunc("POST /v1/uninstall", s.withAuth(s.handleUninstall))
	s.mux.HandleFunc("POST /v1/diff", s.withAuth(s.handleDiff))
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
		"ok":             true,
		"app":            "claude-hub-daemon",
		"version":        "0.1.0",
		"paired":         s.isAuthorized(request),
		"tokenRequired":  true,
		"claudeHome":     s.manager.ClaudeHome,
		"knownProjects":  s.manager.KnownProjects(),
		"capabilities": []string{
			"catalog-state",
			"install-preview",
			"install",
			"uninstall",
			"enable-disable",
			"local-assets",
			"local-asset-export",
			"diff",
			"mcp-merge",
			"hook-merge",
			"plugin-install",
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
	preview, err := s.manager.PreviewInstall(body.Asset, body.Options)
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
	state, err := s.manager.Install(body.Asset, body.Options)
	if err != nil {
		writeError(response, http.StatusBadRequest, err)
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"state": state})
}

func (s *Server) handleDiff(response http.ResponseWriter, request *http.Request) {
	var body assetRequest
	if !decodeBody(response, request, &body) {
		return
	}
	diff, err := s.manager.Diff(body.Asset)
	if err != nil {
		writeError(response, http.StatusBadRequest, err)
		return
	}
	writeJSON(response, http.StatusOK, diff)
}

func (s *Server) handleUninstall(response http.ResponseWriter, request *http.Request) {
	var body assetRequest
	if !decodeBody(response, request, &body) {
		return
	}
	state, err := s.manager.Uninstall(body.Asset, body.Options)
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
	state, err := s.manager.SetEnabled(body.Asset, body.Enabled, body.Options)
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
				"error":   errorTitle(http.StatusUnauthorized),
				"code":    "unauthorized",
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
		"error":   errorTitle(status),
		"code":    errorCode(status),
		"message": err.Error(),
	})
}

func errorTitle(status int) string {
	switch status {
	case http.StatusBadRequest:
		return "Bad Request"
	case http.StatusUnauthorized:
		return "Unauthorized"
	case http.StatusForbidden:
		return "Forbidden"
	case http.StatusNotFound:
		return "Not Found"
	case http.StatusConflict:
		return "Conflict"
	case http.StatusUnprocessableEntity:
		return "Unprocessable Entity"
	case http.StatusInternalServerError:
		return "Internal Server Error"
	default:
		return "Error"
	}
}

func errorCode(status int) string {
	switch status {
	case http.StatusBadRequest:
		return "bad_request"
	case http.StatusUnauthorized:
		return "unauthorized"
	case http.StatusForbidden:
		return "forbidden"
	case http.StatusNotFound:
		return "not_found"
	case http.StatusConflict:
		return "conflict"
	case http.StatusUnprocessableEntity:
		return "unprocessable_entity"
	case http.StatusInternalServerError:
		return "internal_error"
	default:
		return "error"
	}
}

var pairPageTemplate = template.Must(template.New("pair").Parse(`<!doctype html>
<html lang="cs">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Párování zařízení | Claude Hub</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&family=Space+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      color-scheme: dark;
      --bg: #141413;
      --surface: #1B1B1A;
      --surface-2: #262624;
      --border: #2A2A28;
      --border-strong: #3A3A37;
      --ink: #F5F4ED;
      --ink-muted: #C8C5BD;
      --muted: #8B8780;
      --accent: #F26B3D;
      --accent-hover: #FF8358;
      --accent-active: #D8551F;
      --success: #4ADE80;
      font-family: "DM Sans", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--ink);
      background: var(--bg);
      -webkit-font-smoothing: antialiased;
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
      gap: 20px;
      padding: 32px;
      border: 1px solid var(--border);
      border-radius: 14px;
      background: var(--surface);
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 4px;
    }
    .brand-mark {
      display: grid;
      width: 42px;
      height: 42px;
      place-items: center;
      border-radius: 10px;
      background: var(--accent);
      color: #1B1B1A;
      font-family: "Space Grotesk", sans-serif;
      font-size: 14px;
      font-weight: 700;
      letter-spacing: -0.02em;
    }
    .brand strong {
      font-family: "Space Grotesk", sans-serif;
      font-size: 15px;
      font-weight: 600;
      letter-spacing: -0.01em;
    }
    .brand span {
      display: block;
      margin-top: 2px;
      color: var(--muted);
      font-size: 12px;
    }
    h1 {
      margin: 0;
      font-family: "Space Grotesk", sans-serif;
      font-size: 24px;
      font-weight: 600;
      line-height: 1.2;
      letter-spacing: -0.01em;
      color: var(--ink);
    }
    p {
      margin: 0;
      color: var(--ink-muted);
      line-height: 1.55;
      font-size: 14px;
    }
    code {
      display: block;
      overflow-wrap: anywhere;
      padding: 12px 14px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--bg);
      color: var(--ink);
      font-family: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
      font-size: 12.5px;
    }
    button {
      min-height: 44px;
      padding: 0 18px;
      border: 1px solid var(--accent);
      border-radius: 10px;
      background: var(--accent);
      color: #1B1B1A;
      font: inherit;
      font-weight: 600;
      font-size: 14px;
      cursor: pointer;
      transition: background 140ms ease, border-color 140ms ease;
    }
    button:hover {
      background: var(--accent-hover);
      border-color: var(--accent-hover);
    }
    button:active {
      background: var(--accent-active);
      border-color: var(--accent-active);
    }
    button:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
    .success {
      color: var(--success);
      font-weight: 600;
    }
  </style>
</head>
<body>
  <main>
    <div class="brand">
      <div class="brand-mark">CH</div>
      <div>
        <strong>Claude Hub</strong>
        <span>Propojení zařízení</span>
      </div>
    </div>
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
