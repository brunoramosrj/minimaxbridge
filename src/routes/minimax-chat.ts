import crypto from "node:crypto";
import type { Context } from "hono";
import { stream as honoStream } from "hono/streaming";
import { callMiniMaxAgent } from "../services/minimax.ts";
import { ValidationError } from "../core/errors.ts";
import { sendOpenAIError } from "../api/error-helpers.ts";
import { config } from "../core/config.ts";
import { buildToolInstructions } from "../tools/instructions.ts";
import { StreamingToolParser } from "../tools/parser.ts";

interface ChatMessage {
  role?: string;
  content?: unknown;
  name?: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
}

export function sanitizeMiniMaxRequest(body: Record<string, unknown>) {
  const { session_id, conversation_id, ...upstream } = body;
  return upstream;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return content.map((part: any) => {
    if (part?.type === "text") return part.text || "";
    if (part?.type === "image_url") return `[Image: ${part.image_url?.url || "attached"}]`;
    return JSON.stringify(part);
  }).join("\n");
}

export function buildAgentPrompt(messages: ChatMessage[], includeHistory: boolean, maxChars = 70_000, tools: unknown[] = [], toolChoice?: unknown): string {
  const toolPrompt = tools.length > 0
    ? `System: The tools below run on the user's LOCAL machine through the API client. You cannot inspect the project using your own sandbox. To inspect or modify local files, emit a tool call and stop; the client will return its result.${buildToolInstructions(JSON.stringify(tools), toolChoice)}`
    : "";
  const selected = includeHistory
    ? messages
    : [...messages.filter((message) => message.role === "system"), ...messages.filter((message) => message.role !== "system").slice(-1)];
  const segments = selected.map((message) => {
    const role = message.role === "assistant" ? "Assistant" : message.role === "system" ? "System" : message.role === "tool" ? `Tool ${message.name || message.tool_call_id || "result"}` : "User";
    let text = contentText(message.content);
    if (message.tool_calls?.length) text += `\nTool calls: ${JSON.stringify(message.tool_calls)}`;
    return { role: message.role, text: `${role}: ${text}` };
  });
  const full = [...segments.map((segment) => segment.text), toolPrompt].filter(Boolean).join("\n\n");
  if (full.length <= maxChars) return full;

  const systems = [...segments.filter((segment) => segment.role === "system").map((segment) => segment.text), toolPrompt].filter(Boolean);
  const recent = segments.filter((segment) => segment.role !== "system");
  const kept: string[] = [];
  let used = systems.reduce((total, text) => total + text.length + 2, 0);
  for (let index = recent.length - 1; index >= 0; index--) {
    const text = recent[index].text;
    if (used + text.length + 2 > maxChars && kept.length > 0) break;
    const available = Math.max(0, maxChars - used - 2);
    kept.unshift(text.length > available ? text.slice(-available) : text);
    used += Math.min(text.length, available) + 2;
    if (used >= maxChars) break;
  }
  const prefix = `[Earlier history omitted: original prompt had ${full.length} characters]\n\n`;
  const result = [...systems, prefix, ...kept].join("\n\n");
  return result.length > maxChars ? result.slice(result.length - maxChars) : result;
}

function parseAgentEvents(raw: string): any[] {
  return raw.split(/\r?\n/).filter((line) => line.startsWith("data:")).flatMap((line) => {
    try { return [JSON.parse(line.slice(5).trim())]; } catch { return []; }
  });
}

function usageFromAgent(usage: any) {
  const prompt = Number(usage?.input_tokens || 0);
  const completion = Number(usage?.output_tokens || 0);
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: Number(usage?.total_tokens || prompt + completion) };
}

