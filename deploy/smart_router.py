#!/usr/bin/env python3
"""
Smart Router v6 — Router transparente com cascade multi-endpoint.
  QwenBridge (HTTP direto :3003) → gpt-oss-120b (OpenRouter) → liquid (OpenRouter, ancora)
"""

import asyncio, hashlib, json, logging, os, time, uuid
from aiohttp import web, ClientSession, ClientTimeout

# ── Config ────────────────────────────────────────────────────────────────────
def read_secret(name, default=""):
    credential_dir = os.getenv("CREDENTIALS_DIRECTORY", "")
    if credential_dir:
        path = os.path.join(credential_dir, name)
        try:
            with open(path) as credential:
                return credential.read().strip()
        except OSError:
            pass
    return default


OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
OPENROUTER_KEY = read_secret("openrouter-api-key", os.getenv("OPENROUTER_API_KEY", ""))
QWENBRIDGE_URL = "http://127.0.0.1:3003/v1/chat/completions"
QWENBRIDGE_KEY = read_secret("qwenbridge-api-key", os.getenv("QWENBRIDGE_API_KEY", ""))

# Cada entry: {id, url, key, label}
CLOUD_CHAIN = [
    {"id": "qwen3.7-max-no-thinking",          "url": QWENBRIDGE_URL, "key": QWENBRIDGE_KEY, "label": "QwenBridge / Qwen3.7 Max"},
    {"id": "openai/gpt-oss-20b:free",            "url": OPENROUTER_URL, "key": OPENROUTER_KEY, "label": "GPT-OSS 20B"},
    {"id": "openrouter/free",                    "url": OPENROUTER_URL, "key": OPENROUTER_KEY, "label": "OpenRouter Free"},
]
FAST_MODEL = {
    "id": "qwen3.7-max-no-thinking",
    "url": QWENBRIDGE_URL,
    "key": QWENBRIDGE_KEY,
    "label": "QwenBridge / Qwen3.7 Max (fast)",
}
REASONING_MODEL = {
    "id": "qwen3.7-max",
    "url": QWENBRIDGE_URL,
    "key": QWENBRIDGE_KEY,
    "label": "QwenBridge / Qwen3.7 Max (reasoning)",
}
MEDIA_MODEL = {
    "id": "qwen3.7-plus",
    "url": QWENBRIDGE_URL,
    "key": QWENBRIDGE_KEY,
    "label": "QwenBridge / Qwen3.7 Plus (vision)",
}
PORT           = 8090
STATS_FILE     = "/home/ubuntu/smart_router_stats.json"
REQUEST_TTL    = 15 * 60
REQUEST_MAX    = 250
REQUESTS       = {}
REQUEST_LOCK   = asyncio.Lock()

# ── Stats em memória + persistência ──────────────────────────────────────────
import os.path
def _load_stats():
    try:
        with open(STATS_FILE) as f:
            return json.load(f)
    except Exception:
        return {}

STATS = _load_stats()

def _bump(model: str, key: str, value=1):
    if model not in STATS:
        STATS[model] = {"ok": 0, "err": 0, "total_ms": 0, "errors": {}}
    if key == "latency":
        STATS[model]["total_ms"] += value
    elif key == "ok":
        STATS[model]["ok"] += 1
    elif key.startswith("err:"):
        STATS[model]["err"] += 1
        code = key[4:]
        STATS[model]["errors"][code] = STATS[model]["errors"].get(code, 0) + 1
    try:
        with open(STATS_FILE, "w") as f:
            json.dump(STATS, f, indent=2)
    except Exception:
        pass

# ── Model labels ──────────────────────────────────────────────────────────────
def model_label_for(entry: dict) -> str:
    return f"[{entry['label']}]\n"

import re
_LABEL_RE = re.compile(r'^\s*(?:\[[\w\s\.\-]+\]\s*\n?)+', re.MULTILINE)
_FOOTER_RE = re.compile(r'^[👑🤖]?\s*Modelo:\s*[\w\-/:\.]+\s*\n?', re.MULTILINE)

def clean_history(messages: list) -> list:
    """Remove [Model] labels e headers '👑 Modelo: ...' do histórico assistant."""
    cleaned = []
    for m in messages:
        if m.get("role") == "assistant" and m.get("content"):
            c = m["content"]
            c = _LABEL_RE.sub('', c, count=3)   # remove até 3 labels iniciais
            c = _FOOTER_RE.sub('', c, count=1)
            cleaned.append({**m, "content": c.lstrip()})
        else:
            cleaned.append(m)
    return cleaned


