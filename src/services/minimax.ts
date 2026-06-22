import crypto from "node:crypto";
import { config } from "../core/config.ts";
import { AuthError, UpstreamError, UpstreamTimeout } from "../core/errors.ts";
import { loadSession, isSessionValid, type MiniMaxSession } from "./auth-minimax.ts";

const WEB_BASE = "https://agent.minimax.io/archon/api";
const STREAM_BASE = "https://agent-stream.minimax.io/archon/api";
const SIGNATURE_SALT = "I*7Cf%WZ#S&%1RlZJ&C2";
const sessionByConversation = new Map<string, string>();
const processUuid = crypto.randomUUID();
const processDeviceId = String(10_000_000 + crypto.randomInt(90_000_000));
let cachedAgentName: string | undefined;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const MINIMAX_MODELS = [
  { id: "MiniMax-M3", context: 450_000 },
] as const;

export function listMiniMaxModels() {
  const created = Math.floor(Date.now() / 1000);
  return MINIMAX_MODELS.map((model) => ({
    id: model.id,
    object: "model",
    created,
    owned_by: "minimax-agent",
    context_window: model.context,
  }));
}

function md5(value: string): string {
  return crypto.createHash("md5").update(value).digest("hex");
}

export function resolveMiniMaxAuth(): MiniMaxSession | null {
  if (config.minimax.token) {
    return {
      token: config.minimax.token,
      cookie: "",
      uuid: config.minimax.uuid || "",
      deviceId: config.minimax.deviceId || "",
      updatedAt: new Date().toISOString(),
    };
  }
  const session = loadSession();
  if (session && isSessionValid(session)) return session;
  return null;
}

export function miniMaxAuthStatus(): "environment" | "session" | "missing" | "expired" {
  if (config.minimax.token) return "environment";
  const session = loadSession();
  if (!session) return "missing";
  if (!isSessionValid(session)) return "expired";
  return "session";
}

function tokenUserId(token: string): string {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return String(payload?.user?.id || payload?.sub || "0");
  } catch {
    return "0";
  }
}

export function resolveRequestUserId(auth: Pick<MiniMaxSession, "token" | "realUserId">): string {
  return auth.realUserId || tokenUserId(auth.token);
}

function commonParams(now: number, auth: MiniMaxSession): Record<string, string> {
  return {
    device_platform: "web",
    biz_id: "3",
    app_id: "3001",
    version_code: "22201",
    unix: String(now),
    timezone_offset: String(-new Date().getTimezoneOffset() * 60),
    sys_language: "en",
    lang: "en",
    uuid: auth.uuid || processUuid,
    device_id: auth.deviceId || processDeviceId,
    os_name: "Linux",
    browser_name: "Chrome",
    device_memory: "16",
    cpu_core_num: "8",
    browser_language: "en-US",
    browser_platform: "Linux x86_64",
    user_id: resolveRequestUserId(auth),
    token: auth.token,
    screen_width: "1920",
    screen_height: "1080",
    client: "web",
    region: "en",
  };
}

function signedRequest(base: string, path: string, method: string, body?: unknown) {
  const auth = resolveMiniMaxAuth();
  if (!auth) throw new AuthError(`No MiniMax token found in MINIMAX_TOKEN or ${config.minimax.harPath}`);
  // The web client signs timestamps rounded to whole seconds.
  const now = Math.floor(Date.now() / 1000) * 1000;
  const timestamp = String(Math.floor(now / 1000));
  const params = commonParams(now, auth);
  const query = new URLSearchParams(params).toString();
  const bodyText = body === undefined ? "" : JSON.stringify(body);
  const separator = path.includes("?") ? "&" : "?";
  const fullPathWithQuery = `${base}${path}${separator}${query}`;
  const yyBody = method.toLowerCase() === "post" ? (body === undefined ? "{}" : JSON.stringify(body)) : "{}";
  const yy = md5(`${encodeURIComponent(fullPathWithQuery)}_${yyBody}${md5(String(now))}ooui`);
  return {
    query,
    bodyText,
    headers: {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json",
      Origin: "https://agent.minimax.io",
      Referer: "https://agent.minimax.io/",
      "Accept-Language": "en-US,en;q=0.9",
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
      ...(auth.cookie ? { Cookie: auth.cookie } : {}),
      token: auth.token,
      yy,
      "x-timestamp": timestamp,
      "x-signature": md5(`${timestamp}${SIGNATURE_SALT}${bodyText}`),
    },
  };
}

