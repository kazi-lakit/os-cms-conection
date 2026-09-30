# Fake CMS — Blocks Integration Test Harness

A small stand-in CMS (React frontend + a tiny Node/Express backend) used to end-to-end test
blocks-os's **"Connect with Blocks"** integration flow — the OAuth-style redirect a WordPress (or
any CMS) plugin uses to connect to Blocks Localization — without needing a real WordPress install
or a curl script full of copy-pasted values.

This app is not part of blocks-os, blocks-iam or blocks-localization. It's a separate, disposable
test client that talks to those services exactly the way a real CMS plugin would.

## Context: what this tests, and why it exists

This harness was built while implementing and reviewing the CMS integration feature described in:
- `../CMS_INTEGRATION_PLAN.md` — the full implementation plan (phases 1–3), user journeys,
  API contracts, acceptance criteria.
- `../CMS_INTEGRATION_REVIEW_FIXES.md` — the review log of bugs found and fixed across several
  passes (client build errors, double-approve races, PKCE ordering, rate-limit IP resolution,
  the "never delivered" credential cleanup, etc.). By the last pass in that file, all tracked
  items were ✅ and all four test suites (blocks-os client/server, blocks-iam, blocks-localization)
  passed. **What none of those test suites can prove is that the actual browser redirect chain,
  cookie/session survival, and server-to-server exchange work end to end against a running
  deployment** — that's what this harness is for.

If you're an agent picking this up fresh: read those two files first for the why and the design;
this README covers how to actually drive a live test with them.

### The flow being tested

```
Fake CMS (this app)              blocks-os                         blocks-iam / Localization API
  |  GET /connect                    |                                        |
  |---------------------------------->  redirect to blocks-os /connect        |
  |                                  |  (user logs in / signs up, picks       |
  |                                  |   project + environment + template,    |
  |                                  |   clicks Approve)                      |
  |<---- redirect with code+state ---|                                        |
  |  (browser lands on               |                                        |
  |   GET /callback)                 |                                        |
  |                                  |                                        |
  |  POST /api/Integration/Exchange  |                                        |
  |  (server-to-server, this app's   |                                        |
  |   Node backend, NOT the browser) |                                        |
  |---------------------------------->                                       |
  |<--- clientId/clientSecret/... ---|                                        |
  |                                  |                                        |
  |  POST /api/oidc/token (client_credentials) ------------------------------->
  |<------------------------------------------------------------- access token
  |  Localization API calls with that token ---------------------------------->
```

See `blocks-os/server/Api/Controllers/IntegrationController.cs` (endpoints: `CreateRequest`,
`GetRequest`, `Approve`, `Cancel`, `Exchange`) and `blocks-os/client/app/pages/connect/connect.tsx`
for the other side of this exchange.

### Why this needs a backend, not just a React page

The `Exchange` endpoint returns `clientSecret` in its response. A real CMS plugin does the
code-for-secret exchange **server-side** (WordPress: PHP, via `wp_remote_post`) so the secret
never touches the browser. A pure React SPA calling `Exchange` directly from browser JS would:

- put the secret in the browser's network tab and JS memory — the exact thing the design in
  `CMS_INTEGRATION_PLAN.md` §5 (PKCE, server-built redirects, "the secret never appears in a
  URL") is meant to prevent,
- test a flow no real, well-built plugin would actually use.

So this harness has a small Node backend that plays the role of the plugin's PHP: it starts the
redirect, receives the callback, does the Exchange call, and is the only place the secret is ever
held (in `server/.connection.json`, gitignored). The React app only ever talks to *this app's own*
`/api/*` endpoints, never to blocks-os or blocks-iam directly — which also means there's no CORS
configuration to worry about on either side.

### What this harness does *not* test

- WordPress-specific plumbing: `wp_remote_post`, transients, `manage_options`, nonces, storing
  options with `autoload` off. For that you need a real WordPress instance (Docker /
  `@wordpress/env`) running the actual plugin — this harness only proves the blocks-os/blocks-iam
  side of the contract is correct and stable, so plugin development elsewhere can build against it
  with confidence.
- Multi-site/multi-tenant behavior on the CMS side: this app tracks exactly one connection at a
  time (`server/.connection.json`), like testing one WordPress site.
- Calling blocks-os's own `Disconnect`/`RegenerateSecret` endpoints — those require a logged-in
  Blocks user's token, which this harness (correctly) never holds. Use the Integration page in
  blocks-os itself to revoke or rotate a credential; this app's own "Disconnect" button only
  forgets the credential locally, so you can immediately test reconnecting.

## Requirements

- Node.js 18+ (uses the built-in `fetch` and `crypto.randomUUID`/`base64url`).
- A running blocks-os (client + server) and blocks-iam (server), reachable from this machine,
  with the CMS integration feature's Phase 1–3 code deployed (see `CMS_INTEGRATION_PLAN.md`).
- The one-time data setup from the plan already done in that environment (plan §12 / task P1-9):
  - `blocks-os/server/seed/integration-templates.json` and
    `integration-permissions.upsert.json` imported into `BlocksConfiguration`, with `BaseUrl`
    set to that environment's real Blocks Localization URL,
  - a Blocks user account with access to at least one project/environment that has
    `blocks-os::integration::get` / `::save`.

## Setup

```bash
cd fake-cms-test-harness
npm install          # installs both server/ and client/ workspaces
cp server/.env.example server/.env
```

Edit `server/.env`:

| Variable | Meaning |
|---|---|
| `BLOCKS_OS_URL` | blocks-os origin — used for the browser redirect to `/connect` and the server-to-server `POST /api/Integration/Exchange` call |
| `BLOCKS_IAM_URL` | blocks-iam origin — used for the server-to-server `POST /api/oidc/token` call |
| `APP_ORIGIN` | this app's own public origin (default `http://localhost:8080`). Must exactly match what's sent as `redirect_uri` at both `CreateRequest` and `Exchange` time — a mismatch is rejected by `IntegrationConnectService.ExchangeAsync` |
| `PORT` | port this app's backend listens on (default `8080`) |
| `SITE_NAME` | shown on the blocks-os Approve screen ("**{SITE_NAME}** wants access to Blocks Localization") |
| `SUGGESTED_TEMPLATE` | optional — pre-selects `localization-read` or `localization-full` on the Approve screen |

## Running it

Two dev servers (backend on 8080, React/Vite on 5175, proxied to the backend):

```bash
npm run dev
```

Open **http://localhost:8080/** (not 5175 — see note below) and click **"Connect to Blocks
Localization"**.

> **Note on ports:** `/connect`, `/callback` and secrets only ever flow through the backend. When
> using `npm run dev`, either port works for browsing the UI (Vite proxies the three backend
> paths), but if you set `APP_ORIGIN=http://localhost:8080` in `.env` (the default), start the
> flow from **http://localhost:8080/connect**, or from the "Connect" button — don't hand-type
> `http://localhost:5175/connect` and expect the callback to match. Simplest: always use port
> 8080 in the browser during dev.

Or run it "for real" — a single origin, built React app served by the same Node process that
holds the secret, closer to how it'd actually be deployed:

```bash
npm run build
npm start
# open http://localhost:8080
```

## What a full test run looks like

1. **Not connected.** Load the app — it should show "Not connected".
2. **Click Connect.** Browser goes to blocks-os `/connect?app=localization&redirect_uri=...`.
   Log in (or sign up, to exercise the plan's J4 new-user journey), pick a project and
   environment, choose Read or Full, wait for "Setting up your environment…" to clear, click
   **Approve**.
3. **Land back on this app** at `/?connected=1`. Status card shows the template, client id,
   masked secret, environment key, base URL and domain — all pulled from `Exchange`'s response,
   never hand-typed.
4. **Run the test calls:**
   - `Key/Gets` (list) — should succeed on both Read and Full.
   - `Key/SaveKeys` — should succeed on Full, `403` on Read.
   - `Key/DeleteCollections` — should be `403` on both (neither template grants delete).

   Re-run the whole flow once with a Read connection and once with Full to see the boundary
   change. Compare against the exact permission lists in
   `blocks-os/server/seed/integration-templates.json`.
5. **Add real keys** (Full connections). The "Add keys" card lists the environment's modules
   and languages, and saves new keys through `Key/SaveKeys`. Each key gets a name (2–100
   characters), one text per language, and an optional context. "Publish after saving" sets
   `ShouldPublish`, so Localization also regenerates its published file. On a Read connection
   the save should come back `403`, which is the expected result.
   - **The environment needs at least one module first.** New environments have none (project
     setup deliberately doesn't copy `BlocksLanguageModules`), and neither template grants
     `module::save`, so create a module in the Blocks Localization UI once, then click Reload.
   - The "save-keys" test call sends an empty list on purpose. It checks the permission without
     writing anything: `200` with `"Keys list cannot be null or empty"` means the permission
     passed.
6. **Disconnect**, then reconnect — confirms a second connection for the same "site" works
   (plan critical path 8: reconnecting the same site).
7. **Click Cancel instead of Approve** on a fresh connect attempt — browser should land back
   here with `?error=access_denied`.
8. **Reuse a used-up code**: note the `code` from a `/callback` URL, then manually
   `curl -X POST $BLOCKS_OS_URL/api/Integration/Exchange ...` with it again — must fail
   (`invalid_code`). Confirms the exchange fix in `CMS_INTEGRATION_REVIEW_FIXES.md` (N-01/F-09)
   holds.

## File map

```
fake-cms-test-harness/
├── README.md              you are here
├── package.json           npm workspaces root; `npm run dev` / `build` / `start`
├── server/                the "plugin's PHP backend" — holds the secret, does the redirects
│   ├── index.js           all routes: /connect, /callback, /api/status, /api/disconnect,
│   │                        /api/test-calls, /api/test-call/:id,
│   │                        /api/localization/modules, /api/localization/languages,
│   │                        /api/localization/keys (POST), static serving of client/dist
│   ├── store.js           tiny JSON-file persistence for the one stored connection
│   ├── .env.example       copy to .env and fill in
│   └── .connection.json   created at runtime, gitignored — holds the live client secret
└── client/                the "plugin's settings page" — never sees the secret
    ├── vite.config.js     dev-mode proxy to the backend on :8080
    └── src/
        ├── main.jsx
        ├── App.jsx        status card, Connect/Disconnect, test-call runner, Add keys form
        └── App.css        theme and styles
```

## Backend API for the React app

The React app only calls these (all on this app's own origin). Every Localization call uses the
stored credential and a cached `client_credentials` token.

| Route | What it does |
|---|---|
| `GET /connect` | Starts the connect flow: makes PKCE + state, redirects to blocks-os `/connect` |
| `GET /callback` | Checks state, calls `Integration/Exchange` server to server, stores the keys |
| `GET /api/status` | Connection details, secret masked |
| `POST /api/disconnect` | Forgets the connection locally (doesn't revoke it in blocks-os) |
| `GET /api/test-calls`, `POST /api/test-call/:id` | Fixed permission checks (list keys, save keys with an empty list, delete collections) |
| `GET /api/localization/modules` | `Module/GetModulesForCurrentTenant` → `{ modules: [{ id, name }] }` |
| `POST /api/localization/modules` | Body `{ moduleName }` (3–100 chars, unique). Maps to `Module/Save` → needs `blocks-localization::module::save`, which neither template grants, so expect 403 on Read and Full |
| `GET /api/localization/languages` | `Language/GetLanguagesForCurrentTenant` → `{ languages: [{ code, name, isDefault }] }` |
| `POST /api/localization/keys` | Body `{ moduleId, publish?, keys: [{ keyName, context?, values: { "<culture>": "<text>" } }] }`. Maps to Localization's `Key` model (`KeyName`, `ModuleId`, `Resources[{ Culture, Value, CharacterLength }]`, `IsNewKey: true`, `ShouldPublish`) and calls `Key/SaveKeys` |

Note that `Key/SaveKeys` answers HTTP 200 even when some keys fail validation (for example a
duplicate name in the same module). Check `body.success` and `body.errorMessage` in the response,
not just the status code.

## Security notes

- `server/.connection.json` holds a live client secret in plaintext. It's gitignored; don't
  commit it, and delete it (or run `POST /api/disconnect`) when you're done testing.
- `server/.env` is gitignored too.
- This harness has no auth of its own — anyone who can reach its port can see the masked status
  and trigger test calls with the stored credential. Fine for local/dev use; don't deploy it
  anywhere reachable by the public internet.
