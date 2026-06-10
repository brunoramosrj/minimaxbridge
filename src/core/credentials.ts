import fs from "node:fs";
import path from "node:path";

interface CredentialAccount {
  email?: unknown;
  password?: unknown;
}

function credentialPath(
  explicitPath: string | undefined,
  credentialName: string,
): string | undefined {
  if (explicitPath?.trim()) return explicitPath.trim();

  const directory = process.env.CREDENTIALS_DIRECTORY?.trim();
  if (!directory) return undefined;
  return path.join(directory, credentialName);
}

function readCredential(filePath: string | undefined): string | undefined {
  if (!filePath) return undefined;

  try {
    return fs.readFileSync(filePath, "utf8").trim();
  } catch (error: any) {
    if (error?.code !== "ENOENT") {
      console.error(
        `[Credentials] Failed to read ${filePath}: ${error?.message || error}`,
      );
    }
    return undefined;
  }
}

export function serializeCredentialAccounts(value: unknown): string {
  if (!Array.isArray(value)) {
    throw new Error("Qwen accounts credential must contain a JSON array");
  }

  const accounts = value.map((entry: CredentialAccount, index) => {
    const email =
      typeof entry?.email === "string" ? entry.email.trim() : "";
    const password =
      typeof entry?.password === "string" ? entry.password.trim() : "";

    if (!email || !password) {
      throw new Error(`Invalid Qwen account at index ${index}`);
    }

    return `${email}:${password}`;
  });

  if (accounts.length === 0) {
    throw new Error("Qwen accounts credential is empty");
  }

  return accounts.join(",");
}

export function loadCredentialEnvironment(): void {
  if (!process.env.API_KEY) {
    const apiKey = readCredential(
      credentialPath(process.env.API_KEY_FILE, "qwenproxy-api-key"),
    );
    if (apiKey) process.env.API_KEY = apiKey;
  }

  if (!process.env.QWEN_ACCOUNTS) {
    const accountsJson = readCredential(
      credentialPath(process.env.QWEN_ACCOUNTS_FILE, "qwen-accounts.json"),
    );
    if (accountsJson) {
      process.env.QWEN_ACCOUNTS = serializeCredentialAccounts(
        JSON.parse(accountsJson),
      );
    }
  }
}
