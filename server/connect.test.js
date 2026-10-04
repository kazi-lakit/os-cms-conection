import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

async function availablePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForServer(origin, process) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (process.exitCode !== null) throw new Error("Harness server exited before starting");
    try {
      const response = await fetch(`${origin}/api/status`);
      if (response.ok) return;
    } catch {
      // The server has not started listening yet.
    }
    await delay(50);
  }
  throw new Error("Harness server did not start");
}

test("callback validates state on cancellation and consumes the pending attempt", async (t) => {
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["index.js"], {
    cwd: new URL(".", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      APP_ORIGIN: origin,
      BLOCKS_OS_URL: "http://127.0.0.1:1",
      BLOCKS_IAM_URL: "http://127.0.0.1:1",
    },
    stdio: "ignore",
  });
  t.after(() => server.kill());
  await waitForServer(origin, server);

  async function startAttempt() {
    const response = await fetch(`${origin}/connect`, { redirect: "manual" });
    assert.equal(response.status, 302);
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);
    const state = new URL(response.headers.get("location")).searchParams.get("state");
    assert.ok(state);
    return { cookie, state };
  }

  async function cancel(cookie, state) {
    return fetch(`${origin}/callback?error=access_denied&state=${encodeURIComponent(state)}`, {
      headers: { Cookie: cookie },
      redirect: "manual",
    });
  }

  const mismatched = await startAttempt();
  const badResponse = await cancel(mismatched.cookie, "wrong-state");
  assert.equal(badResponse.headers.get("location"), "/?error=state_mismatch");

  const valid = await startAttempt();
  const goodResponse = await cancel(valid.cookie, valid.state);
  assert.equal(goodResponse.headers.get("location"), "/?error=access_denied");

  const replayResponse = await cancel(valid.cookie, valid.state);
  assert.equal(replayResponse.headers.get("location"), "/?error=session_lost_or_expired");
});

test("a duplicate callback reuses the first exchange instead of redeeming the code twice", async (t) => {
  // Stands in for blocks-os's Exchange endpoint: slow enough for the second callback to arrive
  // while the first is still in flight, and a one-time code like the real thing.
  const http = await import("node:http");
  const os = await import("node:os");
  const fs = await import("node:fs");
  const path = await import("node:path");
  let exchangeCalls = 0;
  const fakeBlocksOs = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      exchangeCalls += 1;
      const first = exchangeCalls === 1;
      await delay(300);
      res.writeHead(first ? 200 : 400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify(
          first
            ? { clientId: "client-1", clientSecret: "secret-1", xBlocksKey: "D123", baseUrl: "http://127.0.0.1:1", domain: "", templateKey: "localization-read", accessLevel: "read" }
            : { errors: { invalid_code: "The code is invalid, expired or already used." } },
        ),
      );
    });
  });
  await new Promise((resolve) => fakeBlocksOs.listen(0, "127.0.0.1", resolve));
  t.after(() => fakeBlocksOs.close());

  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-cms-"));
  t.after(() => fs.rmSync(storeDir, { recursive: true, force: true }));

  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["index.js"], {
    cwd: new URL(".", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      APP_ORIGIN: origin,
      BLOCKS_OS_URL: `http://127.0.0.1:${fakeBlocksOs.address().port}`,
      BLOCKS_IAM_URL: "http://127.0.0.1:1",
      CONNECTION_STORE_PATH: path.join(storeDir, "connection.json"),
    },
    stdio: "ignore",
  });
  t.after(() => server.kill());
  await waitForServer(origin, server);

  const start = await fetch(`${origin}/connect`, { redirect: "manual" });
  const cookie = start.headers.get("set-cookie")?.split(";")[0];
  const state = new URL(start.headers.get("location")).searchParams.get("state");
  const callbackUrl = `${origin}/callback?code=one-time-code&state=${encodeURIComponent(state)}&blocks_key=ROOT`;
  const load = () => fetch(callbackUrl, { headers: { Cookie: cookie }, redirect: "manual" });

  // The click and the auto-redirect, a moment apart.
  const first = load();
  await delay(50);
  const second = load();
  const [firstResponse, secondResponse] = await Promise.all([first, second]);

  assert.equal(exchangeCalls, 1);
  assert.equal(firstResponse.headers.get("location"), "/?connected=1");
  assert.equal(secondResponse.headers.get("location"), "/?connected=1");
});
