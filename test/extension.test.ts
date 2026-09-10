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

function extensionApi(tools: Map<string, any>, commands = new Map<string, unknown>()): ExtensionAPI {
  return {
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, command: unknown) {
      commands.set(name, command);
    },
  } as unknown as ExtensionAPI;
}

function providerContext(
  cwd: string,
  options: {
    provider?: string;
    api?: string;
    baseUrl?: string;
    resolveAuth?: () => Promise<unknown>;
  } = {},
): ExtensionContext {
  const provider = options.provider ?? "current-openai";
  return {
    cwd,
    model: {
      id: "current-text-model",
      provider,
      api: options.api ?? "openai-responses",
      baseUrl: options.baseUrl ?? "https://gateway.example/v1",
    },
    modelRegistry: {
      getApiKeyAndHeaders: options.resolveAuth ?? (async () => ({ ok: true, apiKey: "current-api-key" })),
    },
    isProjectTrusted: () => true,
    ui: { notify() {} },
  } as unknown as ExtensionContext;
}

test("image byte validation rejects non-images and truncated signatures", () => {
  assert.equal(detectImageMime(Buffer.from("89504e470d0a1a0a", "hex")), undefined);
  assert.throws(
    () => decodeBase64Image(Buffer.from("<html>not an image</html>").toString("base64"), "text/html", 1024),
    /not a supported raster image/,
  );
});

