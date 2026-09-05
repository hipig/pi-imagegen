import { basename } from "node:path";
import { resolveModelHeaders } from "../config.ts";
import { decodeBase64Image, detectImageMime } from "../files.ts";
import { requestBinary, requestJson } from "../http.ts";
import type {
  AdapterRequest,
  AdapterResult,
  AdapterRuntime,
  GeneratedImage,
  ImageOutputFormat,
} from "../types.ts";

const GPT_IMAGE_2_MIN_PIXELS = 655_360;
const GPT_IMAGE_2_MAX_PIXELS = 8_294_400;
const GPT_IMAGE_2_MAX_EDGE = 3_840;
const LEGACY_SIZES = new Set(["1024x1024", "1536x1024", "1024x1536", "auto"]);

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function compactObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null));
}

function outputMime(format: ImageOutputFormat | undefined): string {
  if (format === "jpeg") return "image/jpeg";
  if (format === "webp") return "image/webp";
  return "image/png";
}

function validateSize(size: string | undefined, upstreamModel: string): void {
  const effective = size ?? "auto";
  if (upstreamModel === "gpt-image-2" || upstreamModel.startsWith("gpt-image-2-")) {
    if (effective === "auto") return;
    const match = /^(\d+)x(\d+)$/.exec(effective);
    if (!match) throw new Error("GPT Image 2 size must be 'auto' or WIDTHxHEIGHT.");
    const width = Number(match[1]);
    const height = Number(match[2]);
    const maximum = Math.max(width, height);
    const minimum = Math.min(width, height);
    const pixels = width * height;
    if (maximum > GPT_IMAGE_2_MAX_EDGE) throw new Error("GPT Image 2 size cannot exceed 3840px on either edge.");
    if (width % 16 !== 0 || height % 16 !== 0) {
      throw new Error("GPT Image 2 width and height must both be multiples of 16px.");
    }
    if (maximum / minimum > 3) throw new Error("GPT Image 2 long-to-short edge ratio cannot exceed 3:1.");
    if (pixels < GPT_IMAGE_2_MIN_PIXELS || pixels > GPT_IMAGE_2_MAX_PIXELS) {
      throw new Error("GPT Image 2 total pixels must be between 655,360 and 8,294,400.");
    }
    return;
  }

  if (upstreamModel.startsWith("gpt-image-") && !LEGACY_SIZES.has(effective)) {
    throw new Error("This GPT Image model supports size auto, 1024x1024, 1536x1024, or 1024x1536.");
  }
}

function appendFormValue(form: FormData, name: string, value: unknown): void {
  if (value !== undefined && value !== null) form.append(name, String(value));
}

async function parseOpenAIResponse(
  value: unknown,
  expectedMime: string,
  runtime: AdapterRuntime,
): Promise<{ images: GeneratedImage[]; revisedPrompts: string[] }> {
  if (!value || typeof value !== "object") throw new Error("OpenAI Images API returned an invalid response object.");
  const data = (value as Record<string, unknown>).data;
  if (!Array.isArray(data)) throw new Error("OpenAI Images API response is missing data[].");

  const images: GeneratedImage[] = [];
  const revisedPrompts: string[] = [];
  for (const rawItem of data) {
    if (!rawItem || typeof rawItem !== "object") continue;
    const item = rawItem as Record<string, unknown>;
    let image: GeneratedImage | undefined;
    if (typeof item.b64_json === "string") {
      image = decodeBase64Image(item.b64_json, expectedMime, runtime.maxImageBytes);
    } else if (typeof item.url === "string") {
      const parsedUrl = new URL(item.url);
      if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
        throw new Error("OpenAI Images API returned an unsupported image URL protocol.");
      }
      const downloaded = await requestBinary({
        fetch: runtime.fetch,
        url: parsedUrl.toString(),
        init: { method: "GET" },
        signal: runtime.signal,
        timeoutMs: runtime.requestTimeoutMs,
        maxAttempts: runtime.maxAttempts,
        maxBytes: runtime.maxImageBytes,
        label: "Generated image download",
      });
      const mimeType = detectImageMime(downloaded.data);
      if (!mimeType) throw new Error("Downloaded OpenAI image is not a supported raster image.");
      image = { data: downloaded.data, mimeType };
    }

    if (!image) continue;
    if (typeof item.revised_prompt === "string") {
      image.revisedPrompt = item.revised_prompt;
      revisedPrompts.push(item.revised_prompt);
    }
    images.push(image);
  }

  if (images.length === 0) throw new Error("OpenAI Images API returned no images.");
  return { images, revisedPrompts };
}

