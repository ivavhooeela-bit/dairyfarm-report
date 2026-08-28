import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/presentations",
  "https://www.googleapis.com/auth/spreadsheets"
];

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`В OAuth JSON отсутствует ${label}`);
  return value.trim();
}

export function validateGoogleOAuthClient(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("OAuth JSON должен содержать объект");
  }
  if (!value.installed || typeof value.installed !== "object") {
    throw new Error("Нужен OAuth-клиент типа Desktop app (секция installed)");
  }
  const client = value.installed;
  const clientId = requiredString(client.client_id, "client_id");
  if (!clientId.endsWith(".apps.googleusercontent.com")) {
    throw new Error("Некорректный Google OAuth client_id");
  }
  const authUri = requiredString(client.auth_uri, "auth_uri");
  const tokenUri = requiredString(client.token_uri, "token_uri");
  if (!authUri.startsWith("https://accounts.google.com/")) throw new Error("Некорректный auth_uri");
  if (!tokenUri.startsWith("https://oauth2.googleapis.com/")) throw new Error("Некорректный token_uri");
  return {
    installed: {
      client_id: clientId,
      project_id: typeof client.project_id === "string" ? client.project_id : "",
      auth_uri: authUri,
      token_uri: tokenUri,
      client_secret: requiredString(client.client_secret, "client_secret"),
      redirect_uris: Array.isArray(client.redirect_uris)
        ? client.redirect_uris.filter((item) => typeof item === "string")
        : []
    }
  };
}

async function readJsonOrNull(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writePrivateJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, filePath);
}

function googleError(data, fallback) {
  return data?.error_description || data?.error?.message || data?.error || fallback;
}

export function createGoogleAuthStore(rootDir, { port = 8787, fetchImpl = fetch, now = () => Date.now() } = {}) {
  const localDir = path.join(rootDir, ".local", "google");
  const clientPath = path.join(localDir, "oauth-client.json");
  const tokenPath = path.join(localDir, "token.json");
  const redirectUri = `http://127.0.0.1:${port}/api/google/oauth/callback`;
  let pending = null;

  async function readClient() {
    const value = await readJsonOrNull(clientPath);
    return value ? validateGoogleOAuthClient(value) : null;
  }

  async function readToken() {
    return readJsonOrNull(tokenPath);
  }

  async function importClient(value) {
    const checked = validateGoogleOAuthClient(value);
    await writePrivateJson(clientPath, checked);
    await fs.rm(tokenPath, { force: true });
    pending = null;
    return status();
  }

  async function status() {
    const [client, token] = await Promise.all([readClient(), readToken()]);
    return {
      configured: Boolean(client),
      connected: Boolean(client && token?.refresh_token),
      projectId: client?.installed?.project_id || null,
      clientIdSuffix: client ? client.installed.client_id.slice(-24) : null
    };
  }

  async function beginAuthorization() {
    const client = await readClient();
    if (!client) throw new Error("Сначала импортируйте OAuth JSON");
    const state = crypto.randomBytes(24).toString("base64url");
    const verifier = crypto.randomBytes(48).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    pending = { state, verifier, createdAt: now() };
    const query = new URLSearchParams({
      client_id: client.installed.client_id,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: GOOGLE_SCOPES.join(" "),
      access_type: "offline",
      include_granted_scopes: "true",
      prompt: "consent select_account",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256"
    });
    return { authorizationUrl: `${client.installed.auth_uri}?${query}`, expiresInSeconds: 600 };
  }

  async function handleCallback({ state, code, error }) {
    if (error) throw new Error(`Google отклонил подключение: ${error}`);
    if (!pending || now() - pending.createdAt > 10 * 60 * 1000) {
      pending = null;
      throw new Error("Срок подключения истёк. Запустите подключение Google снова.");
    }
    if (!state || state !== pending.state) throw new Error("Некорректное состояние OAuth-запроса");
    if (!code) throw new Error("Google не вернул код авторизации");
    const client = await readClient();
    if (!client) throw new Error("OAuth JSON не настроен");
    const form = new URLSearchParams({
      client_id: client.installed.client_id,
      client_secret: client.installed.client_secret,
      code,
      code_verifier: pending.verifier,
      grant_type: "authorization_code",
      redirect_uri: redirectUri
    });
    pending = null;
    const response = await fetchImpl(client.installed.token_uri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form
    });
    const data = await response.json();
    if (!response.ok) throw new Error(googleError(data, "Не удалось получить Google OAuth token"));
    if (!data.refresh_token) {
      throw new Error("Google не вернул refresh token. Удалите доступ приложения в аккаунте Google и подключите его снова.");
    }
    await writePrivateJson(tokenPath, {
      ...data,
      obtained_at: now(),
      expires_at: now() + Number(data.expires_in || 3600) * 1000
    });
    return status();
  }

  async function accessToken() {
    const client = await readClient();
    const token = await readToken();
    if (!client || !token?.refresh_token) throw new Error("Google не подключён");
    if (token.access_token && Number(token.expires_at || 0) > now() + 60_000) return token.access_token;
    const form = new URLSearchParams({
      client_id: client.installed.client_id,
      client_secret: client.installed.client_secret,
      refresh_token: token.refresh_token,
      grant_type: "refresh_token"
    });
    const response = await fetchImpl(client.installed.token_uri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form
    });
    const data = await response.json();
    if (!response.ok) throw new Error(googleError(data, "Не удалось обновить Google OAuth token"));
    const updated = {
      ...token,
      ...data,
      refresh_token: token.refresh_token,
      obtained_at: now(),
      expires_at: now() + Number(data.expires_in || 3600) * 1000
    };
    await writePrivateJson(tokenPath, updated);
    return updated.access_token;
  }

  async function disconnect() {
    await fs.rm(tokenPath, { force: true });
    pending = null;
    return status();
  }

  return { accessToken, beginAuthorization, disconnect, handleCallback, importClient, status };
}
