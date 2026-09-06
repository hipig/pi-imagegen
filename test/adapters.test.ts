import assert from "node:assert/strict";
import test from "node:test";
import { runImageAdapter } from "../src/adapters/index.ts";
import { runGoogleGemini } from "../src/adapters/google-gemini.ts";
import { runGoogleImagen } from "../src/adapters/google-imagen.ts";
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
  return {
    ...source,
    headers: { ...source.headers },
    capabilities: { ...source.capabilities },
  };
}

function runtime(fetch: typeof globalThis.fetch, env: Record<string, string | undefined>): AdapterRuntime {
  return {
    fetch,
    env,
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

test("OpenAI generation maps parameters and parses base64 output", async () => {
  let capturedUrl = "";
  let capturedBody: Record<string, unknown> = {};
  const fetchMock = (async (input: RequestInfo | URL, init?: RequestInit) => {
    capturedUrl = String(input);
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        data: [
          { b64_json: PNG_BASE64, revised_prompt: "A crisp blue airplane" },
          { b64_json: PNG_BASE64 },
        ],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
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
    runtime(fetchMock, { OPENAI_API_KEY: "test-key" }),
  );

  assert.equal(capturedUrl, "https://api.openai.com/v1/images/generations");
  assert.equal(capturedBody.model, "gpt-image-2");
  assert.equal(capturedBody.n, 2);
  assert.equal(capturedBody.quality, "high");
  assert.equal(capturedBody.output_format, "png");
  assert.equal(result.images.length, 2);
  assert.equal(result.images[0]?.mimeType, "image/png");
  assert.equal(result.images[0]?.revisedPrompt, "A crisp blue airplane");
});

test("OpenAI adapter respects configured per-request output limits", async () => {
  let calls = 0;
  const counts: unknown[] = [];
  const fetchMock = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls += 1;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    counts.push(body.n);
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
    runtime(fetchMock, { OPENAI_API_KEY: "test-key" }),
  );

  assert.equal(calls, 2);
  assert.deepEqual(counts, [1, 1]);
  assert.equal(result.images.length, 2);
});

test("transient provider errors are retried without leaking request state", async () => {
  let calls = 0;
  const fetchMock = (async () => {
    calls += 1;
    if (calls === 1) {
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
  const retryRuntime = runtime(fetchMock, { OPENAI_API_KEY: "test-key" });
  retryRuntime.maxAttempts = 2;

  const result = await runOpenAIImages(baseRequest(), retryRuntime);
  assert.equal(calls, 2);
  assert.equal(result.images.length, 1);
});

test("OpenAI edit sends multipart images, mask, and input fidelity", async () => {
  let fields: string[] = [];
  const fetchMock = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    assert.ok(init?.body instanceof FormData);
    fields = [...init.body.keys()];
    return new Response(JSON.stringify({ data: [{ b64_json: PNG_BASE64 }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  const editModel = model("gpt-image-1.5");

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
      model: editModel,
      inputImages: [loadedImage()],
      mask: loadedImage("mask.png"),
    }),
    runtime(fetchMock, { OPENAI_API_KEY: "test-key" }),
  );

  assert.ok(fields.includes("image"));
  assert.ok(fields.includes("mask"));
  assert.ok(fields.includes("input_fidelity"));
  assert.equal(result.images.length, 1);
});

test("Codex subscription generation uses the direct ChatGPT image endpoint contract", async () => {
  const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  const fetchMock = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return new Response(
      JSON.stringify({ created: 1, background: "opaque", data: [{ b64_json: PNG_BASE64 }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof globalThis.fetch;

  const result = await runImageAdapter(
    baseRequest({
      model: model("codex-subscription"),
      request: { mode: "generate", prompt: "A blue paper airplane", n: 2, quality: "high" },
    }),
    runtime(fetchMock, {
      CODEX_ACCESS_TOKEN: "test-access-token",
      CHATGPT_ACCOUNT_ID: "account-123",
      PI_IMAGEGEN_CODEX_TEST_BASE_URL: "http://127.0.0.1:9123/api/codex",
      PI_IMAGEGEN_ALLOW_CODEX_TEST_ENDPOINT: "1",
    }),
  );

  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.url, "http://127.0.0.1:9123/api/codex/images/generations");
  assert.equal(requests[0]?.headers.get("authorization"), "Bearer test-access-token");
  assert.equal(requests[0]?.headers.get("chatgpt-account-id"), "account-123");
  assert.equal(requests[0]?.headers.get("originator"), "codex_cli_rs");
  assert.match(requests[0]?.headers.get("x-codex-image-turn-id") ?? "", /^[0-9a-f-]{36}$/i);
  assert.deepEqual(requests[0]?.body, {
    prompt: "Primary request: A blue paper airplane",
    background: "auto",
    model: "gpt-image-2",
    quality: "auto",
    size: "auto",
  });
  assert.equal(result.images.length, 2);
  assert.match(result.warnings.join("\n"), /quality=auto/);
  assert.match(result.warnings.join("\n"), /independent requests/);
});

test("Codex subscription generation ignores forced input fidelity", async () => {
  const fetchMock = (async () =>
    new Response(
      JSON.stringify({ created: 1, background: "opaque", data: [{ b64_json: PNG_BASE64 }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof globalThis.fetch;

  const result = await runImageAdapter(
    baseRequest({
      model: model("codex-subscription"),
      request: {
        mode: "generate",
        prompt: "A blue paper airplane",
        inputFidelity: "low",
      },
    }),
    runtime(fetchMock, {
      CODEX_ACCESS_TOKEN: "test-access-token",
      CHATGPT_ACCOUNT_ID: "account-123",
      PI_IMAGEGEN_CODEX_TEST_BASE_URL: "http://127.0.0.1:9123/api/codex",
      PI_IMAGEGEN_ALLOW_CODEX_TEST_ENDPOINT: "1",
    }),
  );

  assert.equal(result.images.length, 1);
  assert.match(result.warnings.join("\n"), /inputFidelity applies only to edit mode/);
});

test("Codex subscription edits send reference images as JSON data URLs", async () => {
  let capturedBody: Record<string, unknown> = {};
  const fetchMock = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ created: 1, background: "transparent", data: [{ b64_json: PNG_BASE64 }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;

  const result = await runImageAdapter(
    baseRequest({
      model: model("codex-subscription"),
      request: { mode: "edit", prompt: "Add a red hat", imagePaths: ["target.png"], background: "transparent" },
      inputImages: [loadedImage()],
    }),
    runtime(fetchMock, {
      CODEX_ACCESS_TOKEN: "test-access-token",
      CHATGPT_ACCOUNT_ID: "account-123",
      PI_IMAGEGEN_CODEX_TEST_BASE_URL: "http://localhost:9123/api/codex",
      PI_IMAGEGEN_ALLOW_CODEX_TEST_ENDPOINT: "1",
    }),
  );

  assert.equal(capturedBody.model, "gpt-image-2");
  assert.equal(capturedBody.background, "auto");
  const images = capturedBody.images as Array<{ image_url: string }>;
  assert.equal(images.length, 1);
  assert.equal(images[0]?.image_url, `data:image/png;base64,${PNG_BASE64}`);
  assert.equal(result.images.length, 1);
});

test("Codex subscription dry-run neither reads credentials nor exposes image bytes", async () => {
  let fetchCalls = 0;
  const fetchMock = (async () => {
    fetchCalls += 1;
    throw new Error("must not fetch");
  }) as typeof globalThis.fetch;
  const result = await runImageAdapter(
    baseRequest({
      model: model("codex-subscription"),
      request: { mode: "edit", prompt: "Add a red hat", imagePaths: ["target.png"], dryRun: true },
      inputImages: [loadedImage()],
    }),
    runtime(fetchMock, { CODEX_HOME: "Z:/definitely-missing" }),
  );

  const preview = JSON.stringify(result.requestPreview);
  assert.equal(fetchCalls, 0);
  assert.match(preview, /Codex ChatGPT OAuth/);
  assert.match(preview, /target\.png/);
  assert.doesNotMatch(preview, new RegExp(PNG_BASE64.slice(0, 20)));
});

test("Google Imagen uses predict parameters and parses predictions", async () => {
  let body: Record<string, unknown> = {};
  const fetchMock = (async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.match(String(input), /imagen-4\.0-generate-001:predict$/);
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({ predictions: [{ bytesBase64Encoded: PNG_BASE64, mimeType: "image/png" }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof globalThis.fetch;

  const imagenModel = model("imagen-4.0-generate-001");
  const result = await runGoogleImagen(
    baseRequest({
      model: imagenModel,
      request: {
        mode: "generate",
        prompt: "A botanical poster",
        n: 1,
        aspectRatio: "4:3",
        imageSize: "2K",
        personGeneration: "allow_adult",
      },
    }),
    runtime(fetchMock, { GEMINI_API_KEY: "test-key" }),
  );

  const parameters = body.parameters as Record<string, unknown>;
  assert.equal(parameters.sampleCount, 1);
  assert.equal(parameters.aspectRatio, "4:3");
  assert.equal(parameters.sampleImageSize, "2k");
  assert.equal(result.images[0]?.mimeType, "image/png");
});

test("Gemini native image request includes input parts and parses text plus image", async () => {
  let body: Record<string, unknown> = {};
  const fetchMock = (async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.match(String(input), /gemini-3-pro-image:generateContent$/);
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        candidates: [
          {
            finishReason: "STOP",
            content: {
              parts: [
                { text: "I preserved the product." },
                { inlineData: { data: PNG_BASE64, mimeType: "image/png" } },
              ],
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof globalThis.fetch;

  const geminiModel = model("gemini-3-pro-image");
  const result = await runGoogleGemini(
    baseRequest({
      model: geminiModel,
      request: {
        mode: "edit",
        prompt: "Make the background warmer",
        imagePaths: ["target.png"],
        aspectRatio: "16:9",
        imageSize: "2K",
      },
      inputImages: [loadedImage()],
    }),
    runtime(fetchMock, { GEMINI_API_KEY: "test-key" }),
  );

  const contents = body.contents as Array<{ parts: Array<Record<string, unknown>> }>;
  assert.equal(contents[0]?.parts.length, 2);
  assert.equal(result.images.length, 1);
  assert.deepEqual(result.providerText, ["I preserved the product."]);
});

test("dry run is credential-free and redacts input image bytes", async () => {
  let fetchCalls = 0;
  const fetchMock = (async () => {
    fetchCalls += 1;
    throw new Error("must not fetch");
  }) as typeof globalThis.fetch;
  const geminiModel = model("gemini-3-pro-image");
  const result = await runGoogleGemini(
    baseRequest({
      model: geminiModel,
      request: { mode: "edit", prompt: "Test", imagePaths: ["target.png"], dryRun: true },
      inputImages: [loadedImage()],
    }),
    runtime(fetchMock, {}),
  );

  assert.equal(fetchCalls, 0);
  assert.match(JSON.stringify(result.requestPreview), /<68 bytes from target\.png>/);
  assert.doesNotMatch(JSON.stringify(result.requestPreview), new RegExp(PNG_BASE64.slice(0, 20)));
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
        model: model("imagen-4.0-generate-001"),
        request: { mode: "edit", prompt: "Edit", imagePaths: ["target.png"] },
        inputImages: [loadedImage()],
      }),
      runtime(fetchMock, { GEMINI_API_KEY: "test-key" }),
    ),
    /does not support image editing/,
  );
  await assert.rejects(
    runImageAdapter(
      baseRequest({
        request: { mode: "generate", prompt: "Transparent", background: "transparent", outputFormat: "png" },
      }),
      runtime(fetchMock, { OPENAI_API_KEY: "test-key" }),
    ),
    /does not support transparent output/,
  );
  await assert.rejects(
    runImageAdapter(
      baseRequest({
        request: { mode: "generate", prompt: "Unsafe suffix", downscaleSuffix: "../../escape" },
      }),
      runtime(fetchMock, { OPENAI_API_KEY: "test-key" }),
    ),
    /downscaleSuffix/,
  );
  assert.equal(fetchCalls, 0);
});