export async function chatCompletions(c: Context) {
  try {
    const body = await c.req.json<Record<string, any>>();
    if (!body || typeof body !== "object") throw new ValidationError("Request body must be a JSON object");
    if (!Array.isArray(body.messages) || body.messages.length === 0) throw new ValidationError("messages must be a non-empty array");

    const conversationId = typeof body.session_id === "string" ? body.session_id : typeof body.conversation_id === "string" ? body.conversation_id : null;
    const declaredTools = Array.isArray(body.tools) ? body.tools : [];
    const unboundedPromptChars = buildAgentPrompt(body.messages, !conversationId, Number.MAX_SAFE_INTEGER, declaredTools, body.tool_choice).length;
    const prompt = buildAgentPrompt(body.messages, !conversationId, config.minimax.maxPromptChars, declaredTools, body.tool_choice);
    console.log(`[MiniMax] Request stream=${body.stream === true} messages=${body.messages.length} tools=${Array.isArray(body.tools) ? body.tools.length : 0} promptChars=${prompt.length}/${unboundedPromptChars} truncated=${prompt.length < unboundedPromptChars} conversation=${conversationId ? "explicit" : "new"}.`);
    const completionId = `chatcmpl-${crypto.randomUUID()}`;
    const model = "MiniMax-M3";
    const { response, sessionId } = await callMiniMaxAgent({
      content: prompt,
      conversationId,
      variant: body.enable_thinking === false ? "" : "thinking",
      signal: c.req.raw.signal,
    });
    c.header("X-MiniMax-Session-Id", sessionId);

    if (body.stream === true) {
      c.header("Content-Type", "text/event-stream");
      c.header("Cache-Control", "no-cache");
      c.header("X-Accel-Buffering", "no");
      return honoStream(c, async (stream) => {
        const reader = response.body?.getReader();
        if (!reader) throw new Error("MiniMax Agent returned no stream");
        const decoder = new TextDecoder();
        let buffer = "";
        let sentRole = false;
        const toolParser = declaredTools.length > 0 ? new StreamingToolParser(declaredTools) : null;
        let emittedToolCall = false;
        const writeParsed = async (text: string) => {
          const parsed = toolParser?.feed(text);
          const visible = parsed ? parsed.text : text;
          if (visible) {
            const delta: Record<string, unknown> = {};
            if (!sentRole) { delta.role = "assistant"; sentRole = true; }
            delta.content = visible;
            await stream.write(`data: ${JSON.stringify({ id: completionId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
          }
          for (const call of parsed?.toolCalls || []) {
            emittedToolCall = true;
            const delta: Record<string, unknown> = {};
            if (!sentRole) { delta.role = "assistant"; sentRole = true; }
            delta.tool_calls = [{ index: 0, id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }];
            await stream.write(`data: ${JSON.stringify({ id: completionId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
          }
        };
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() || "";
            for (const line of lines) {
              if (!line.startsWith("data:")) continue;
              let event: any;
              try { event = JSON.parse(line.slice(5).trim()); } catch { continue; }
              const chunk = event?.agent_message_chunk;
              if (event.type !== 6 || !chunk) continue;
              const delta: Record<string, unknown> = {};
              if (!sentRole) { delta.role = "assistant"; sentRole = true; }
              if (typeof chunk.thinking_content === "string") delta.reasoning_content = chunk.thinking_content;
              if (typeof chunk.msg_content === "string" && toolParser) {
                if (typeof chunk.thinking_content === "string") {
                  const reasoningPayload = { id: completionId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: null }] };
                  await stream.write(`data: ${JSON.stringify(reasoningPayload)}\n\n`);
                }
                await writeParsed(chunk.msg_content);
                continue;
              }
              if (typeof chunk.msg_content === "string") delta.content = chunk.msg_content;
              const payload = { id: completionId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: chunk.finish ? (chunk.finish_reason || "stop") : null }] };
              await stream.write(`data: ${JSON.stringify(payload)}\n\n`);
            }
          }
          if (toolParser) {
            const flushed = toolParser.flush();
            if (flushed.text) await writeParsed(flushed.text);
            for (const call of flushed.toolCalls) {
              emittedToolCall = true;
              const delta = { tool_calls: [{ index: 0, id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] };
              await stream.write(`data: ${JSON.stringify({ id: completionId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
            }
            if (emittedToolCall) await stream.write(`data: ${JSON.stringify({ id: completionId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
          }
          await stream.write("data: [DONE]\n\n");
        } finally {
          reader.releaseLock();
        }
      });
    }

    const raw = await response.text();
    const events = parseAgentEvents(raw);
    const final = events.map((event) => event?.agent_message).filter((message) => message?.role === "assistant").at(-1);
    const chunks = events.map((event) => event?.agent_message_chunk).filter(Boolean);
    const rawContent = final?.msg_content ?? chunks.map((chunk) => chunk.msg_content || "").join("");
    const parser = declaredTools.length > 0 ? new StreamingToolParser(declaredTools) : null;
    const parsed = parser ? parser.feed(rawContent) : null;
    const flushed = parser?.flush();
    const toolCalls = [...(parsed?.toolCalls || []), ...(flushed?.toolCalls || [])].map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }));
    const content = parser ? `${parsed?.text || ""}${flushed?.text || ""}` : rawContent;
    const reasoning = final?.thinking_content ?? chunks.map((chunk) => chunk.thinking_content || "").join("");
    return c.json({
      id: completionId,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: "assistant", content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}), ...(reasoning ? { reasoning_content: reasoning } : {}) }, finish_reason: toolCalls.length ? "tool_calls" : (final?.finish_reason || "stop") }],
      usage: usageFromAgent(final?.usage),
    });
  } catch (error) {
    return sendOpenAIError(c, error);
  }
}