test("extension reuses the active provider key and generates versioned files", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-imagegen-extension-"));
  const tools = new Map<string, any>();
  const commands = new Map<string, unknown>();
  let fetchCalls = 0;
  let authResolutions = 0;
  const capturedHeaders: Headers[] = [];
  const fetchMock = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls += 1;
    capturedHeaders.push(new Headers(init?.headers));
    return new Response(JSON.stringify({ data: [{ b64_json: PNG_BASE64 }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;

  createImagegenExtension({
    fetch: fetchMock,
    env: {},
    config: { home: join(root, "home") },
  })(extensionApi(tools, commands));

  const context = providerContext(root, {
    resolveAuth: async () => {
      authResolutions += 1;
      return {
        ok: true,
        apiKey: "current-api-key",
        headers: { "x-tenant": "tenant-a", "content-type": "text/plain" },
      };
    },
  });
  const imageTool = tools.get("image_gen");
  assert.ok(imageTool);
  assert.ok(tools.has("imagegen_models"));
  assert.ok(commands.has("imagegen"));

  try {
    const outputPath = join(root, "artifact.png");
    const first = await imageTool.execute(
      "call-1",
      { prompt: "A geometric blue bird", outputPath },
      new AbortController().signal,
      undefined,
      context,
    );
    assert.equal(first.details.status, "completed");
    assert.equal(first.details.model, "gpt-image-2");
    assert.equal(first.details.provider, "current-openai");
    assert.doesNotMatch(JSON.stringify(first.details), /current-api-key|tenant-a/);
    assert.deepEqual(first.details.paths, [outputPath]);
    assert.equal(first.content.filter((item: any) => item.type === "image").length, 1);
    assert.equal(await fileExists(outputPath), true);

    const second = await imageTool.execute(
      "call-2",
      { prompt: "A geometric blue bird", outputPath },
      new AbortController().signal,
      undefined,
      context,
    );
    const versionedPath = join(root, "artifact-v2.png");
    assert.deepEqual(second.details.paths, [versionedPath]);
    assert.equal(await fileExists(versionedPath), true);
    assert.equal(fetchCalls, 2);
    assert.equal(authResolutions, 2);
    assert.deepEqual(
      capturedHeaders.map((headers) => headers.get("authorization")),
      ["Bearer current-api-key", "Bearer current-api-key"],
    );
    assert.deepEqual(
      capturedHeaders.map((headers) => headers.get("x-tenant")),
      ["tenant-a", "tenant-a"],
    );
    assert.deepEqual(
      capturedHeaders.map((headers) => headers.get("content-type")),
      ["application/json", "application/json"],
    );

    const modelResult = await tools.get("imagegen_models").execute(
      "models-1",
      {},
      new AbortController().signal,
      undefined,
      context,
    );
    assert.match(modelResult.content[0].text, /Current Pi provider: current-openai .* ready/);
    assert.match(modelResult.content[0].text, /Default image model: gpt-image-2/);
    assert.doesNotMatch(modelResult.content[0].text, /codex-subscription|gemini-3-pro-image/);
    assert.equal(authResolutions, 3);
    assert.doesNotMatch(JSON.stringify(modelResult.details), /current-api-key/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("one tool call resolves the current key once for all split image requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-imagegen-auth-snapshot-"));
  const tools = new Map<string, any>();
  const authorizations: Array<string | null> = [];
  let authResolutions = 0;
  const globalConfig = join(root, "home", ".pi", "agent", "imagegen.json");

  createImagegenExtension({
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      authorizations.push(new Headers(init?.headers).get("authorization"));
      return new Response(JSON.stringify({ data: [{ b64_json: PNG_BASE64 }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch,
    env: {},
    config: {
      home: join(root, "home"),
      exists: (path) => path === globalConfig,
      readFile: () => JSON.stringify({ models: { "gpt-image-2": { capabilities: { maxOutputsPerRequest: 1 } } } }),
    },
  })(extensionApi(tools));

  const context = providerContext(root, {
    resolveAuth: async () => {
      authResolutions += 1;
      return { ok: true, apiKey: `rotating-key-${authResolutions}` };
    },
  });

  try {
    const result = await tools.get("image_gen").execute(
      "split-1",
      { prompt: "Two blue birds", n: 2 },
      new AbortController().signal,
      undefined,
      context,
    );
    assert.equal(result.details.paths.length, 2);
    assert.equal(authResolutions, 1);
    assert.deepEqual(authorizations, ["Bearer rotating-key-1", "Bearer rotating-key-1"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolved provider base URL and explicit authorization header take precedence", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-imagegen-provider-route-"));
  const tools = new Map<string, any>();
  let capturedUrl = "";
  let capturedAuthorization = "";

  createImagegenExtension({
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedAuthorization = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(JSON.stringify({ data: [{ b64_json: PNG_BASE64 }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch,
    env: {},
    config: { home: join(root, "home") },
  })(extensionApi(tools));

  const context = providerContext(root, {
    resolveAuth: async () => ({
      ok: true,
      apiKey: "current-api-key",
      baseUrl: "https://resolved-gateway.example/api/v1/",
      headers: { authorization: "Token explicit-provider-auth" },
    }),
  });

  try {
    await tools.get("image_gen").execute(
      "route-1",
      { prompt: "A blue bird" },
      new AbortController().signal,
      undefined,
      context,
    );
    assert.equal(capturedUrl, "https://resolved-gateway.example/api/v1/images/generations");
    assert.equal(capturedAuthorization, "Token explicit-provider-auth");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a legacy image environment key cannot replace a missing current provider key", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-imagegen-current-key-only-"));
  const tools = new Map<string, any>();
  let fetchCalls = 0;
  createImagegenExtension({
    fetch: (async () => {
      fetchCalls += 1;
      throw new Error("must not fetch");
    }) as typeof globalThis.fetch,
    env: { OPENAI_API_KEY: "legacy-image-key" },
    config: { home: join(root, "home") },
  })(extensionApi(tools));
  const context = providerContext(root, {
    resolveAuth: async () => ({ ok: true, headers: {} }),
  });

  try {
    await assert.rejects(
      tools.get("image_gen").execute(
        "missing-current-key-1",
        { prompt: "A blue bird" },
        new AbortController().signal,
        undefined,
        context,
      ),
      /does not expose an API key/,
    );
    assert.equal(fetchCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex subscription and non-OpenAI providers fail before credentials or network", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-imagegen-provider-rejection-"));
  const tools = new Map<string, any>();
  let fetchCalls = 0;
  let authResolutions = 0;
  createImagegenExtension({
    fetch: (async () => {
      fetchCalls += 1;
      throw new Error("must not fetch");
    }) as typeof globalThis.fetch,
    env: {},
    config: { home: join(root, "home") },
  })(extensionApi(tools));
  const resolveAuth = async () => {
    authResolutions += 1;
    return { ok: true, apiKey: "must-not-be-read" };
  };

  try {
    await assert.rejects(
      tools.get("image_gen").execute(
        "codex-1",
        { prompt: "A blue bird" },
        new AbortController().signal,
        undefined,
        providerContext(root, {
          provider: "openai-codex",
          api: "openai-codex-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          resolveAuth,
        }),
      ),
      /ChatGPT subscription.*not supported/,
    );
    await assert.rejects(
      tools.get("image_gen").execute(
        "anthropic-1",
        { prompt: "A blue bird" },
        new AbortController().signal,
        undefined,
        providerContext(root, {
          provider: "anthropic",
          api: "anthropic-messages",
          baseUrl: "https://api.anthropic.com",
          resolveAuth,
        }),
      ),
      /not compatible with \/v1\/images/,
    );
    assert.equal(authResolutions, 0);
    assert.equal(fetchCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tool dry-run checks the current route without resolving credentials or calling the network", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-imagegen-dry-run-"));
  const tools = new Map<string, any>();
  let fetchCalls = 0;
  let authResolutions = 0;
  createImagegenExtension({
    fetch: (async () => {
      fetchCalls += 1;
      throw new Error("must not fetch");
    }) as typeof globalThis.fetch,
    env: {},
    config: { home: join(root, "home") },
  })(extensionApi(tools));
  const context = providerContext(root, {
    resolveAuth: async () => {
      authResolutions += 1;
      return { ok: false, error: "must not resolve" };
    },
  });

  try {
    const result = await tools.get("image_gen").execute(
      "dry-1",
      { prompt: "A red cube", dryRun: true },
      new AbortController().signal,
      undefined,
      context,
    );
    assert.equal(result.details.status, "dry-run");
    assert.equal(result.details.model, "gpt-image-2");
    assert.equal(result.details.provider, "current-openai");
    assert.match(result.content[0].text, /gateway\.example\/v1\/images\/generations/);
    assert.equal(authResolutions, 0);
    assert.equal(fetchCalls, 0);
    assert.equal(await fileExists(join(root, "output", "imagegen")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
