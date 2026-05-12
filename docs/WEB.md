# Web aplikace (`apps/web`)

Next.js 16 (App Router) + React 19. Slouží jako jediné rozhraní pro tým — katalog, lokální stav, párování s daemonem a publikování. Komunikuje se dvěma backendy:

- **Registry API** (`CLAUDE_HUB_API_URL`) — server-side, přes session cookie.
- **Local daemon** (`http://127.0.0.1:17373`) — klientsky, přes Bearer token z `localStorage`.

## Struktura

```text
apps/web
├── app
│   ├── actions.ts            Server actions (login, logout, publish, pairing meta)
│   ├── globals.css           Globální CSS
│   ├── layout.tsx            Root layout, lang="cs"
│   ├── login/page.tsx        Email login form
│   ├── page.tsx              Katalogová úvodní stránka
│   └── pair/complete/page.tsx Klientská stránka pro dokončení párování
├── components
│   └── catalog-experience.tsx Hlavní klientský komponent (1000+ řádků)
├── lib
│   ├── catalog.ts            Lokální fallback (prázdné pole)
│   ├── daemon-client.ts      Klient pro daemon HTTP API
│   ├── hub-auth.ts           Session cookie + API URL helpery
│   └── registry-client.ts    Server-side fetch katalogu z API
├── next.config.mjs
├── package.json
└── tsconfig.json
```

## Tok obrazovek

1. **`/login`** — pokud uživatel není přihlášený, server akce `loginAction` zavolá `POST /v1/auth/login`, uloží session token do HTTP-only cookie `claude_hub_session` a přesměruje na `/`.
2. **`/`** — server komponenta `Page`:
   - vytáhne `user` přes `getCurrentUser()`,
   - načte katalog z API přes `getCatalogAssets(user.defaultTeamId)`,
   - vyrenderuje `<CatalogExperience>` s daty.
3. **`/pair/complete`** — klientská stránka, která přečte `#daemonToken=…` z URL hashe, uloží do `localStorage` (`claudeHubDaemonToken`) a přesměruje na `/`.

## Server actions (`app/actions.ts`)

| Funkce                          | Co dělá                                                                |
| ------------------------------- | ---------------------------------------------------------------------- |
| `loginAction(formData)`         | E-mail → API `/v1/auth/login`, nastaví session cookie, redirect na `/` |
| `logoutAction()`                | Odhlášení (API + smazání cookie), redirect na `/login`                 |
| `publishLocalAssetToCatalog(x)` | `POST /v1/teams/:teamId/catalog` s upraveným ownerem                   |
| `registerPairedDevice({…})`     | `POST /v1/devices/pairing` (hashed token, label, claudeHome)           |

Všechny server actions přebírají session token přes `getSessionToken()` (čte z `next/headers cookies()`).

## `CatalogExperience` v detailu

Hlavní klientský komponent (`components/catalog-experience.tsx`) drží:

- **stav UI**: aktivní view (`catalog`/`local`), filtr typu (`all`, `skill`, `command`, …), search query, modal, busy flag, toast.
- **párovací stav**: `token`, `savedToken`, `daemonSummary`, `isConnected`.
- **datový stav**: `states` (mapa `assetId → LocalAssetState`), `localAssets[]`.

### Klíčové funkce

```ts
refresh(tokenOverride?)       // /v1/hello + /v1/state + /v1/local-assets
saveToken()                   // ručně zadaný token (z `<details>` panelu)
pairAutomatically()           // ověří /v1/hello, otevře daemon /pair
disconnectDaemon()            // vyčistí localStorage a stav
requestInstall(asset)         // /v1/install-preview → modal → /v1/install
setEnabled(asset, enabled)    // /v1/set-enabled
requestCatalogUpload(asset)   // /v1/local-assets/export → modal → publishLocalAssetToCatalog
```

### Stavový překlad

Funkce `formatState(state, connected, assetType)` převádí `LocalAssetState` na vizuální štítek:

| Podmínka                          | Label                  | Tone       |
| --------------------------------- | ---------------------- | ---------- |
| `assetType ∉ {skill,command}`     | „Zatím jen v katalogu" | `planned`  |
| `!connected`                      | „Počítač není připojený" | `offline`  |
| `!installed`                      | „Nenainstalováno"      | `neutral`  |
| `localChanges`                    | „Upraveno lokálně"     | `warning`  |
| `updateAvailable`                 | „Nová verze"           | `update`   |
| `enabled`                         | „Zapnuto"              | `enabled`  |
| jinak                             | „Vypnuto"              | `disabled` |

Tone se používá v CSS pro barevné označení karet.

### Lokalizace katalogu

`apps/web/lib/registry-client.ts` přemapuje některé „strojem generované" texty na lidštější varianty (například `"Lokální položka nahraná z Claude Code." → "Položka nahraná z lokální instalace Claude Code."`). Tím se zaručí konzistentní český slovník i pro zpětně publikované assety.

## DaemonClient (`lib/daemon-client.ts`)

Tenký HTTP klient pro daemon. Veškeré requesty mají timeout 10 s (přes `AbortController`). `GET /v1/hello` jde bez Bearer hlavičky; zbytek vyžaduje token.

Chybové stavy se převádějí na lokalizované zprávy:

- `AbortError` → „Lokální služba neodpověděla včas…"
- 4xx/5xx → text z těla (`message`/`error`) nebo „Požadavek na lokální službu selhal."

## Auth helper (`lib/hub-auth.ts`)

```ts
sessionCookieName = "claude_hub_session"

hubApiUrl()         // čte CLAUDE_HUB_API_URL, jinak throw
getSessionToken()   // čte cookie
getCurrentUser()    // GET /v1/auth/session
loginWithEmail(e)   // POST /v1/auth/login + cookies.set(…)
clearCurrentSession() // POST /v1/auth/logout + cookies.delete(…)
```

Cookie:

```ts
{
  expires: new Date(payload.expiresAt),
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  path: "/"
}
```

## Konfigurace zobrazení

`app/page.tsx` posílá do komponenty `daemonInstall` se třemi položkami:

- `brewPackage` (`CLAUDE_HUB_DAEMON_BREW_PACKAGE`)
- `hubUrl` (`CLAUDE_HUB_PUBLIC_URL`)
- `wingetId` (`CLAUDE_HUB_DAEMON_WINGET_ID`)

Tyto hodnoty slouží jako copy/paste hinty v UI, když daemon není nainstalovaný.

## Build a deploy

```bash
npm run typecheck         # tsc --noEmit
npm --workspace @claude-hub/web run build
npm --workspace @claude-hub/web run start   # standalone produkční start
```

Docker image (`apps/web/Dockerfile`) staví obraz pomocí `node:24-alpine` ve třech vrstvách (`deps`, `builder`, `runner`). Telemetry Next.js je vypnutá (`NEXT_TELEMETRY_DISABLED=1`).

## Stylování

Globální CSS (`app/globals.css`) drží Animato lab paletu (béžová `#f4f1ea`, tmavá zelená `#1f8a70`, antracit `#172126`). Komponenty z `lucide-react` poskytují ikony (`PlugZap`, `MonitorCheck`, `Copy`, `ChevronRight`, …).

## Edge cases

- Bez `CLAUDE_HUB_API_URL` server hodí výjimku už při `hubApiUrl()` — užitečné pro early failure, ale znamená to, že web nelze spustit bez API.
- Bez session tokenu (po expiraci) se `getCatalogAssets` vrací k prázdnému lokálnímu fallbacku — uživatel uvidí jen prázdnou stránku, login flow ho přesměruje.
- Pokud uživatel mění `CLAUDE_HUB_WORKSPACE_ROOTS` na daemonu, je nutné v UI ručně kliknout „Obnovit stav".