async function webFetch(base: string, path: string, method: string, body?: unknown, signal?: AbortSignal) {
  const signed = signedRequest(base, path, method, body);
  const separator = path.includes("?") ? "&" : "?";
  const response = await fetch(`${base}${path}${separator}${signed.query}`, {
    method,
    headers: signed.headers,
    body: body === undefined ? undefined : signed.bodyText,
    signal,
  });
  if (!response.ok) {
    const text = await response.text();
    const error = new UpstreamError(`MiniMax Agent ${path} returned ${response.status}: ${text.slice(0, 500)}`) as UpstreamError & { upstreamStatus?: number };
    error.upstreamStatus = response.status;
    throw error;
  }
  return response;
}

async function resolveAgentName(signal?: AbortSignal): Promise<string> {
  if (config.minimax.agentName) return config.minimax.agentName;
  const authenticated = resolveMiniMaxAuth();
  if (authenticated?.agentName) return authenticated.agentName;
  if (cachedAgentName) return cachedAgentName;
  const response = await webFetch(WEB_BASE, "/v1/agent?limit=100", "GET", undefined, signal);
  const data = await response.json() as any;
  const agents = Array.isArray(data?.agents) ? data.agents : [];
  const preferredRole = config.minimax.enableTeam ? "mavis" : "chat";
  const selected = agents.find((agent: any) => agent?.agent_role === preferredRole)
    || agents.find((agent: any) => agent?.agent_role === "mavis")
    || agents.find((agent: any) => agent?.agent_role === "chat")
    || agents[0];
  if (!selected?.name) throw new UpstreamError("MiniMax Agent did not return an available agent");
  cachedAgentName = String(selected.name);
  console.log(`[MiniMax] Selected upstream agent role=${selected.agent_role || "unknown"} name=${cachedAgentName} team=${config.minimax.enableTeam}.`);
  return cachedAgentName;
}

async function createSession(signal?: AbortSignal): Promise<string> {
  const agentName = await resolveAgentName(signal);
  const path = `/v1/agent/${encodeURIComponent(agentName)}/session`;
  const response = await webFetch(WEB_BASE, path, "POST", { model: "minimax/MiniMax-M3" }, signal);
  const data = await response.json() as any;
  if (!data?.session_id) throw new UpstreamError("MiniMax Agent did not return a session_id");
  // The web client leaves a short provisioning window before its first turn.
  await sleep(1_000);
  return String(data.session_id);
}

function isTransientAgentBackendError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes("sandbox connection error") || message.includes("rpc timeout");
}

export interface MiniMaxAgentCall {
  content: string;
  conversationId?: string | null;
  variant?: string;
  signal?: AbortSignal;
}

export async function callMiniMaxAgent(input: MiniMaxAgentCall): Promise<{ response: Response; sessionId: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeouts.totalRequestTimeout);
  const abort = () => controller.abort(input.signal?.reason);
  input.signal?.addEventListener("abort", abort, { once: true });
  try {
    let sessionId = input.conversationId ? sessionByConversation.get(input.conversationId) : undefined;
    if (!sessionId) {
      sessionId = await createSession(controller.signal);
      if (input.conversationId) sessionByConversation.set(input.conversationId, sessionId);
    }
    let path = `/v1/session/${encodeURIComponent(sessionId)}/message`;
    const requestBody = {
      content: input.content,
      model: { provider_id: "minimax", model_id: "MiniMax-M3", variant: input.variant ?? "thinking" },
      turn_id: crypto.randomUUID(),
      enable_team: config.minimax.enableTeam,
      worktreeMode: false,
    };
    let response: Response | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await webFetch(STREAM_BASE, path, "POST", requestBody, controller.signal);
        break;
      } catch (error) {
        if (!isTransientAgentBackendError(error)) throw error;
        if (attempt === 2) {
          if (input.conversationId) sessionByConversation.delete(input.conversationId);
          throw error;
        }
        const detail = error instanceof Error ? error.message : String(error);
        const failedSessionId = sessionId;
        console.warn(`[MiniMax] Transient backend error session=${failedSessionId}; replacing immediately (${attempt + 1}/2): ${detail}`);
        sessionId = await createSession(controller.signal);
        path = `/v1/session/${encodeURIComponent(sessionId)}/message`;
        if (input.conversationId) sessionByConversation.set(input.conversationId, sessionId);
        console.warn(`[MiniMax] Replaced unhealthy session ${failedSessionId} with ${sessionId}.`);
      }
    }
    if (!response) throw new UpstreamError("MiniMax Agent did not return a response");
    return { response, sessionId };
  } catch (error) {
    if (controller.signal.aborted && !input.signal?.aborted) throw new UpstreamTimeout("MiniMax Agent request timed out");
    throw error;
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", abort);
  }
}