export async function runOpenAIImages(
  input: AdapterRequest,
  runtime: AdapterRuntime,
): Promise<AdapterResult> {
  const { request, model, inputImages, mask, finalPrompt } = input;
  validateSize(request.size, model.model);
  const n = request.n ?? 1;
  const format = request.outputFormat ?? "png";
  const usesEditEndpoint = request.mode === "edit" || inputImages.length > 0;
  const url = endpoint(model.baseUrl, usesEditEndpoint ? "images/edits" : "images/generations");

  const maxPerRequest = Math.max(1, model.capabilities.maxOutputsPerRequest);
  const basePayload = compactObject({
    model: model.model,
    prompt: finalPrompt,
    size: request.size ?? "auto",
    quality: request.quality ?? "medium",
    background: request.background,
    output_format: format,
    output_compression: request.outputCompression,
    moderation: request.moderation,
  });
  const previewPayload = { ...basePayload, n: Math.min(n, maxPerRequest) };

  if (request.dryRun) {
    return {
      images: [],
      providerText: [],
      warnings: [],
      requestPreview: {
        endpoint: usesEditEndpoint ? "/v1/images/edits" : "/v1/images/generations",
        method: "POST",
        requests: Math.ceil(n / maxPerRequest),
        payload: usesEditEndpoint
          ? {
              ...previewPayload,
              image: inputImages.map((image) => ({ path: image.path, mimeType: image.mimeType, bytes: image.data.length })),
              mask: mask ? { path: mask.path, mimeType: mask.mimeType, bytes: mask.data.length } : undefined,
              input_fidelity: request.inputFidelity,
            }
          : previewPayload,
      },
    };
  }

  const headers = resolveModelHeaders(model, runtime.env);
  const images: GeneratedImage[] = [];

  while (images.length < n) {
    const payload = { ...basePayload, n: Math.min(n - images.length, maxPerRequest) };
    let response: unknown;

    if (usesEditEndpoint) {
      const form = new FormData();
      for (const [name, value] of Object.entries(payload)) appendFormValue(form, name, value);
      appendFormValue(form, "input_fidelity", request.inputFidelity);

      const imageField = inputImages.length === 1 ? "image" : "image[]";
      for (const image of inputImages) {
        form.append(
          imageField,
          new Blob([new Uint8Array(image.data)], { type: image.mimeType }),
          basename(image.fileName),
        );
      }
      if (mask) {
        form.append("mask", new Blob([new Uint8Array(mask.data)], { type: mask.mimeType }), basename(mask.fileName));
      }

      response = await requestJson<unknown>({
        fetch: runtime.fetch,
        url,
        init: { method: "POST", headers, body: form },
        signal: runtime.signal,
        timeoutMs: runtime.requestTimeoutMs,
        maxAttempts: runtime.maxAttempts,
        maxBytes: runtime.maxResponseBytes,
        label: `OpenAI image edit (${model.model})`,
      });
    } else {
      response = await requestJson<unknown>({
        fetch: runtime.fetch,
        url,
        init: {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(payload),
        },
        signal: runtime.signal,
        timeoutMs: runtime.requestTimeoutMs,
        maxAttempts: runtime.maxAttempts,
        maxBytes: runtime.maxResponseBytes,
        label: `OpenAI image generation (${model.model})`,
      });
    }

    const parsed = await parseOpenAIResponse(response, outputMime(format), runtime);
    images.push(...parsed.images);
  }

  return {
    images: images.slice(0, n),
    providerText: [],
    warnings: [],
  };
}