def inject_model_identity(messages: list, label: str) -> list:
    """Append model identity to the system message so the model knows who it is."""
    note = f"\n\n[INSTRUÇÃO DO SISTEMA: Você está sendo executado como o modelo {label}. Se perguntado sobre qual modelo está usando, responda '{label}'. Nunca mencione phi4-fast, ollama ou nomes internos.]"
    result = []
    injected = False
    for m in messages:
        if m.get("role") == "system" and not injected:
            result.append({**m, "content": (m.get("content") or "") + note})
            injected = True
        else:
            result.append(m)
    if not injected:
        result.insert(0, {"role": "system", "content": note.strip()})
    return result

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [router] %(message)s",
    datefmt="%H:%M:%S",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler(os.getenv("SMART_ROUTER_LOG", "/home/ubuntu/smart_router.log")),
    ],
)
log = logging.getLogger(__name__)


# ── Cloud forward com fallback ────────────────────────────────────────────────
async def _call_cloud(body: dict, entry: dict, request: web.Request):
    record = request.get("request_record")
    request_id = request.get("request_id")
    stream = body.get("stream", False)
    # Strip any [Model] labels from history (residual from earlier turns)
    body = {**body, "messages": clean_history(body.get("messages", []))}
    # Only inject identity + label on user-facing (streaming) calls
    if stream:
        body["messages"] = inject_model_identity(body["messages"], entry["label"])
    headers = {
        "Content-Type":  "application/json",
        "HTTP-Referer":  "https://hermes-agent",
        "X-Request-Id": request_id,
        "X-Client-Request-Id": request_id,
        "X-Hermes-Session-Id": request.headers.get("X-Hermes-Session-Id", ""),
        "X-Request-Priority": request.headers.get("X-Request-Priority", "100"),
        "Idempotency-Key": request.get("idempotency_key"),
    }
    if entry["key"]:
        headers["Authorization"] = f"Bearer {entry['key']}"
    if entry["url"] == OPENROUTER_URL:
        # Bloqueio explicito de modelos pagos no OpenRouter (teto de preco 0)
        body = {**body, "provider": {"max_price": {"prompt": 0, "completion": 0}}}
    cloud_timeout = 90 if entry["url"] == QWENBRIDGE_URL else 600
    async with ClientSession(timeout=ClientTimeout(total=cloud_timeout)) as s:
        async with s.post(entry["url"], json=body, headers=headers) as resp:
            # Qualquer status != 200 → fallback (404, 400, 429, 402, 5xx, etc.)
            if resp.status != 200:
                raise Exception(f"HTTP {resp.status}")

            if stream:
                # Peek: bufferiza os primeiros chunks ANTES de escrever qualquer
                # coisa no cliente. Se vier erro no corpo SSE, levanta exceção e
                # cai pro próximo modelo — sem corromper o stream.
                first_data = b""
                content_iter = resp.content.iter_any()
                async for chunk in content_iter:
                    first_data += chunk
                    if len(first_data) >= 256:
                        break
                head = first_data.decode("utf-8", "ignore")
                head_lower = head.lower()
                if ('"error"' in head and '"choices"' not in head) or \
                   any(marker in head_lower for marker in ("<!doctype", "<html", "captcha", "verify you are human", "login required")):
                    raise Exception(f"upstream error in body: {head[:80]}")
                if not first_data:
                    raise Exception("empty upstream stream")

                tool_choice = body.get("tool_choice")
                requires_tool = tool_choice == "required" or isinstance(tool_choice, dict)
                if requires_tool:
                    remaining = b"".join([chunk async for chunk in content_iter])
                    buffered = first_data + remaining
                    decoded = buffered.decode("utf-8", "ignore")
                    if '"tool_calls"' not in decoded and "<tool_call>" not in decoded:
                        raise Exception("required tool call missing")
                    label = model_label_for(entry)
                    label_chunk = {
                        "id": f"chatcmpl-label-{int(time.time())}",
                        "object": "chat.completion.chunk",
                        "created": int(time.time()),
                        "model": entry["id"],
                        "choices": [{"index": 0, "delta": {"role": "assistant", "content": label}, "finish_reason": None}],
                    }
                    output = f"data: {json.dumps(label_chunk)}\n\n".encode() + buffered
                    record["chunks"].append(output)
                    return web.Response(
                        body=output,
                        status=200,
                        headers={
                            "Content-Type": "text/event-stream",
                            "Cache-Control": "no-cache",
                            "X-Request-Id": request_id,
                        },
                    )

                # OK — agora escreve label e repassa tudo
                label = model_label_for(entry)
                out = web.StreamResponse(
                    status=200,
                    headers={
                        "Content-Type": "text/event-stream",
                        "Cache-Control": "no-cache",
                        "X-Request-Id": request_id,
                    },
                )
                connected = True
                try:
                    await out.prepare(request)
                except (ConnectionError, ConnectionResetError, RuntimeError):
                    connected = False

                async def emit(chunk):
                    nonlocal connected
                    record["chunks"].append(chunk)
                    if connected:
                        try:
                            await out.write(chunk)
                        except (ConnectionError, ConnectionResetError, RuntimeError):
                            connected = False

                first_chunk = {
                    "id": f"chatcmpl-label-{int(time.time())}",
                    "object": "chat.completion.chunk",
                    "created": int(time.time()),
                    "model": entry["id"],
                    "choices": [{"index": 0, "delta": {"role": "assistant", "content": label}, "finish_reason": None}],
                }
                await emit(f"data: {json.dumps(first_chunk)}\n\n".encode())
                await emit(first_data)
                async for chunk in content_iter:                   # resto do stream
                    await emit(chunk)
                if connected:
                    try:
                        await out.write_eof()
                    except (ConnectionError, ConnectionResetError, RuntimeError):
                        pass
                return out

            # Non-streaming (auxiliary): valida corpo antes de repassar
            data = await resp.read()
            txt = data.decode("utf-8", "ignore")
            if '"error"' in txt and '"choices"' not in txt:
                raise Exception(f"upstream error: {txt[:80]}")
            if not txt.strip() or any(marker in txt.lower() for marker in ("<!doctype", "<html", "captcha", "verify you are human")):
                raise Exception("invalid or empty upstream response")
            try:
                parsed = json.loads(txt)
                choices = parsed.get("choices") or []
                message = choices[0].get("message") if choices else None
                if not message or (not message.get("content") and not message.get("tool_calls")):
                    raise Exception("empty assistant response")
                tool_choice = body.get("tool_choice")
                if (tool_choice == "required" or isinstance(tool_choice, dict)) and not message.get("tool_calls"):
                    raise Exception("required tool call missing")
            except json.JSONDecodeError:
                raise Exception("invalid upstream JSON")
            record["chunks"].append(data)
            return web.Response(
                body=data,
                status=200,
                content_type="application/json",
                headers={"X-Request-Id": request_id},
            )


