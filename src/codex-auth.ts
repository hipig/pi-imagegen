import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface CodexSubscriptionCredentials {
  accessToken: string;
  accountId: string;
  source: "pi-openai-codex" | "environment" | "codex-auth-file";
  authFile?: string;
  expiresAt?: number;
}

export type CodexSubscriptionAuthState = "ready" | "expired" | "missing" | "invalid";

export interface CodexSubscriptionAuthStatus {
  state: CodexSubscriptionAuthState;
  source?: CodexSubscriptionCredentials["source"];
  authFile?: string;
  message: string;
}

interface ParsedTokenClaims {
  exp?: number;
  accountId?: string;
}

interface AuthFileTokens {
  access_token?: unknown;
  account_id?: unknown;
}

interface CodexAuthFile {
  OPENAI_API_KEY?: unknown;
  tokens?: AuthFileTokens;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function expandHome(value: string, home: string): string {
  if (value === "~") return home;
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(home, value.slice(2));
  return value;
}

export function resolveCodexHome(
  env: Record<string, string | undefined>,
  home = homedir(),
): string {
  const configured = env.CODEX_HOME?.trim();
  return configured ? resolve(expandHome(configured, home)) : join(home, ".codex");
}

export function resolveCodexAuthFile(
  env: Record<string, string | undefined>,
  home = homedir(),
): string {
  return join(resolveCodexHome(env, home), "auth.json");
}

function decodeJwtClaims(token: string): ParsedTokenClaims {
  const payload = token.split(".")[1];
  if (!payload) return {};
  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const decoded = JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as unknown;
    if (!decoded || typeof decoded !== "object") return {};
    const claims = decoded as Record<string, unknown>;
    const openAiAuth = claims["https://api.openai.com/auth"];
    const authClaims =
      openAiAuth && typeof openAiAuth === "object" ? (openAiAuth as Record<string, unknown>) : undefined;
    const expiration = typeof claims.exp === "number" && Number.isFinite(claims.exp) ? claims.exp : undefined;
    return {
      exp: expiration,
      accountId:
        nonEmptyString(authClaims?.chatgpt_account_id) ??
        nonEmptyString(claims.chatgpt_account_id) ??
        nonEmptyString(claims.account_id),
    };
  } catch {
    return {};
  }
}

export function credentialsFromCodexAccessToken(
  accessToken: string,
  source: "pi-openai-codex" | "environment",
  accountIdOverride?: string,
): CodexSubscriptionCredentials {
  const claims = decodeJwtClaims(accessToken);
  const accountId = accountIdOverride?.trim() || claims.accountId;
  if (!accountId) {
    throw new Error("The Codex OAuth access token does not contain a ChatGPT account ID.");
  }
  return assertNotExpired({
    accessToken,
    accountId,
    source,
    expiresAt: claims.exp,
  });
}

function credentialsFromEnvironment(
  env: Record<string, string | undefined>,
): CodexSubscriptionCredentials | undefined {
  const accessToken = env.CODEX_ACCESS_TOKEN?.trim();
  if (!accessToken) return undefined;
  return credentialsFromCodexAccessToken(
    accessToken,
    "environment",
    env.CHATGPT_ACCOUNT_ID?.trim() || env.CODEX_ACCOUNT_ID?.trim(),
  );
}

function credentialsFromAuthJson(value: unknown, authFile: string): CodexSubscriptionCredentials {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Codex auth file is not a JSON object: ${authFile}`);
  }
  const auth = value as CodexAuthFile;
  const accessToken = nonEmptyString(auth.tokens?.access_token);
  if (!accessToken) {
    throw new Error(
      `No ChatGPT OAuth access token was found in ${authFile}. Sign in to Codex with ChatGPT, not API-key-only login.`,
    );
  }
  const claims = decodeJwtClaims(accessToken);
  const accountId = nonEmptyString(auth.tokens?.account_id) ?? claims.accountId;
  if (!accountId) {
    throw new Error(`No ChatGPT account ID was found in ${authFile}. Re-login to Codex with ChatGPT.`);
  }
  return {
    accessToken,
    accountId,
    source: "codex-auth-file",
    authFile,
    expiresAt: claims.exp,
  };
}

function assertNotExpired(credentials: CodexSubscriptionCredentials): CodexSubscriptionCredentials {
  if (credentials.expiresAt !== undefined && credentials.expiresAt <= Math.floor(Date.now() / 1000) + 30) {
    throw new Error(
      "The Codex ChatGPT access token is expired. Open Codex and sign in again so it can refresh auth.json, then retry.",
    );
  }
  return credentials;
}

export async function readCodexSubscriptionCredentials(
  env: Record<string, string | undefined>,
  home = homedir(),
): Promise<CodexSubscriptionCredentials> {
  const environmentCredentials = credentialsFromEnvironment(env);
  if (environmentCredentials) return assertNotExpired(environmentCredentials);

  const authFile = resolveCodexAuthFile(env, home);
  let text: string;
  try {
    text = await readFile(authFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Codex ChatGPT login was not found at ${authFile}. Sign in to Codex with ChatGPT first.`);
    }
    throw new Error(`Unable to read Codex authentication metadata at ${authFile}.`);
  }
  if (Buffer.byteLength(text, "utf8") > 1_048_576) throw new Error(`Codex auth file is unexpectedly large: ${authFile}`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Codex auth file contains invalid JSON: ${authFile}`);
  }
  return assertNotExpired(credentialsFromAuthJson(parsed, authFile));
}

export async function inspectCodexSubscriptionAuth(
  env: Record<string, string | undefined>,
  home = homedir(),
): Promise<CodexSubscriptionAuthStatus> {
  const authFile = resolveCodexAuthFile(env, home);
  try {
    const credentials = await readCodexSubscriptionCredentials(env, home);
    return {
      state: "ready",
      source: credentials.source,
      authFile: credentials.authFile,
      message: "ChatGPT subscription authentication is ready.",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not found|No ChatGPT OAuth access token|account ID was found/i.test(message)) {
      return { state: "missing", authFile, message };
    }
    if (/expired/i.test(message)) return { state: "expired", authFile, message };
    return { state: "invalid", authFile, message };
  }
}
