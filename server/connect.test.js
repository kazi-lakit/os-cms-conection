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