def _has_media(body):
    media_types = {
        "image_url",
        "video_url",
        "audio_url",
        "file_url",
        "input_image",
        "input_audio",
        "image",
        "audio",
        "video",
    }

    for message in body.get("messages", []):
        content = message.get("content", [])
        parts = content if isinstance(content, list) else [content]

        for part in parts:
            if not isinstance(part, dict):
                continue

            part_type = str(part.get("type", "")).lower()
            if part_type in media_types:
                return True

            media_type = str(
                part.get("mime_type")
                or part.get("media_type")
                or part.get("mime")
                or ""
            ).lower()
            if media_type.startswith(("image/", "audio/", "video/")):
                return True

            source_data = part.get("source")
            if isinstance(source_data, dict):
                source_media_type = str(
                    source_data.get("media_type")
                    or source_data.get("mime_type")
                    or ""
                ).lower()
                if source_media_type.startswith(("image/", "audio/", "video/")):
                    return True

    return False


def _content_text(content):
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "\n".join(
        str(part.get("text", ""))
        for part in content
        if isinstance(part, dict) and part.get("type") in {"text", "input_text"}
    )


def _latest_user_text(body):
    for message in reversed(body.get("messages", [])):
        if message.get("role") == "user":
            return _content_text(message.get("content")).strip()
    return ""


def _strip_route_command(body, command):
    for message in reversed(body.get("messages", [])):
        if message.get("role") != "user":
            continue
        content = message.get("content")
        if isinstance(content, str):
            message["content"] = re.sub(
                rf"^\s*{re.escape(command)}(?:\s+|$)", "", content, count=1, flags=re.I
            )
        elif isinstance(content, list):
            for part in content:
                if isinstance(part, dict) and part.get("type") in {"text", "input_text"}:
                    part["text"] = re.sub(
                        rf"^\s*{re.escape(command)}(?:\s+|$)",
                        "",
                        str(part.get("text", "")),
                        count=1,
                        flags=re.I,
                    )
                    break
        return


