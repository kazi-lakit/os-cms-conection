import "dotenv/config";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import cookieParser from "cookie-parser";
import { readConnection, writeConnection, clearConnection } from "./store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var ${name}. Copy server/.env.example to server/.env and fill it in.`);
    process.exit(1);
  }
  return value;
}

const PORT = process.env.PORT || 8080;
const APP_ORIGIN = process.env.APP_ORIGIN || `http://localhost:${PORT}`;
const BLOCKS_OS_URL = requireEnv("BLOCKS_OS_URL");
const BLOCKS_IAM_URL = requireEnv("BLOCKS_IAM_URL");
const SITE_NAME = process.env.SITE_NAME || "Fake CMS Test Harness";
const SUGGESTED_TEMPLATE = process.env.SUGGESTED_TEMPLATE || "";
const PENDING_TTL_MS = 10 * 60 * 1000;

const app = express();
app.use(express.json());
app.use(cookieParser());

// PKCE state per in-flight connect attempt, keyed by a random id kept in an httpOnly cookie.
// In-memory and fine to lose on restart: a real CMS plugin would use its own short-lived
// session/transient store for the same purpose (see README, "Integrate step by step").
const pending = new Map();

function clearExpiredPending() {
  const now = Date.now();
  for (const [id, attempt] of pending) {
    if (now - attempt.createdAt >= PENDING_TTL_MS) pending.delete(id);
  }
}

function base64url(buffer) {
  return buffer.toString("base64url");
}

