import { useCallback, useEffect, useState } from "react";
import "./App.css";

/**
 * Stands in for a WordPress (or any CMS) plugin's settings page. This component only ever
 * talks to this app's own backend (/api/*, /connect) — never directly to blocks-os or IAM,
 * and it never receives the client secret. See ../../README.md.
 */
export default function App() {
  const [status, setStatus] = useState(null);
  const [banner, setBanner] = useState(null);
  const [testCalls, setTestCalls] = useState([]);
  const [results, setResults] = useState({});
  const [busy, setBusy] = useState(null);
  const [moduleResult, setModuleResult] = useState(null);
  const [moduleBusy, setModuleBusy] = useState(false);

  const loadStatus = useCallback(async () => {
    const response = await fetch("/api/status");
    setStatus(await response.json());
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("connected")) setBanner({ kind: "success", text: "Connected successfully." });
    if (params.get("error")) setBanner({ kind: "error", text: `Connect failed: ${params.get("error")}` });
    if (params.toString()) window.history.replaceState(null, "", "/");

    loadStatus();
    fetch("/api/test-calls")
      .then((response) => response.json())
      .then(setTestCalls);
  }, [loadStatus]);

  const disconnect = async () => {
    setBusy("disconnect");
    await fetch("/api/disconnect", { method: "POST" });
    setResults({});
    await loadStatus();
    setBusy(null);
  };

  const runTestCall = async (id) => {
    setBusy(id);
    const response = await fetch(`/api/test-call/${id}`, { method: "POST" });
    const data = await response.json();
    setResults((previous) => ({ ...previous, [id]: data }));
    setBusy(null);
  };

  const createModule = async (moduleName) => {
    setModuleBusy(true);
    const response = await fetch("/api/localization/modules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ moduleName }),
    });
    setModuleResult(await response.json().catch(() => ({ error: "invalid_response" })));
    setModuleBusy(false);
  };

  return (
    <>
      <div className="backdrop" aria-hidden="true">
        <div className="blob blob-a" />
        <div className="blob blob-b" />
        <div className="blob blob-c" />
        <div className="particles">
          {Array.from({ length: 16 }, (_, i) => (
            <span key={i} style={{ left: `${(i * 6.3 + 3) % 100}%`, animationDelay: `${(i % 8) * -4}s`, animationDuration: `${16 + (i % 5) * 6}s` }} />
          ))}
        </div>
      </div>
      <div className="grid-overlay" aria-hidden="true" />

      <div className="page">
        <header className="header">
          <div className="logo" aria-hidden="true">
            <HexIcon size={26} />
          </div>
          <h1 className="title">
            <span className="title-text">Fake CMS</span>
            <span className="title-badge">Blocks Integration</span>
          </h1>
        </header>
        <p className="lead">
          Stands in for a WordPress (or any CMS) plugin: this page drives the &quot;Connect with
          Blocks&quot; redirect, and this app&apos;s own tiny backend does the code-for-secret exchange —
          exactly like a real plugin&apos;s PHP would. The browser never sees the client secret.
        </p>

        {banner && <div className={`banner banner-${banner.kind === "error" ? "error" : "success"}`}>{banner.text}</div>}

        {status === null ? (
          <Loading />
        ) : status.connected ? (
          <Connected status={status} onDisconnect={disconnect} busy={busy === "disconnect"} />
        ) : (
          <NotConnected />
        )}

        {status?.connected && (
          <TestCalls testCalls={testCalls} results={results} busy={busy} onRun={runTestCall} />
        )}

        {status?.connected && (
          <CreateModule onCreate={createModule} busy={moduleBusy} result={moduleResult} />
        )}

        {status?.connected && <AddKeys accessLevel={status.accessLevel} />}
      </div>
    </>
  );
}

function HexIcon({ size = 24 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 2.5 20.2 7.25v9.5L12 21.5 3.8 16.75v-9.5L12 2.5Z"
        stroke="url(#hex-stroke)"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="2.2" fill="url(#hex-core)" />
      <path d="M12 14.2v4" stroke="url(#hex-stroke)" strokeWidth="1.2" strokeLinecap="round" opacity="0.6" />
      <defs>
        <linearGradient id="hex-stroke" x1="3" y1="3" x2="21" y2="21">
          <stop stopColor="#a78bfa" />
          <stop offset="1" stopColor="#22d3ee" />
        </linearGradient>
        <radialGradient id="hex-core">
          <stop stopColor="#22d3ee" />
          <stop offset="1" stopColor="#8b5cf6" />
        </radialGradient>
      </defs>
    </svg>
  );
}

function LinkIcon({ size = 30 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M10 14a5 5 0 0 0 7.07 0l2.12-2.12a5 5 0 0 0-7.07-7.07L10.7 6.06"
        stroke="url(#link-stroke)"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path
        d="M14 10a5 5 0 0 0-7.07 0l-2.12 2.12a5 5 0 0 0 7.07 7.07l1.42-1.25"
        stroke="url(#link-stroke)"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <defs>
        <linearGradient id="link-stroke" x1="4" y1="4" x2="20" y2="20">
          <stop stopColor="#a78bfa" />
          <stop offset="1" stopColor="#22d3ee" />
        </linearGradient>
      </defs>
    </svg>
  );
}

