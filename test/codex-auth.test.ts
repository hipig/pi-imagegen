import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  inspectCodexSubscriptionAuth,
  readCodexSubscriptionCredentials,
  resolveCodexAuthFile,
} from "../src/codex-auth.ts";

function jwt(claims: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(claims)).toString("base64url"),
    "signature",
  ].join(".");
}

test("Codex subscription auth reads OAuth metadata without exposing token values", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-imagegen-codex-auth-"));
  const codexHome = join(root, ".codex");
  const accessToken = jwt({
    exp: Math.floor(Date.now() / 1000) + 3_600,
    "https://api.openai.com/auth": { chatgpt_account_id: "account-from-claim" },
  });
  await mkdir(codexHome, { recursive: true });
  await writeFile(
    join(codexHome, "auth.json"),
    JSON.stringify({ tokens: { access_token: accessToken, refresh_token: "never-read-by-image-adapter" } }),
    "utf8",
  );

  try {
    const env = { CODEX_HOME: codexHome };
    const credentials = await readCodexSubscriptionCredentials(env);
    assert.equal(credentials.accessToken, accessToken);
    assert.equal(credentials.accountId, "account-from-claim");
    assert.equal(credentials.source, "codex-auth-file");
    assert.equal(credentials.authFile, join(codexHome, "auth.json"));

    const status = await inspectCodexSubscriptionAuth(env);
    assert.equal(status.state, "ready");
    assert.doesNotMatch(JSON.stringify(status), /never-read-by-image-adapter|signature/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex subscription auth rejects expired tokens and reports missing login", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-imagegen-codex-expired-"));
  const codexHome = join(root, ".codex");
  await mkdir(codexHome, { recursive: true });
  await writeFile(
    join(codexHome, "auth.json"),
    JSON.stringify({
      tokens: {
        access_token: jwt({ exp: Math.floor(Date.now() / 1000) - 60 }),
        account_id: "account-123",
      },
    }),
    "utf8",
  );

  try {
    await assert.rejects(readCodexSubscriptionCredentials({ CODEX_HOME: codexHome }), /expired/);
    assert.equal((await inspectCodexSubscriptionAuth({ CODEX_HOME: codexHome })).state, "expired");
    assert.equal(
      (await inspectCodexSubscriptionAuth({ CODEX_HOME: join(root, "missing") })).state,
      "missing",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("environment OAuth credentials take precedence and CODEX_HOME resolves predictably", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-imagegen-codex-env-"));
  try {
    const credentials = await readCodexSubscriptionCredentials({
      CODEX_HOME: join(root, "unused"),
      CODEX_ACCESS_TOKEN: "opaque-test-token",
      CHATGPT_ACCOUNT_ID: "account-env",
    });
    assert.equal(credentials.source, "environment");
    assert.equal(credentials.accountId, "account-env");
    assert.equal(resolveCodexAuthFile({ CODEX_HOME: join(root, "codex") }), join(root, "codex", "auth.json"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
