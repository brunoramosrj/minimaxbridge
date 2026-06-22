import { createHash } from "crypto";
import { Hono } from "hono";
import { listMiniMaxModels } from "../services/minimax.js";
import { NotFoundError } from "../core/errors.js";
import { sendOpenAIError } from "./error-helpers.js";

const app = new Hono();

app.get("/v1/models", async (c) => {
  try {
    const models = listMiniMaxModels();
    const etag = `"${createHash("md5").update(JSON.stringify(models)).digest("hex")}"`;

    if (c.req.header("if-none-match") === etag) {
      return c.body(null, 304);
    }

    c.header("Cache-Control", "public, max-age=3600");
    c.header("ETag", etag);

    if (c.req.header("anthropic-version")) {
      return c.json({
        data: models.map((model) => ({
          id: model.id,
          display_name: model.id,
          created_at: new Date(model.created * 1000).toISOString(),
          max_input_tokens: model.context_window,
          max_tokens: 128000,
          type: "model",
        })),
        has_more: false,
      });
    }

    return c.json({
      object: "list",
      data: models,
    });
  } catch (error) {
    console.error("Error fetching models:", error);
    return sendOpenAIError(c, error);
  }
});

app.get("/v1/models/:model", async (c) => {
  try {
    const modelId = c.req.param("model");
    const models = listMiniMaxModels();
    const model = models.find((entry) => entry.id === modelId);

    if (!model) {
      return sendOpenAIError(c, new NotFoundError("Model not found"));
    }

    return c.json(model);
  } catch (error) {
    console.error("Error fetching model:", error);
    return sendOpenAIError(c, error);
  }
});

export { app };
