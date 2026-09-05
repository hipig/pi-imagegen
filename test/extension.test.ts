import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createImagegenExtension } from "../src/index.ts";
import { decodeBase64Image, detectImageMime } from "../src/files.ts";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z7XQAAAAASUVORK5CYII=";

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test("image byte validation rejects non-images and truncated signatures", () => {
  assert.equal(detectImageMime(Buffer.from("89504e470d0a1a0a", "hex")), undefined);
  assert.throws(
    () => decodeBase64Image(Buffer.from("<html>not an image</html>").toString("base64"), "text/html", 1024),
    /not a supported raster image/,
  );
});

test("extension registers tools and generates versioned files with inline previews", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-imagegen-extension-"));
  const tools = new Map<string, any>();
  const commands = new Map<string, unknown>();
  let fetchCalls = 0;
  const fetchMock = (async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({ data: [{ b64_json: PNG_BASE64 }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;

  const api = {
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, command: unknown) {
      commands.set(name, command);
    },
  } as unknown as ExtensionAPI;
  createImagegenExtension({
    fetch: fetchMock,
    env: { OPENAI_API_KEY: "test-key", CODEX_HOME: join(root, "codex-home") },
    config: { home: join(root, "home") },
  })(api);

  const context = {
    cwd: root,
    isProjectTrusted: () => true,
    ui: { notify() {} },
  } as unknown as ExtensionContext;
  const imageTool = tools.get("image_gen");
  assert.ok(imageTool);
  assert.ok(tools.has("imagegen_models"));
  assert.ok(commands.has("imagegen"));

  try {
    const outputPath = join(root, "artifact.png");
    const first = await imageTool.execute(
      "call-1",
      { prompt: "A geometric blue bird", model: "gpt-image-2", outputPath },
      new AbortController().signal,
      undefined,
      context,
    );
    assert.equal(first.details.status, "completed");
    assert.deepEqual(first.details.paths, [outputPath]);
    assert.equal(first.content.filter((item: any) => item.type === "image").length, 1);
    assert.equal(await fileExists(outputPath), true);

    const second = await imageTool.execute(
      "call-2",
      { prompt: "A geometric blue bird", model: "gpt-image-2", outputPath },
      new AbortController().signal,
      undefined,
      context,
    );
    const versionedPath = join(root, "artifact-v2.png");
    assert.deepEqual(second.details.paths, [versionedPath]);
    assert.equal(await fileExists(versionedPath), true);
    assert.equal(fetchCalls, 2);

    const modelTool = tools.get("imagegen_models");
    const modelResult = await modelTool.execute(
      "models-1",
      {},
      new AbortController().signal,
      undefined,
      context,
    );
    assert.match(modelResult.content[0].text, /Default image model: codex-subscription/);
    assert.match(modelResult.content[0].text, /gemini-3-pro-image/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing OPENAI_API_KEY routes an implicit OpenAI default to Codex subscription", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-imagegen-subscription-fallback-"));
  const tools = new Map<string, any>();
  let capturedUrl = "";
  let capturedAuthorization = "";
  const piAccessToken = [
    "e30",
    Buffer.from(
      JSON.stringify({
        exp: Math.floor(Date.now() / 1000) + 3_600,
        "https://api.openai.com/auth": { chatgpt_account_id: "account-from-pi" },
      }),
    ).toString("base64url"),
    "signature",
  ].join(".");
  const api = {
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    registerCommand() {},
  } as unknown as ExtensionAPI;
  const globalConfig = join(root, "home", ".pi", "agent", "imagegen.json");
  createImagegenExtension({
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedAuthorization = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(JSON.stringify({ created: 1, background: "opaque", data: [{ b64_json: PNG_BASE64 }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch,
    env: {
      PI_IMAGEGEN_CODEX_TEST_BASE_URL: "http://127.0.0.1:9123/api/codex",
      PI_IMAGEGEN_ALLOW_CODEX_TEST_ENDPOINT: "1",
    },
    config: {
      home: join(root, "home"),
      exists: (path) => path === globalConfig,
      readFile: () => JSON.stringify({ defaultModel: "gpt-image-2" }),
    },
  })(api);
  const context = {
    cwd: root,
    isProjectTrusted: () => true,
    modelRegistry: {
      async getProviderAuth(provider: string) {
        assert.equal(provider, "openai-codex");
        return { auth: { apiKey: piAccessToken }, source: "OAuth" };
      },
    },
    ui: { notify() {} },
  } as unknown as ExtensionContext;

  try {
    const result = await tools.get("image_gen").execute(
      "fallback-1",
      { prompt: "A subscription-backed blue bird", outputPath: join(root, "subscription.png") },
      new AbortController().signal,
      undefined,
      context,
    );
    assert.equal(result.details.model, "codex-subscription");
    assert.equal(result.details.adapter, "codex-subscription");
    assert.match(result.details.warnings.join("\n"), /OPENAI_API_KEY is unavailable/);
    assert.equal(capturedUrl, "http://127.0.0.1:9123/api/codex/images/generations");
    assert.equal(capturedAuthorization, `Bearer ${piAccessToken}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tool dry-run does not require credentials or call the network", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-imagegen-dry-run-"));
  const tools = new Map<string, any>();
  let fetchCalls = 0;
  const api = {
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    registerCommand() {},
  } as unknown as ExtensionAPI;
  createImagegenExtension({
    fetch: (async () => {
      fetchCalls += 1;
      throw new Error("must not fetch");
    }) as typeof globalThis.fetch,
    env: {},
    config: { home: join(root, "home") },
  })(api);
  const context = {
    cwd: root,
    isProjectTrusted: () => true,
    ui: { notify() {} },
  } as unknown as ExtensionContext;

  try {
    const result = await tools.get("image_gen").execute(
      "dry-1",
      { prompt: "A red cube", dryRun: true },
      new AbortController().signal,
      undefined,
      context,
    );
    assert.equal(result.details.status, "dry-run");
    assert.equal(result.details.model, "codex-subscription");
    assert.equal(result.details.adapter, "codex-subscription");
    assert.match(result.content[0].text, /images\/generations/);
    assert.equal(fetchCalls, 0);
    assert.equal(await fileExists(join(root, "output", "imagegen")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