_REASONING_PATTERNS = (
    r"\b(analise|análise|investigue|diagnostique|debug|depure|corrija|implemente|"
    r"refatore|arquitetura|planeje|planejamento|estratégia|compare|avalie|prove|"
    r"demonstre|explique por que|causa raiz|root cause)\b",
    r"\b(código|codigo|programa(?:ção|cao)|algoritmo|sql|regex|api|bug|erro|"
    r"stack trace|traceback|matemática|matematica|equação|equacao|probabilidade|"
    r"estatística|estatistica|financeiro|jurídico|juridico)\b",
    r"```|(?:^|\n)\s*(?:def |class |function |SELECT |WITH |CREATE |INSERT |UPDATE )",
)


def _select_primary(body):
    if _has_media(body):
        return MEDIA_MODEL.copy(), "media"

    text = _latest_user_text(body)
    lowered = text.lower()
    for command, model, reason in (
        ("/think", REASONING_MODEL, "explicit:/think"),
        ("/reason", REASONING_MODEL, "explicit:/reason"),
        ("/fast", FAST_MODEL, "explicit:/fast"),
    ):
        if re.match(rf"^\s*{re.escape(command)}(?:\s+|$)", lowered):
            _strip_route_command(body, command)
            return model.copy(), reason

    score = 0
    matched = []
    for pattern in _REASONING_PATTERNS:
        if re.search(pattern, lowered, re.I | re.M):
            score += 1
            matched.append(pattern[:24])
    if len(text) >= 700:
        score += 1
        matched.append("long-input")
    if text.count("?") >= 3 or len(re.findall(r"(?:^|\n)\s*\d+[.)]\s+", text)) >= 3:
        score += 1
        matched.append("multi-part")

    if score >= 1:
        return REASONING_MODEL.copy(), "complex:" + ",".join(matched)
    return FAST_MODEL.copy(), "simple"


async def forward_cloud(request: web.Request, body: dict, estimated: int):
    stream = body.get("stream", False)
    chain = list(CLOUD_CHAIN)
    primary, route_reason = _select_primary(body)
    chain[0] = primary
    log.info("route=%s -> %s", route_reason, primary["id"])
    for i, entry in enumerate(chain):
        label = "primary" if i == 0 else f"fallback{i}"
        body["model"] = entry["id"]
        log.info("ctx≈%5d  %s=%s  stream=%s", estimated, label, entry["id"], stream)
        t0 = time.time()
        try:
            request["request_record"]["chunks"].clear()
            result = await _call_cloud(body, entry, request)
            elapsed_ms = int((time.time() - t0) * 1000)
            _bump(entry["id"], "ok"); _bump(entry["id"], "latency", elapsed_ms)
            log.info("done  %.1fs  %s", elapsed_ms/1000, entry["id"])
            request["request_record"]["provider"] = entry["id"]
            return result
        except asyncio.TimeoutError:
            request["request_record"]["chunks"].clear()
            _bump(entry["id"], "err:timeout")
            log.warning("timeout %.0fs  %s → next", time.time() - t0, entry["id"])
        except Exception as e:
            request["request_record"]["chunks"].clear()
            err_code = str(e).replace("HTTP ", "")[:10]
            _bump(entry["id"], f"err:{err_code}")
            log.warning("error %s  %s → next", e, entry["id"])

    return web.Response(status=503, text='{"error":"all providers failed"}')