function Loading() {
  return (
    <div className="card skeleton-card">
      <div className="spinner" />
      <p className="skeleton-text">Establishing secure channel</p>
    </div>
  );
}

function NotConnected() {
  return (
    <div className="card connect-hero">
      <div className="connect-orb" aria-hidden="true">
        <LinkIcon />
      </div>
      <h2 className="card-title" style={{ justifyContent: "center" }}>
        <span className="dot dot-off" /> Not connected
      </h2>
      <p>Authenticate with Blocks Localization to begin exchanging credentials.</p>
      {/* A real page load, not a fetch: /connect is the start of a browser redirect chain. */}
      <a href="/connect">
        <button className="btn btn-primary">Connect with Blocks</button>
      </a>
    </div>
  );
}

function Connected({ status, onDisconnect, busy }) {
  return (
    <div className="card">
      <h2 className="card-title">
        <span className="dot dot-on" /> Connected
      </h2>
      <dl className="rows">
        <Row label="Template" value={`${status.templateKey} (${status.accessLevel})`} />
        <Row label="Client ID" value={status.clientId} />
        <Row label="Client secret" value={status.clientSecretMasked} />
        <Row label="X-Blocks-Key (environment)" value={status.xBlocksKey} />
        <Row label="Base URL" value={status.baseUrl} />
        <Row label="Domain" value={status.domain} />
        <Row label="Connected at" value={status.connectedAt} />
      </dl>
      <button className="btn btn-danger" onClick={onDisconnect} disabled={busy}>
        {busy ? "Disconnecting…" : "Disconnect (local only)"}
      </button>
      <p className="note">
        This only forgets the credential in this test app. To revoke it in Blocks OS itself, use
        Disconnect on the Integration page there.
      </p>
    </div>
  );
}

function CubeIcon({ size = 26 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 3 20 7.4v9.2L12 21l-8-4.4V7.4L12 3Z"
        stroke="url(#cube-stroke)"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path d="M4 7.4 12 11.8l8-4.4M12 11.8V21" stroke="url(#cube-stroke)" strokeWidth="1.2" strokeLinejoin="round" opacity="0.6" />
      <defs>
        <linearGradient id="cube-stroke" x1="4" y1="3" x2="20" y2="21">
          <stop stopColor="#a78bfa" />
          <stop offset="1" stopColor="#22d3ee" />
        </linearGradient>
      </defs>
    </svg>
  );
}

function TestCalls({ testCalls, results, busy, onRun }) {
  return (
    <div className="card">
      <h2 className="card-title">Test calls</h2>
      <p className="note" style={{ marginTop: 0, marginBottom: 18 }}>
        Proves the permission boundary the template grants. Compare results between a Read
        connection and a Full connection.
      </p>
      {testCalls.map((call, index) => (
        <div key={call.id} className="test-row" style={{ animationDelay: `${index * 0.07}s` }}>
          <div className="test-head">
            <span className={`method method-${call.method.toLowerCase()}`}>{call.method}</span>
            <span className="path">{call.path}</span>
            <span className="expect">{call.expect}</span>
            <span className="test-actions">
              <button className="btn" onClick={() => onRun(call.id)} disabled={busy === call.id}>
                {busy === call.id ? "Calling…" : "Run"}
              </button>
            </span>
          </div>
          {results[call.id] && (
            <pre className="pre">{JSON.stringify(results[call.id], null, 2)}</pre>
          )}
        </div>
      ))}
    </div>
  );
}

const emptyKey = () => ({ id: crypto.randomUUID(), keyName: "", context: "", values: {} });

/**
 * Saves real keys through the connected credential (POST /api/localization/keys, which this
 * app's backend turns into blocks-localization's Key/SaveKeys). Needs the Full template; on a
 * Read connection the save comes back 403, which is the expected result.
 */
