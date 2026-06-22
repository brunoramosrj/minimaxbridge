/*
 * File: chat.ts
 * Project: QwenBridge
 * Author: Pedro Farias
 * Created: 2026-05-09
 *
 * Last Modified: 03/06/26
 */

// Barrel re-export — all route handlers are decomposed in ./chat/index.ts
export { chatCompletions } from "./minimax-chat.ts";
export { chatCompletionsStop } from "./chat/stop.ts";
