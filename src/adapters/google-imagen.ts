import { resolveModelHeaders } from "../config.ts";
import { decodeBase64Image } from "../files.ts";
import { requestJson } from "../http.ts";
import type { AdapterRequest, AdapterResult, AdapterRuntime, GeneratedImage, ImageOutputFormat } from "../types.ts";

function endpoint(baseUrl: string, model: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/models/${encodeURIComponent(model)}:predict`;
}

function outputMime(format: ImageOutputFormat | undefined): string {
  if (format === "jpeg") return "image/jpeg";
  if (format === "webp") return "image/webp";
  return "image/png";
}

function compactObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null));
}

function parsePredictions(
  value: unknown,
  expectedMime: string,
  maxImageBytes: number,
): { images: GeneratedImage[]; warnings: string[] } {
  if (!value || typeof value !== "object") throw new Error("Google Imagen returned an invalid response object.");
  const predictions = (value as Record<string, unknown>).predictions;
  if (!Array.isArray(predictions)) throw new Error("Google Imagen response is missing predictions[].");

  const images: GeneratedImage[] = [];
  const warnings: string[] = [];
  for (const rawPrediction of predictions) {
    if (!rawPrediction || typeof rawPrediction !== "object") continue;
    const prediction = rawPrediction as Record<string, unknown>;
    const encoded = prediction.bytesBase64Encoded;
    if (typeof encoded === "string") {
      images.push(
        decodeBase64Image(
          encoded,
          typeof prediction.mimeType === "string" ? prediction.mimeType : expectedMime,
          maxImageBytes,
        ),
      );
      continue;
    }
    const reason = prediction.raiFilteredReason ?? prediction.safetyAttributes;
    if (reason) warnings.push(`Imagen filtered one output: ${typeof reason === "string" ? reason : JSON.stringify(reason)}`);
  }

  return { images, warnings };
}

export async function runGoogleImagen(
  input: AdapterRequest,
  runtime: AdapterRuntime,
): Promise<AdapterResult> {
  const { request, model, finalPrompt } = input;
  const requestedCount = request.n ?? 1;
  const maxPerRequest = Math.max(1, model.capabilities.maxOutputsPerRequest);
  const format = request.outputFormat ?? "png";
  const mimeType = outputMime(format);
  const url = endpoint(model.baseUrl, model.model);
  const warnings: string[] = [];

  if (request.seed !== undefined) warnings.push("Google Imagen Developer API adapter ignores seed; it remains absent from the wire request.");
  if (request.enhancePrompt !== undefined) warnings.push("Google Imagen Developer API adapter ignores enhancePrompt.");
  if (request.addWatermark !== undefined) warnings.push("Google Imagen Developer API adapter ignores addWatermark.");

  const baseParameters = compactObject({
    personGeneration: request.personGeneration,
    aspectRatio: request.aspectRatio,
    sampleImageSize: request.imageSize?.toLowerCase(),
    safetySetting: request.safetyFilterLevel,
    outputOptions: compactObject({
      mimeType,
      compressionQuality: request.outputCompression,
    }),
  });

  if (request.dryRun) {
    return {
      images: [],
      providerText: [],
      warnings,
      requestPreview: {
        endpoint: `/v1beta/models/${model.model}:predict`,
        method: "POST",
        requests: Math.ceil(requestedCount / maxPerRequest),
        body: {
          instances: [{ prompt: finalPrompt }],
          parameters: { ...baseParameters, sampleCount: Math.min(requestedCount, maxPerRequest) },
        },
      },
    };
  }

  const headers = {
    "content-type": "application/json",
    ...resolveModelHeaders(model, runtime.env),
  };
  const images: GeneratedImage[] = [];

  while (images.length < requestedCount) {
    const sampleCount = Math.min(requestedCount - images.length, maxPerRequest);
    const response = await requestJson<unknown>({
      fetch: runtime.fetch,
      url,
      init: {
        method: "POST",
        headers,
        body: JSON.stringify({
          instances: [{ prompt: finalPrompt }],
          parameters: { ...baseParameters, sampleCount },
        }),
      },
      signal: runtime.signal,
      timeoutMs: runtime.requestTimeoutMs,
      maxAttempts: runtime.maxAttempts,
      maxBytes: runtime.maxResponseBytes,
      label: `Google Imagen generation (${model.model})`,
    });

    const parsed = parsePredictions(response, mimeType, runtime.maxImageBytes);
    images.push(...parsed.images);
    warnings.push(...parsed.warnings);
    if (parsed.images.length === 0) break;
  }

  if (images.length === 0) {
    throw new Error(`Google Imagen returned no images${warnings.length ? `: ${warnings.join("; ")}` : "."}`);
  }
  if (images.length < requestedCount) warnings.push(`Requested ${requestedCount} images but Imagen returned ${images.length}.`);

  return { images: images.slice(0, requestedCount), providerText: [], warnings };
}