function AddKeys({ accessLevel }) {
  const [modules, setModules] = useState([]);
  const [languages, setLanguages] = useState([]);
  const [loadError, setLoadError] = useState(null);
  const [moduleId, setModuleId] = useState("");
  const [keys, setKeys] = useState([emptyKey()]);
  const [publish, setPublish] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null);

  const [loaded, setLoaded] = useState(false);

  const loadOptions = useCallback(() => {
    setLoaded(false);
    setLoadError(null);
    Promise.all([
      fetch("/api/localization/modules").then((r) => r.json()),
      fetch("/api/localization/languages").then((r) => r.json()),
    ])
      .then(([m, l]) => {
        setModules(m.modules || []);
        setLanguages(l.languages || []);
        setModuleId((current) => current || m.modules?.[0]?.id || "");
        if (!m.ok || !l.ok) setLoadError(`Modules: HTTP ${m.status ?? "?"}, languages: HTTP ${l.status ?? "?"}`);
      })
      .catch((err) => setLoadError(err.message))
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    loadOptions();
  }, [loadOptions]);

  const updateKey = (id, patch) => setKeys((all) => all.map((k) => (k.id === id ? { ...k, ...patch } : k)));
  const updateValue = (id, code, value) =>
    setKeys((all) => all.map((k) => (k.id === id ? { ...k, values: { ...k.values, [code]: value } } : k)));

  const canSave = moduleId && keys.some((k) => k.keyName.trim().length >= 2) && !saving;

  const save = async () => {
    setSaving(true);
    setResult(null);
    try {
      const response = await fetch("/api/localization/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ moduleId, publish, keys: keys.map(({ id, ...rest }) => rest) }),
      });
      const data = await response.json();
      setResult(data);
      if (data.ok && data.body?.success !== false) setKeys([emptyKey()]);
    } catch (err) {
      setResult({ error: err.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card">
      <h2 className="card-title">Add keys</h2>
      <p className="note" style={{ marginTop: 0, marginBottom: 18 }}>
        Saves new keys to Blocks Localization with this connection.{" "}
        {accessLevel === "read"
          ? "This is a Read connection, so saving should fail with 403 — that's the expected result."
          : "Needs the Full template (key::savekeys)."}
      </p>

      {loadError && <div className="banner banner-error">Could not load modules or languages: {loadError}</div>}

      {loaded && !loadError && modules.length === 0 && (
        <div className="banner banner-error">
          This environment has no localization modules yet, and every key must belong to one.
          A Full connection can create a module below; a Read connection cannot. Then reload
          the module list.{" "}
          <button className="btn btn-small" onClick={loadOptions}>
            Reload
          </button>
        </div>
      )}

      <label className="field">
        <span className="field-label">Module</span>
        <select className="input" value={moduleId} onChange={(e) => setModuleId(e.target.value)}>
          {modules.length === 0 && <option value="">No modules found</option>}
          {modules.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </label>

      {keys.map((key, index) => (
        <div key={key.id} className="key-row">
          <div className="key-row-head">
            <span className="field-label">Key {index + 1}</span>
            {keys.length > 1 && (
              <button className="btn btn-small" onClick={() => setKeys((all) => all.filter((k) => k.id !== key.id))}>
                Remove
              </button>
            )}
          </div>
          <input
            className="input"
            placeholder="Key name, e.g. HOME_PAGE_TITLE (2–100 characters)"
            value={key.keyName}
            maxLength={100}
            onChange={(e) => updateKey(key.id, { keyName: e.target.value })}
          />
          {languages.map((lang) => (
            <input
              key={lang.code}
              className="input"
              placeholder={`${lang.name} (${lang.code})${lang.isDefault ? " — default" : ""}`}
              value={key.values[lang.code] || ""}
              onChange={(e) => updateValue(key.id, lang.code, e.target.value)}
            />
          ))}
          <input
            className="input"
            placeholder="Context (optional) — helps translators"
            value={key.context}
            onChange={(e) => updateKey(key.id, { context: e.target.value })}
          />
        </div>
      ))}

      <div className="key-actions">
        <button className="btn" onClick={() => setKeys((all) => [...all, emptyKey()])}>
          + Add another key
        </button>
        <label className="checkbox">
          <input type="checkbox" checked={publish} onChange={(e) => setPublish(e.target.checked)} />
          Publish after saving
        </label>
        <button className="btn btn-primary" onClick={save} disabled={!canSave}>
          {saving ? "Saving…" : `Save ${keys.length > 1 ? `${keys.length} keys` : "key"}`}
        </button>
      </div>

      {result && <pre className="pre">{JSON.stringify(result, null, 2)}</pre>}
    </div>
  );
}

function CreateModule({ onCreate, busy, result }) {
  const [name, setName] = useState("");

  const submit = async (event) => {
    event.preventDefault();
    if (!name.trim() || busy) return;
    onCreate(name.trim());
  };

  return (
    <div className="card">
      <h2 className="card-title">
        <CubeIcon size={18} /> Create module
      </h2>
      <p className="note" style={{ marginTop: 0, marginBottom: 16 }}>
        Saves a module through <span className="inline-code">Module/Save</span>. The Full template
        grants <span className="inline-code">module::save</span>; Read should return 403.
      </p>
      <form className="module-form" onSubmit={submit}>
        <input
          className="input"
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Module name (3–100 characters)"
          minLength={3}
          maxLength={100}
          disabled={busy}
        />
        <button className="btn" type="submit" disabled={busy || name.trim().length < 3}>
          {busy ? "Creating…" : "Create"}
        </button>
      </form>
      {result && <pre className="pre">{JSON.stringify(result, null, 2)}</pre>}
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div className="row">
      <dt className="row-label">{label}</dt>
      <dd className="row-value">{value}</dd>
    </div>
  );
}
