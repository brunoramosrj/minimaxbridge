import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "../core/config.ts";

export interface MiniMaxSession {
  token: string;
  cookie?: string;
  uuid: string;
  deviceId: string;
  realUserId?: string;
  accountDeviceId?: string;
  agentName?: string;
  updatedAt: string;
}

function md5(value: string): string {
  return crypto.createHash("md5").update(value).digest("hex");
}

function tokenUserId(token: string): string {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return String(payload?.user?.id || payload?.sub || "0");
  } catch {
    return "0";
  }
}

export function saveSession(session: MiniMaxSession): void {
  const sessionPath = path.resolve(process.cwd(), config.minimax.sessionPath);
  fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2), { mode: 0o600 });
  console.log(`[MiniMax Auth] Session saved to ${sessionPath}`);
}

export function loadSession(): MiniMaxSession | null {
  const sessionPath = path.resolve(process.cwd(), config.minimax.sessionPath);
  if (!fs.existsSync(sessionPath)) return null;
  try {
    const session = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
    if (typeof session?.token === "string" && session.token.split(".").length === 3) {
      return session;
    }
  } catch {}
  return null;
}

export function isSessionValid(session: MiniMaxSession): boolean {
  try {
    const payload = JSON.parse(Buffer.from(session.token.split(".")[1], "base64url").toString("utf8"));
    if (payload?.exp && Number(payload.exp) * 1000 <= Date.now()) return false;
    return true;
  } catch {
    return false;
  }
}

export async function loginFromHar(): Promise<MiniMaxSession | null> {
  const harPath = path.resolve(process.cwd(), config.minimax.harPath);
  if (!fs.existsSync(harPath)) return null;

  try {
    const har = JSON.parse(fs.readFileSync(harPath, "utf8"));
    for (const entry of har?.log?.entries || []) {
      const url = String(entry?.request?.url || "");
      if (!url.includes("agent.minimax.io/")) continue;

      const headers = entry?.request?.headers || [];
      const query = entry?.request?.queryString || [];
      const headerToken = headers.find((item: any) => String(item?.name).toLowerCase() === "token")?.value;
      const queryValue = (name: string) => query.find((item: any) => item?.name === name)?.value;
      const token = headerToken || queryValue("token");

      if (typeof token === "string" && token.split(".").length === 3) {
        const uuid = queryValue("uuid");
        const deviceId = queryValue("device_id");
        if (!uuid || !deviceId) continue;

        console.log(`[MiniMax Auth] Extracted session from HAR: ${harPath}`);
        console.log(`[MiniMax Auth] User ID: ${tokenUserId(token)}`);

        const session: MiniMaxSession = {
          token,
          cookie: "",
          uuid,
          deviceId,
          realUserId: queryValue("user_id") || tokenUserId(token),
          accountDeviceId: deviceId,
          updatedAt: new Date().toISOString(),
        };

        saveSession(session);
        return session;
      }
    }
  } catch (error) {
    console.warn(`[MiniMax Auth] Failed to read HAR: ${error instanceof Error ? error.message : String(error)}`);
  }
  return null;
}