# ── Main handler ──────────────────────────────────────────────────────────────
async def handle_chat(request: web.Request):
    try:
        body = await request.json()
    except Exception:
        return web.Response(status=400, text='{"error":"invalid json"}')

    session_id = request.headers.get("X-Hermes-Session-Id", "")
    request_id = request.headers.get("X-Request-Id") or str(uuid.uuid4())
    explicit_key = request.headers.get("Idempotency-Key")
    canonical = json.dumps(
        {"session": session_id, "body": body},
        sort_keys=True,
        ensure_ascii=False,
        separators=(",", ":"),
    )
    idem_key = explicit_key or hashlib.sha256(canonical.encode()).hexdigest()
    request["request_id"] = request_id
    request["idempotency_key"] = idem_key

    now = time.time()
    async with REQUEST_LOCK:
        for key, old in list(REQUESTS.items()):
            if now - old["created"] > REQUEST_TTL:
                REQUESTS.pop(key, None)
        if len(REQUESTS) >= REQUEST_MAX:
            oldest = sorted(REQUESTS.items(), key=lambda item: item[1]["created"])[:25]
            for key, _ in oldest:
                REQUESTS.pop(key, None)

        existing = REQUESTS.get(idem_key)
        if existing:
            event = existing["done"]
        else:
            event = asyncio.Event()
            existing = {
                "request_id": request_id,
                "created": now,
                "done": event,
                "chunks": [],
                "ok": False,
                "stream": bool(body.get("stream", False)),
                "provider": None,
                "error": None,
            }
            REQUESTS[idem_key] = existing
            event = None

    if event is not None:
        await event.wait()
        if not existing["ok"]:
            return web.json_response({"error": existing["error"] or "original request failed"}, status=503)
        payload = b"".join(existing["chunks"])
        return web.Response(
            body=payload,
            status=200,
            headers={
                "Content-Type": "text/event-stream" if existing["stream"] else "application/json",
                "X-Request-Id": existing["request_id"],
                "X-Qwen-Replay": "true",
            },
        )

    request["request_record"] = existing
    msgs = body.get("messages", [])
    estimated = int(sum(len(_content_text(m.get("content"))) for m in msgs) / 3.5)
    try:
        result = await forward_cloud(request, body, estimated)
        existing["ok"] = result.status == 200
        if not existing["ok"]:
            existing["error"] = f"HTTP {result.status}"
        return result
    except Exception as exc:
        existing["error"] = str(exc)
        raise
    finally:
        existing["done"].set()


async def handle_models(_):
    models = [FAST_MODEL, REASONING_MODEL, MEDIA_MODEL, *CLOUD_CHAIN[1:]]
    return web.json_response({"object": "list", "data": [
        {"id": e["id"], "object": "model", "owned_by": "smart-router"}
        for e in models
    ]})


async def handle_stats(_):
    """GET /router/stats — uso por modelo desde o último restart."""
    rows = []
    models = [FAST_MODEL, REASONING_MODEL, MEDIA_MODEL, *CLOUD_CHAIN[1:]]
    for e in models:
        s = STATS.get(e["id"], {"ok": 0, "err": 0, "total_ms": 0, "errors": {}})
        total = s["ok"] + s["err"]
        avg = round(s["total_ms"] / s["ok"]) if s["ok"] else 0
        rows.append({
            "model": e["id"],
            "label": e["label"],
            "ok":    s["ok"],
            "err":   s["err"],
            "ok_rate":  round(s["ok"]/total*100, 1) if total else 0,
            "avg_ms":   avg,
            "errors":   s["errors"],
        })
    return web.json_response({
        "routing": {
            "simple": FAST_MODEL["id"],
            "complex": REASONING_MODEL["id"],
            "media": MEDIA_MODEL["id"],
        },
        "fallback_order": [e["id"] for e in CLOUD_CHAIN[1:]],
        "stats":       rows,
        "totals": {
            "requests": sum(r["ok"] + r["err"] for r in rows),
            "served":   sum(r["ok"] for r in rows),
        },
    })


async def handle_replay(request: web.Request):
    request_id = request.match_info["request_id"]
    after = max(0, int(request.query.get("after", "0")))
    record = next((value for value in REQUESTS.values() if value["request_id"] == request_id), None)
    if not record:
        return web.json_response({"error": "request not found"}, status=404)
    if not record["done"].is_set():
        try:
            await asyncio.wait_for(record["done"].wait(), timeout=30)
        except asyncio.TimeoutError:
            return web.json_response({"error": "request still running"}, status=202)
    if not record["ok"]:
        return web.json_response({"error": record["error"] or "original request failed"}, status=503)
    chunks = record["chunks"][after:]
    return web.Response(
        body=b"".join(chunks),
        headers={
            "Content-Type": "text/event-stream" if record["stream"] else "application/json",
            "X-Request-Id": request_id,
            "X-Replay-From": str(after),
            "X-Replay-Chunk-Count": str(len(chunks)),
        },
    )


app = web.Application()
app.router.add_post("/v1/chat/completions", handle_chat)
app.router.add_get("/v1/models",            handle_models)
app.router.add_get("/router/stats",         handle_stats)
app.router.add_get("/router/replay/{request_id}", handle_replay)

if __name__ == "__main__":
    log.info("Smart Router v6  port=%d", PORT)
    for i, e in enumerate(CLOUD_CHAIN):
        label = "primary " if i == 0 else f"fallback{i}"
        log.info("  %s → %s (%s)", label, e["id"], e["url"])
    web.run_app(app, host="127.0.0.1", port=PORT, print=None)
