import assert from "node:assert";
import { EventEmitter } from "node:events";
import test from "node:test";
import { waitForServerListening } from "../api/server.ts";

class FakeServer extends EventEmitter {
  listening = false;
}

test("waitForServerListening resolves after the listening event", async () => {
  const server = new FakeServer();
  const ready = waitForServerListening(server);

  server.listening = true;
  server.emit("listening");

  await ready;
  assert.strictEqual(server.listenerCount("error"), 0);
});

test("waitForServerListening rejects cleanly when the bind fails", async () => {
  const server = new FakeServer();
  const ready = waitForServerListening(server);
  const error = Object.assign(new Error("address already in use"), {
    code: "EADDRINUSE",
  });

  server.emit("error", error);

  await assert.rejects(ready, (received: NodeJS.ErrnoException) => {
    return received.code === "EADDRINUSE";
  });
  assert.strictEqual(server.listenerCount("listening"), 0);
});
