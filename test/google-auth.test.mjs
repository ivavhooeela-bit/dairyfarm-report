import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createGoogleAuthStore, validateGoogleOAuthClient } from "../lib/google-auth.mjs";

const client = {
  installed: {
    client_id: "123-example.apps.googleusercontent.com",
    project_id: "dairyfarm-test",
    auth_uri: "https://accounts.google.com/o/oauth2/auth",
    token_uri: "https://oauth2.googleapis.com/token",
    client_secret: "not-a-real-secret",
    redirect_uris: ["http://localhost"]
  }
};

test("accepts a Desktop app OAuth JSON and rejects a Web client", () => {
  assert.equal(validateGoogleOAuthClient(client).installed.project_id, "dairyfarm-test");
  assert.throws(() => validateGoogleOAuthClient({ web: client.installed }), /Desktop app/);
});

test("imports credentials, creates a PKCE authorization URL and stores tokens", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dairyfarm-google-auth-"));
  const calls = [];
  const store = createGoogleAuthStore(root, {
    port: 8787,
    fetchImpl: async (url, options) => {
      calls.push({ url, body: String(options.body) });
      return { ok: true, json: async () => ({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }) };
    },
    now: () => 1_000_000
  });
  const imported = await store.importClient(client);
  assert.equal(imported.configured, true);
  assert.equal(imported.connected, false);
  assert.equal(imported.projectId, "dairyfarm-test");
  assert.match(imported.clientIdSuffix, /googleusercontent\.com$/);
  const started = await store.beginAuthorization();
  const url = new URL(started.authorizationUrl);
  assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:8787/api/google/oauth/callback");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.match(url.searchParams.get("scope"), /presentations/);
  await store.handleCallback({ state: url.searchParams.get("state"), code: "authorization-code" });
  assert.equal((await store.status()).connected, true);
  assert.match(calls[0].body, /code_verifier=/);
  assert.equal(await store.accessToken(), "access");
  await store.disconnect();
  assert.equal((await store.status()).connected, false);
});
