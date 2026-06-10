import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  loadCredentialEnvironment,
  serializeCredentialAccounts,
} from "../core/credentials.ts";

test("serializeCredentialAccounts converts systemd JSON accounts", () => {
  assert.equal(
    serializeCredentialAccounts([
      { email: "first@example.com", password: "one:two" },
      { email: "second@example.com", password: "three" },
    ]),
    "first@example.com:one:two,second@example.com:three",
  );
});

test("loadCredentialEnvironment reads credentials from CREDENTIALS_DIRECTORY", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "qwenbridge-creds-"));
  const saved = {
    credentialsDirectory: process.env.CREDENTIALS_DIRECTORY,
    apiKey: process.env.API_KEY,
    accounts: process.env.QWEN_ACCOUNTS,
  };

  try {
    fs.writeFileSync(path.join(directory, "qwenproxy-api-key"), "secret-key\n");
    fs.writeFileSync(
      path.join(directory, "qwen-accounts.json"),
      JSON.stringify([{ email: "user@example.com", password: "password" }]),
    );

    process.env.CREDENTIALS_DIRECTORY = directory;
    delete process.env.API_KEY;
    delete process.env.QWEN_ACCOUNTS;

    loadCredentialEnvironment();

    assert.equal(process.env.API_KEY, "secret-key");
    assert.equal(process.env.QWEN_ACCOUNTS, "user@example.com:password");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
    if (saved.credentialsDirectory === undefined) {
      delete process.env.CREDENTIALS_DIRECTORY;
    } else {
      process.env.CREDENTIALS_DIRECTORY = saved.credentialsDirectory;
    }
    if (saved.apiKey === undefined) delete process.env.API_KEY;
    else process.env.API_KEY = saved.apiKey;
    if (saved.accounts === undefined) delete process.env.QWEN_ACCOUNTS;
    else process.env.QWEN_ACCOUNTS = saved.accounts;
  }
});