function mask(secret) {
  if (!secret) return "";
  return secret.length <= 8 ? "••••••••" : `${secret.slice(0, 4)}••••${secret.slice(-4)}`;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ───────────────────────── Connect flow (browser redirects) ─────────────────────────
// Mirrors what a real CMS plugin's "Connect to Blocks" button + callback page do.
// See blocks-os/server/Api/Controllers/IntegrationController.cs (CreateRequest/Approve/Exchange)
// and blocks-os/client/app/pages/connect/connect.tsx for the other side of this flow.

app.get("/connect", (req, res) => {
  clearExpiredPending();
  if (req.cookies?.cms_session) pending.delete(req.cookies.cms_session);
  const verifier = base64url(crypto.randomBytes(48));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  const state = crypto.randomBytes(16).toString("hex");
  const sessionId = crypto.randomUUID();

  pending.set(sessionId, { verifier, state, createdAt: Date.now() });
  res.cookie("cms_session", sessionId, {
    httpOnly: true,
    sameSite: "lax",
    secure: new URL(APP_ORIGIN).protocol === "https:",
    maxAge: PENDING_TTL_MS,
  });

  const url = new URL("/connect", BLOCKS_OS_URL);
  url.searchParams.set("app", "localization");
  url.searchParams.set("redirect_uri", `${APP_ORIGIN}/callback`);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("site_name", SITE_NAME);
  if (SUGGESTED_TEMPLATE) url.searchParams.set("template", SUGGESTED_TEMPLATE);

  res.redirect(url.toString());
});

app.get("/callback", async (req, res) => {
  const { code, state, error, blocks_key: blocksKey } = req.query;
  const sessionId = req.cookies?.cms_session;
  const session = sessionId ? pending.get(sessionId) : null;

  const backToApp = (query) => res.redirect(`/${query ? `?${query}` : ""}`);
  const clearAttempt = () => {
    if (sessionId) pending.delete(sessionId);
    res.clearCookie("cms_session");
  };

  if (!session || Date.now() - session.createdAt >= PENDING_TTL_MS) {
    clearAttempt();
    return backToApp("error=session_lost_or_expired");
  }
  const returnedState = typeof state === "string" ? state : "";
  const expectedState = Buffer.from(session.state);
  const actualState = Buffer.from(returnedState);
  if (expectedState.length !== actualState.length || !crypto.timingSafeEqual(expectedState, actualState)) {
    clearAttempt();
    return backToApp("error=state_mismatch");
  }
  if (error) {
    clearAttempt();
    return backToApp(`error=${encodeURIComponent(String(error))}`);
  }
  if (typeof code !== "string" || !code || typeof blocksKey !== "string" || !blocksKey) {
    clearAttempt();
    return backToApp("error=missing_code_or_key");
  }

  // A browser can load the same callback twice, for example when a "Go to site now" click races
  // the connect page's auto-redirect. The one-time code can only be redeemed once, so the first
  // request does the exchange and any duplicate waits for that same result instead of failing
  // with invalid_code. The finished attempt stays in `pending` until the TTL sweep removes it.
  if (!session.exchange) session.exchange = exchangeCode(session, code, blocksKey);
  const outcome = await session.exchange;
  res.clearCookie("cms_session");
  return backToApp(outcome);
});

async function exchangeCode(session, code, blocksKey) {
  try {
    const response = await fetch(`${BLOCKS_OS_URL}/api/Integration/Exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Blocks-Key": String(blocksKey) },
      body: JSON.stringify({
        code: String(code),
        codeVerifier: session.verifier,
        redirectUri: `${APP_ORIGIN}/callback`,
      }),
    });
    const data = await response.json().catch(() => null);

    if (!response.ok || !data?.clientId || !data?.clientSecret) {
      const message = data?.errors ? JSON.stringify(data.errors) : `HTTP ${response.status}`;
      console.error("Exchange failed:", message);
      return `error=${encodeURIComponent(`exchange_failed:${message}`)}`;
    }

    // The secret is kept here, server-side, and never sent back to the browser. This is the
    // one thing a fake-CMS test harness must get right to actually test the real design —
    // see README, "Why this needs a backend, not just a React page".
    writeConnection({
      clientId: data.clientId,
      clientSecret: data.clientSecret,
      xBlocksKey: data.xBlocksKey,
      baseUrl: data.baseUrl,
      domain: data.domain,
      templateKey: data.templateKey,
      accessLevel: data.accessLevel,
      connectedAt: new Date().toISOString(),
    });
    tokenCache = null;
    return "connected=1";
  } catch (err) {
    console.error("Exchange error:", err);
    return `error=${encodeURIComponent(`exchange_error:${err.message}`)}`;
  }
}

// ───────────────────────── API for the React frontend ─────────────────────────
// Never returns the raw client secret — only a masked preview. The frontend has no other way
// to read it, matching how a real plugin's admin UI should behave after the initial reveal.

app.get("/api/status", (req, res) => {
  const connection = readConnection();
  if (!connection) return res.json({ connected: false });
  const { clientSecret, ...safe } = connection;
  res.json({ connected: true, ...safe, clientSecretMasked: mask(clientSecret) });
});

app.post("/api/disconnect", (req, res) => {
  // Forgets the credential in THIS app only. It does not call blocks-os's own Disconnect
  // endpoint (that needs a logged-in Blocks user's token, which this harness never holds) —
  // use the Integration page in blocks-os to actually revoke the credential in IAM.
  clearConnection();
  tokenCache = null;
  res.json({ connected: false });
});

// ───────────────────────── Token handling (client_credentials) ─────────────────────────

let tokenCache = null; // { accessToken, expiresAt }

async function getAccessToken() {
  const connection = readConnection();
  if (!connection) throw new Error("Not connected");

  if (tokenCache && tokenCache.expiresAt > Date.now() + 5000) {
    return tokenCache.accessToken;
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: connection.clientId,
    client_secret: connection.clientSecret,
  });
  const response = await fetch(`${BLOCKS_IAM_URL}/api/oidc/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Blocks-Key": connection.xBlocksKey,
    },
    body,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.accessToken) {
    throw new Error(`Token request failed: HTTP ${response.status} ${JSON.stringify(data)}`);
  }
  tokenCache = {
    accessToken: data.accessToken,
    expiresAt: Date.now() + Number(data.expiresIn || 3300) * 1000,
  };
  return tokenCache.accessToken;
}

// ───────────────────────── Test calls ─────────────────────────
// Exercises the connected credential against Blocks Localization, so the permission boundary
// each template grants (see blocks-os/server/seed/integration-templates.json) can be proven
// from a browser click, not just curl.

const TEST_CALLS = {
  "keys-list": {
    method: "POST",
    path: "/Key/Gets",
    body: { pageSize: 5, pageNumber: 0 },
    expect: "should succeed on Read and Full",
  },
  "save-keys": {
    method: "POST",
    path: "/Key/SaveKeys",
    body: [],
    // The empty list is deliberate: it proves the permission check without writing anything.
    // Localization answers 200 with "Keys list cannot be null or empty" when the permission
    // passed. Use "Add keys" to save real ones.
    expect: "200 on Full (body: \"list cannot be empty\" = permission OK), 403 on Read",
  },
  "delete-collections": {
    method: "POST",
    path: "/Key/DeleteCollections",
    body: {},
    expect: "should be 403 on both templates — not granted to any integration",
  },
};

app.get("/api/test-calls", (req, res) => {
  res.json(Object.entries(TEST_CALLS).map(([id, call]) => ({ id, method: call.method, path: call.path, expect: call.expect })));
});

app.post("/api/test-call/:id", async (req, res) => {
  const call = TEST_CALLS[req.params.id];
  if (!call) return res.status(404).json({ error: "unknown_test_call" });

  const connection = readConnection();
  if (!connection) return res.status(400).json({ error: "not_connected" });

  try {
    const token = await getAccessToken();
    const response = await fetch(`${connection.baseUrl}${call.path}`, {
      method: call.method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "X-Blocks-Key": connection.xBlocksKey,
      },
      body: call.body !== undefined ? JSON.stringify(call.body) : undefined,
    });
    const text = await response.text();
    res.json({ status: response.status, ok: response.ok, expect: call.expect, body: safeJson(text) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ───────────────────────── Localization data (modules, languages, add keys) ─────────────────────────
// Uses the same connected credential as the test calls. Modules and languages only need a valid
// token ([Authorize] in blocks-localization), so they work on both Read and Full. Saving keys
// needs blocks-localization::key::savekeys, which only the Full template grants.

async function callLocalization(method, pathWithQuery, body) {
  const connection = readConnection();
  if (!connection) {
    const error = new Error("not_connected");
    error.status = 400;
    throw error;
  }
  const token = await getAccessToken();
  const response = await fetch(`${connection.baseUrl}${pathWithQuery}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "X-Blocks-Key": connection.xBlocksKey,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, ok: response.ok, body: safeJson(await response.text()) };
}

function sendError(res, err) {
  res.status(err.status || 500).json({ error: err.message });
}

app.get("/api/localization/modules", async (req, res) => {
  try {
    const result = await callLocalization("GET", "/Module/GetModulesForCurrentTenant");
    const modules = Array.isArray(result.body)
      ? result.body.map((m) => ({ id: m.itemId, name: m.moduleName || m.name || m.itemId }))
      : [];
    res.status(result.ok ? 200 : result.status).json({ ...result, modules });
  } catch (err) {
    sendError(res, err);
  }
});

// Body: { moduleName }. Maps to blocks-localization's SaveModuleRequest ({ itemId?, moduleName });
// via Module/Save, which needs blocks-localization::module::save. The current Full template
// grants it; Read does not (see blocks-os/server/seed/integration-templates.json).
app.post("/api/localization/modules", async (req, res) => {
  const moduleName = typeof req.body?.moduleName === "string" ? req.body.moduleName.trim() : "";
  if (moduleName.length < 3 || moduleName.length > 100) {
    return res.status(400).json({ error: "Module name must be between 3 and 100 characters long." });
  }

  try {
    const result = await callLocalization("POST", "/Module/Save", { itemId: null, moduleName });
    res.status(result.status === 403 ? 403 : 200).json({ ...result, sent: { moduleName } });
  } catch (err) {
    sendError(res, err);
  }
});

app.get("/api/localization/languages", async (req, res) => {
  try {
    const result = await callLocalization("GET", "/Language/GetLanguagesForCurrentTenant");
    const languages = Array.isArray(result.body)
      ? result.body.map((l) => ({ code: l.languageCode, name: l.languageName, isDefault: !!l.isDefault }))
      : [];
    res.status(result.ok ? 200 : result.status).json({ ...result, languages });
  } catch (err) {
    sendError(res, err);
  }
});

// Body: { moduleId, publish?, keys: [{ keyName, context?, values: { "<culture>": "<text>" } }] }
// Maps to blocks-localization's Key model (Eurolm.DomainService/Services/Key/Key.cs):
// { KeyName, ModuleId, Resources: [{ Culture, Value, CharacterLength }], IsNewKey, ShouldPublish }.
app.post("/api/localization/keys", async (req, res) => {
  const { moduleId, keys, publish } = req.body || {};
  if (!moduleId || !Array.isArray(keys) || keys.length === 0) {
    return res.status(400).json({ error: "moduleId and at least one key are required" });
  }

  const payload = keys
    .filter((k) => k?.keyName?.trim())
    .map((k) => ({
      keyName: k.keyName.trim(),
      moduleId,
      context: k.context?.trim() || null,
      isNewKey: true,
      shouldPublish: !!publish,
      resources: Object.entries(k.values || {})
        .filter(([, value]) => typeof value === "string" && value.trim() !== "")
        .map(([culture, value]) => ({ culture, value, characterLength: value.length })),
    }));
  if (payload.length === 0) return res.status(400).json({ error: "every key needs a name" });

  try {
    const result = await callLocalization("POST", "/Key/SaveKeys", payload);
    res.status(result.status === 403 ? 403 : 200).json({ ...result, sent: payload });
  } catch (err) {
    sendError(res, err);
  }
});

// ───────────────────────── Serve the built React app ─────────────────────────
// Only used by `npm start` (production-style, single origin). During `npm run dev` the React
// app runs on its own Vite dev server and proxies /api, /connect, /callback here instead.

const clientDist = path.join(__dirname, "..", "client", "dist");
app.use(express.static(clientDist));
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api") || req.path === "/connect" || req.path === "/callback") return next();
  res.sendFile(path.join(clientDist, "index.html"), (err) => {
    if (err) next();
  });
});

app.listen(PORT, () => {
  console.log(`Fake CMS test harness listening on ${APP_ORIGIN}`);
  console.log(`Will redirect to blocks-os at ${BLOCKS_OS_URL}/connect`);
});
