import { randomUUID } from "node:crypto";
import { readCodexSubscriptionCredentials } from "../codex-auth.ts";
import { decodeBase64Image } from "../files.ts";
import { HttpStatusError, requestJson } from "../http.ts";
import type { AdapterRequest, AdapterResult, AdapterRuntime, GeneratedImage } from "../types.ts";

const OFFICIAL_CODEX_IMAGE_BASE_URL = "https://chatgpt.com/backend-api/codex";
const CODEX_IMAGE_MODEL = "gpt-image-2";
const TEST_BASE_URL_ENV = "PI_IMAGEGEN_CODEX_TEST_BASE_URL";
const TEST_BASE_URL_OPT_IN_ENV = "PI_IMAGEGEN_ALLOW_CODEX_TEST_ENDPOINT";

interface CodexImageData {
  b64_json?: unknown;
}

interface CodexImageResponse {
  data?: unknown;
  background?: unknown;
  quality?: unknown;
  size?: unknown;
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

function resolveBaseUrl(input: AdapterRequest, runtime: AdapterRuntime): string {
  if (input.model.baseUrl.replace(/\/+$/, "") !== OFFICIAL_CODEX_IMAGE_BASE_URL) {
    throw new Error(
      `The codex-subscription adapter only sends OAuth credentials to ${OFFICIAL_CODEX_IMAGE_BASE_URL}.`,
    );
  }

  const testOverride = runtime.env[TEST_BASE_URL_ENV]?.trim();
  if (!testOverride) return OFFICIAL_CODEX_IMAGE_BASE_URL;
  const parsed = new URL(testOverride);
  if (runtime.env[TEST_BASE_URL_OPT_IN_ENV] !== "1" || parsed.protocol !== "http:" || !isLoopback(parsed.hostname)) {
    throw new Error(
      `${TEST_BASE_URL_ENV} is test-only and requires ${TEST_BASE_URL_OPT_IN_ENV}=1 plus a loopback HTTP URL.`,
    );
  }
  return testOverride.replace(/\/+$/, "");
}

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl}/${path.replace(/^\/+/, "")}`;
}

function dataUrl(image: AdapterRequest["inputImages"][number]): string {
  return `data:${image.mimeType};base64,${image.data.toString("base64")}`;
}

function compatibilityWarnings(input: AdapterRequest): string[] {
  const { request } = input;
  const warnings: string[] = [];
  if (request.size && request.size !== "auto") {
    warnings.push("Codex subscription parity uses size=auto; the requested exact size was not sent upstream.");
  }
  if (request.quality && request.quality !== "auto") {
    warnings.push("Codex subscription parity uses quality=auto; the requested quality was not sent upstream.");
  }
  if (request.background && request.background !== "auto") {
    warnings.push(
      "Codex subscription parity uses background=auto; the requested background remains in the prompt but is not forced at the wire level.",
    );
  }
  if (request.outputFormat) {
    warnings.push("Codex subscription parity does not expose output format selection; files use the MIME type returned by Codex.");
  }
  if (request.outputCompression !== undefined) {
    warnings.push("Codex subscription parity does not expose output compression; outputCompression was ignored.");
  }
  if (request.moderation !== undefined) {
    warnings.push("Codex subscription parity does not expose moderation controls; moderation was ignored.");
  }
  for (const [name, value] of [
    ["aspectRatio", request.aspectRatio],
    ["imageSize", request.imageSize],
    ["personGeneration", request.personGeneration],
    ["safetyFilterLevel", request.safetyFilterLevel],
    ["seed", request.seed],
    ["enhancePrompt", request.enhancePrompt],
    ["addWatermark", request.addWatermark],
  ] as const) {
    if (value !== undefined) warnings.push(`Codex subscription parity does not expose ${name}; it was ignored.`);
  }
  if ((request.n ?? 1) > 1) {
    warnings.push("Codex subscription parity generates one image per request; n was fulfilled with independent requests.");
  }
  return warnings;
}

function parseResponse(value: unknown, runtime: AdapterRuntime): { images: GeneratedImage[]; background?: string } {
  if (!value || typeof value !== "object") {
    throw new Error("Codex subscription image endpoint returned an invalid response object.");
  }
  const response = value as CodexImageResponse;
  if (!Array.isArray(response.data)) {
    throw new Error("Codex subscription image endpoint response is missing data[].");
  }

  const images = (response.data as CodexImageData[]).flatMap((item) =>
    typeof item?.b64_json === "string"
      ? [decodeBase64Image(item.b64_json, "image/png", runtime.maxImageBytes)]
      : [],
  );
  if (images.length === 0) throw new Error("Codex subscription image endpoint returned no images.");
  return {
    images,
    background: typeof response.background === "string" ? response.background : undefined,
  };
}

export async function runCodexSubscription(
  input: AdapterRequest,
  runtime: AdapterRuntime,
): Promise<AdapterResult> {
  const { request, finalPrompt, inputImages } = input;
  if (input.model.model !== CODEX_IMAGE_MODEL) {
    throw new Error(`Codex subscription parity is fixed to ${CODEX_IMAGE_MODEL}.`);
  }
  const usesEditEndpoint = request.mode === "edit" || inputImages.length > 0;
  const path = usesEditEndpoint ? "images/edits" : "images/generations";
  const basePayload: Record<string, unknown> = {
    prompt: finalPrompt,
    background: "auto",
    model: CODEX_IMAGE_MODEL,
    quality: "auto",
    size: "auto",
  };
  if (usesEditEndpoint) {
    basePayload.images = inputImages.map((image) => ({ image_url: dataUrl(image) }));
  }
  const count = request.n ?? 1;
  const warnings = compatibilityWarnings(input);

  if (request.dryRun) {
    return {
      images: [],
      providerText: [],
      warnings,
      requestPreview: {
        endpoint: `/backend-api/codex/${path}`,
        method: "POST",
        requests: count,
        payload: usesEditEndpoint
          ? {
              ...basePayload,
              images: inputImages.map((image) => ({ path: image.path, mimeType: image.mimeType, bytes: image.data.length })),
            }
          : basePayload,
        authentication: "Codex ChatGPT OAuth (redacted; read at execution time)",
      },
    };
  }

  const credentials = runtime.resolveCodexSubscriptionCredentials
    ? await runtime.resolveCodexSubscriptionCredentials()
    : await readCodexSubscriptionCredentials(runtime.env);
  const baseUrl = resolveBaseUrl(input, runtime);
  const images: GeneratedImage[] = [];
  let lastBackground: string | undefined;

  while (images.length < count) {
    let response: unknown;
    try {
      response = await requestJson<unknown>({
        fetch: runtime.fetch,
        url: endpoint(baseUrl, path),
        init: {
          method: "POST",
          headers: {
            authorization: `Bearer ${credentials.accessToken}`,
            "chatgpt-account-id": credentials.accountId,
            "content-type": "application/json",
            originator: "codex_cli_rs",
            "x-codex-image-turn-id": randomUUID(),
          },
          body: JSON.stringify(basePayload),
        },
        signal: runtime.signal,
        timeoutMs: runtime.requestTimeoutMs,
        maxAttempts: runtime.maxAttempts,
        maxBytes: runtime.maxResponseBytes,
        label: `Codex subscription image ${usesEditEndpoint ? "edit" : "generation"}`,
      });
    } catch (error) {
      if (error instanceof HttpStatusError && error.status === 401) {
        throw new Error(
          "Codex subscription authentication was rejected. Open Codex and sign in again so auth.json is refreshed, then retry.",
        );
      }
      if (error instanceof HttpStatusError && error.status === 403) {
        throw new Error(
          "The logged-in ChatGPT account is not currently entitled to Codex subscription image generation.",
        );
      }
      throw error;
    }

    const parsed = parseResponse(response, runtime);
    images.push(...parsed.images);
    lastBackground = parsed.background ?? lastBackground;
  }

  if (request.background === "transparent" && lastBackground && lastBackground !== "transparent") {
    warnings.push(`Codex reported background=${lastBackground}; transparent output was not guaranteed.`);
  }

  return {
    images: images.slice(0, count),
    providerText: [],
    warnings,
  };
}

export { OFFICIAL_CODEX_IMAGE_BASE_URL };