export async function loginFromCredentials(): Promise<MiniMaxSession | null> {
  const email = process.env.MINIMAX_EMAIL?.trim();
  const password = process.env.MINIMAX_PASSWORD;

  if (!email || !password) {
    console.error("[MiniMax Auth] MINIMAX_EMAIL and MINIMAX_PASSWORD not set in .env");
    return null;
  }

  const publicKey = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDF5ndG2/UB4L5tbvQaNLHSoBTW
DKbrNBuOmUIP23eCmC2ELMx3kppEikxTp5cV8NxUZl6ii+KLwKugioAXApzypHXb
gXbq13kTKA7OCA1xtAoMdH9cltjBiFAUJlgmVjr0MuJCknhVAjWLjCVRHege+Atl
gkUBUeGa9O+cWcPEwQIDAQAB
-----END PUBLIC KEY-----`;

  const uuid = crypto.randomUUID();
  let deviceId = "0";
  const agentDeviceId = String(10_000_000 + crypto.randomInt(90_000_000));
  const jar = new Map<string, string>();

  function absorbCookies(response: Response) {
    for (const cookie of response.headers.getSetCookie?.() || []) {
      const pair = cookie.split(";", 1)[0];
      const separator = pair.indexOf("=");
      if (separator > 0) jar.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
  }

  function cookieHeader() {
    return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  function params(now: number, token = "", realUserId = "") {
    return {
      device_platform: "web", biz_id: "3", app_id: "3001", version_code: "22201",
      unix: String(now), timezone_offset: String(-new Date().getTimezoneOffset() * 60),
      lang: "en", sys_language: "en", uuid, device_id: deviceId, os_name: "Linux",
      browser_name: "Chrome", browser_language: "en-US", browser_platform: "Linux x86_64",
      screen_width: "1920", screen_height: "1080", ...(token ? { user_id: realUserId || tokenUserId(token), token } : {}), client: "web",
    };
  }

  function signed(path: string, method: string, body: unknown, token = "", realUserId = "") {
    const now = Math.floor(Date.now() / 1000) * 1000;
    const query = new URLSearchParams(params(now, token, realUserId)).toString();
    const bodyText = JSON.stringify(body);
    const timestamp = String(now / 1000);
    const yyBody = method.toLowerCase() === "post" ? bodyText : "{}";
    return {
      query, bodyText,
      headers: {
        "Content-Type": "application/json", Accept: "application/json, text/plain, */*",
        Origin: "https://account.minimax.io", Referer: "https://account.minimax.io/",
        ...(token ? { token } : {}), yy: md5(`${encodeURIComponent(`${path}?${query}`)}_${yyBody}${md5(String(now))}ooui`),
        "x-timestamp": timestamp, "x-signature": md5(`${timestamp}I*7Cf%WZ#S&%1RlZJ&C2${bodyText}`),
      },
    };
  }

  async function accountLogin(authToken: string | null, loginRedirect: string) {
    const body = { loginType: "20", email, authToken, ...(authToken ? { countryCode: "+86" } : {}), deviceID: deviceId, login_redirect: loginRedirect };
    const request = signed("/oauth2/login", "POST", body);
    const response = await fetch(`https://account.minimax.io/oauth2/login?${request.query}`, { method: "POST", headers: request.headers, body: request.bodyText, redirect: "manual" });
    absorbCookies(response);
    const data = await response.json();
    if (!response.ok || data?.statusInfo?.code || data?.base_resp?.status_code) throw new Error(data?.statusInfo?.message || data?.base_resp?.status_msg || `Login failed (${response.status})`);
    return data?.data;
  }

  async function registerDevice() {
    const body = { uuid };
    const request = signed("/v1/api/user/device/register", "POST", body);
    const response = await fetch(`https://account.minimax.io/v1/api/user/device/register?${request.query}`, { method: "POST", headers: request.headers, body: request.bodyText });
    const data = await response.json();
    const registered = data?.data?.deviceIDStr || data?.data?.deviceID;
    if (!response.ok || !registered) throw new Error(data?.statusInfo?.message || "MiniMax device registration failed");
    deviceId = String(registered);
  }

  try {
    const state = Buffer.from(JSON.stringify({ redirect_uri: "https://agent.minimax.io/", csrf: crypto.randomUUID() })).toString("base64");
    const loginRedirect = `/oauth2/authorize?${new URLSearchParams({ client_id: "agent-minimax", redirect_uri: "https://agent.minimax.io/auth/callback", response_type: "code", source: "agent_web", state })}`;

    console.log("[MiniMax Auth] Checking MiniMax account...");
    await registerDevice();
    await accountLogin(null, loginRedirect);
    const encryptedPassword = crypto.publicEncrypt({ key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(password)).toString("base64");
    console.log("[MiniMax Auth] Authenticating...");
    const login = await accountLogin(encryptedPassword, loginRedirect);
    const realUserId = String(login?.str_biz_uid || "");
    if (!realUserId) throw new Error("MiniMax login did not return str_biz_uid");

    let url = new URL(login.login_redirect, "https://account.minimax.io").href;
    for (let redirects = 0; redirects < 5; redirects++) {
      const response = await fetch(url, { headers: { cookie: cookieHeader() }, redirect: "manual" });
      absorbCookies(response);
      const location = response.headers.get("location");
      if (!location) break;
      url = new URL(location, url).href;
    }

    const initialToken = jar.get("_token");
    if (!initialToken) throw new Error("MiniMax OAuth callback did not return a session token");
    const renewalBody = {};
    const renewal = signed("/v1/api/user/renewal", "POST", renewalBody, initialToken, realUserId);
    renewal.headers.Origin = "https://agent.minimax.io";
    renewal.headers.Referer = "https://agent.minimax.io/";
    Object.assign(renewal.headers, { Cookie: cookieHeader() });
    const renewed = await fetch(`https://agent.minimax.io/v1/api/user/renewal?${renewal.query}`, { method: "POST", headers: renewal.headers, body: renewal.bodyText });
    const renewedData = await renewed.json();
    const token = renewedData?.data?.token;
    if (!renewed.ok || !token) throw new Error(renewedData?.statusInfo?.message || "MiniMax token renewal failed");

    const session: MiniMaxSession = {
      token,
      cookie: cookieHeader(),
      uuid,
      deviceId: agentDeviceId,
      realUserId,
      accountDeviceId: deviceId,
      updatedAt: new Date().toISOString(),
    };

    console.log(`[MiniMax Auth] User ID: ${tokenUserId(token)}`);
    saveSession(session);
    return session;
  } catch (error) {
    console.error(`[MiniMax Auth] Credential login failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export async function loginViaHttpDirect(): Promise<MiniMaxSession | null> {
  const token = process.env.MINIMAX_TOKEN?.trim();
  const uuid = process.env.MINIMAX_UUID?.trim();
  const deviceId = process.env.MINIMAX_DEVICE_ID?.trim();

  if (!token || !uuid || !deviceId) {
    console.error("[MiniMax Auth] MINIMAX_TOKEN, MINIMAX_UUID, and MINIMAX_DEVICE_ID must be set in .env");
    return null;
  }

  const session: MiniMaxSession = {
    token,
    cookie: "",
    uuid,
    deviceId,
    updatedAt: new Date().toISOString(),
  };

  console.log(`[MiniMax Auth] Using direct HTTP auth from environment`);
  console.log(`[MiniMax Auth] User ID: ${tokenUserId(token)}`);
  saveSession(session);
  return session;
}

export async function performLogin(): Promise<MiniMaxSession | null> {
  console.log("[MiniMax Auth] Attempting login methods...\n");

  console.log("Method 1: HAR file");
  let session = await loginFromHar();
  if (session && isSessionValid(session)) return session;

  console.log("\nMethod 2: Credentials from .env");
  session = await loginFromCredentials();
  if (session && isSessionValid(session)) return session;

  console.log("\nMethod 3: Direct HTTP (environment variables)");
  session = await loginViaHttpDirect();
  if (session && isSessionValid(session)) return session;

  console.error("\n[MiniMax Auth] All login methods failed");
  return null;
}
