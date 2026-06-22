import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeMiniMaxRequest } from "../routes/minimax-chat.ts";
import { listMiniMaxModels, resolveRequestUserId } from "../services/minimax.ts";
import { mapAnthropicModel } from "../routes/anthropic/translate.ts";
import { buildAgentPrompt } from "../routes/minimax-chat.ts";

test("sanitizes bridge-only fields and preserves native MiniMax fields", () => {
  const request = sanitizeMiniMaxRequest({
    model: "MiniMax-M3",
    messages: [{ role: "user", content: "hello" }],
    tools: [{ type: "function", function: { name: "read", parameters: {} } }],
    reasoning_split: true,
    session_id: "local-session",
    conversation_id: "local-conversation",
  });

  assert.equal(request.session_id, undefined);
  assert.equal(request.conversation_id, undefined);
  assert.equal(request.reasoning_split, true);
  assert.ok(Array.isArray(request.tools));
});

test("advertises MiniMax models", () => {
  const models = listMiniMaxModels();
  assert.ok(models.some((model) => model.id === "MiniMax-M3"));
  assert.ok(models.every((model) => model.owned_by === "minimax-agent"));
});

test("maps Anthropic model aliases to MiniMax-M3", () => {
  assert.equal(mapAnthropicModel("claude-sonnet-4-6"), "MiniMax-M3");
  assert.equal(mapAnthropicModel("MiniMax-M2.7"), "MiniMax-M2.7");
});

test("uses realUserId instead of the different JWT user id", () => {
  const payload = Buffer.from(JSON.stringify({ user: { id: "jwt-user" } })).toString("base64url");
  const token = `header.${payload}.signature`;
  assert.equal(resolveRequestUserId({ token, realUserId: "real-user" }), "real-user");
  assert.equal(resolveRequestUserId({ token }), "jwt-user");
});

test("caps a 201-message prompt while preserving system and newest content", () => {
  const messages = [
    { role: "system", content: "IMPORTANT SYSTEM" },
    ...Array.from({ length: 199 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: `old-${index}-` + "x".repeat(2400) })),
    { role: "user", content: "LATEST USER REQUEST" },
  ];
  const prompt = buildAgentPrompt(messages, true, 70_000);
  assert.ok(prompt.length <= 70_000);
  assert.match(prompt, /IMPORTANT SYSTEM/);
  assert.match(prompt, /LATEST USER REQUEST/);
  assert.match(prompt, /Earlier history omitted/);
});

test("instructs MiniMax to call client tools instead of using its remote sandbox", () => {
  const prompt = buildAgentPrompt(
    [{ role: "user", content: "como funciona esse projeto?" }],
    true,
    70_000,
    [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
  );
  assert.match(prompt, /LOCAL machine/);
  assert.match(prompt, /cannot inspect the project using your own sandbox/);
  assert.match(prompt, /<tool_call>/);
  assert.match(prompt, /read_file/);
});
