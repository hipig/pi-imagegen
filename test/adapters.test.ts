import assert from "node:assert/strict";
import test from "node:test";
import { runImageAdapter } from "../src/adapters/index.ts";
import { runOpenAIImages } from "../src/adapters/openai.ts";
import { BUILTIN_IMAGE_MODELS } from "../src/config.ts";
import type {
  AdapterRequest,
  AdapterRuntime,
  ImageModelDefinition,
  LoadedImage,
} from "../src/types.ts";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z7XQAAAAASUVORK5CYII=";
const PNG = Buffer.from(PNG_BASE64, "base64");

function model(id: string): ImageModelDefinition {
  const source = BUILTIN_IMAGE_MODELS[id];
  if (!source) throw new Error(`Missing test model ${id}`);
  return { ...source, capabilities: { ...source.capabilities } };
}

function runtime(fetch: typeof globalThis.fetch): AdapterRuntime {
  return {
    fetch,
    route: {
      provider: "test-openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      headers: { Authorization: "Bearer current-test-key", "x-provider-header": "shared" },
    },
    requestTimeoutMs: 5_000,
    maxAttempts: 1,
    maxImageBytes: 2 * 1024 * 1024,
    maxResponseBytes: 4 * 1024 * 1024,
  };
}

function loadedImage(path = "target.png"): LoadedImage {
  return { path, fileName: path, data: PNG, mimeType: "image/png" };
}

function baseRequest(overrides: Partial<AdapterRequest> = {}): AdapterRequest {
  return {
    request: { mode: "generate", prompt: "A blue paper airplane", n: 1 },
    finalPrompt: "Primary request: A blue paper airplane",
    model: model("gpt-image-2"),
    inputImages: [],
    ...overrides,
  };
}

test("OpenAI generation uses the current provider route and parses base64 output", async () => {
  let capturedUrl = "";
  let capturedHeaders = new Headers();
  let capturedBody: Record<string, unknown> = {};
  const fetchMock = (async (input: RequestInfo | URL, init?: RequestInit) => {
    capturedUrl = String(input);
    capturedHeaders = new Headers(init?.headers);
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        data: [
          { b64_json: PNG_BASE64, revised_prompt: "A crisp blue airplane" },
          { b64_json: PNG_BASE64 },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof globalThis.fetch;

  const result = await runOpenAIImages(
    baseRequest({
      request: {
        mode: "generate",
        prompt: "A blue paper airplane",
        n: 2,
        size: "1024x1024",
        quality: "high",
        outputFormat: "png",
      },
    }),
    runtime(fetchMock),
  );

  assert.equal(capturedUrl, "https://api.openai.com/v1/images/generations");
  assert.equal(capturedHeaders.get("authorization"), "Bearer current-test-key");
  assert.equal(capturedHeaders.get("x-provider-header"), "shared");
  assert.equal(capturedBody.model, "gpt-image-2");
  assert.equal(capturedBody.n, 2);
  assert.equal(capturedBody.quality, "high");
  assert.equal(capturedBody.output_format, "png");
  assert.equal(result.images.length, 2);
  assert.equal(result.images[0]?.mimeType, "image/png");
  assert.equal(result.images[0]?.revisedPrompt, "A crisp blue airplane");
});

test("split output requests reuse the same provider authentication snapshot", async () => {
  const authorizations: Array<string | null> = [];
  const counts: unknown[] = [];
  const fetchMock = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    authorizations.push(new Headers(init?.headers).get("authorization"));
    counts.push((JSON.parse(String(init?.body)) as Record<string, unknown>).n);
    return new Response(JSON.stringify({ data: [{ b64_json: PNG_BASE64 }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  const limitedModel = model("gpt-image-2");
  limitedModel.capabilities.maxOutputsPerRequest = 1;

  const result = await runOpenAIImages(
    baseRequest({
      model: limitedModel,
      request: { mode: "generate", prompt: "Two variants", n: 2 },
    }),
    runtime(fetchMock),
  );

  assert.deepEqual(counts, [1, 1]);
  assert.deepEqual(authorizations, ["Bearer current-test-key", "Bearer current-test-key"]);
  assert.equal(result.images.length, 2);
});

test("transient provider retries reuse the same provider authentication snapshot", async () => {
  const authorizations: Array<string | null> = [];
  const fetchMock = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    authorizations.push(new Headers(init?.headers).get("authorization"));
    if (authorizations.length === 1) {
      return new Response(JSON.stringify({ error: { message: "try again" } }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "0" },
      });
    }
    return new Response(JSON.stringify({ data: [{ b64_json: PNG_BASE64 }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  const retryRuntime = runtime(fetchMock);
  retryRuntime.maxAttempts = 2;

  const result = await runOpenAIImages(baseRequest(), retryRuntime);
  assert.deepEqual(authorizations, ["Bearer current-test-key", "Bearer current-test-key"]);
  assert.equal(result.images.length, 1);
});

test("OpenAI edit sends multipart images, mask, and input fidelity", async () => {
  let fields: string[] = [];
  const fetchMock = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    assert.ok(init?.body instanceof FormData);
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer current-test-key");
    fields = [...init.body.keys()];
    return new Response(JSON.stringify({ data: [{ b64_json: PNG_BASE64 }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;

  const result = await runOpenAIImages(
    baseRequest({
      request: {
        mode: "edit",
        prompt: "Change only the background",
        imagePaths: ["target.png"],
        maskPath: "mask.png",
        inputFidelity: "high",
      },
      finalPrompt: "Primary request: Change only the background",
      model: model("gpt-image-1.5"),
      inputImages: [loadedImage()],
      mask: loadedImage("mask.png"),
    }),
    runtime(fetchMock),
  );

  assert.ok(fields.includes("image"));
  assert.ok(fields.includes("mask"));
  assert.ok(fields.includes("input_fidelity"));
  assert.equal(result.images.length, 1);
});

test("dry run is network-free and redacts input image bytes", async () => {
  let fetchCalls = 0;
  const fetchMock = (async () => {
    fetchCalls += 1;
    throw new Error("must not fetch");
  }) as typeof globalThis.fetch;
  const result = await runImageAdapter(
    baseRequest({
      request: { mode: "edit", prompt: "Test", imagePaths: ["target.png"], dryRun: true },
      model: model("gpt-image-1.5"),
      inputImages: [loadedImage()],
    }),
    runtime(fetchMock),
  );

  const preview = JSON.stringify(result.requestPreview);
  assert.equal(fetchCalls, 0);
  assert.match(preview, /test-openai/);
  assert.match(preview, /\/v1\/images\/edits/);
  assert.match(preview, /target\.png/);
  assert.doesNotMatch(preview, new RegExp(PNG_BASE64.slice(0, 20)));
});

test("capability conflicts fail before a provider request", async () => {
  let fetchCalls = 0;
  const fetchMock = (async () => {
    fetchCalls += 1;
    throw new Error("must not fetch");
  }) as typeof globalThis.fetch;

  await assert.rejects(
    runImageAdapter(
      baseRequest({
        request: { mode: "generate", prompt: "Transparent", background: "transparent", outputFormat: "png" },
      }),
      runtime(fetchMock),
    ),
    /does not support transparent output/,
  );
  await assert.rejects(
    runImageAdapter(
      baseRequest({
        request: { mode: "generate", prompt: "Unsafe suffix", downscaleSuffix: "../../escape" },
      }),
      runtime(fetchMock),
    ),
    /downscaleSuffix/,
  );
  assert.equal(fetchCalls, 0);
});
