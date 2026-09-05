import { resolveModelHeaders } from "../config.ts";
import { decodeBase64Image } from "../files.ts";
import { requestJson } from "../http.ts";
import type { AdapterRequest, AdapterResult, AdapterRuntime, GeneratedImage } from "../types.ts";

function endpoint(baseUrl: string, model: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/models/${encodeURIComponent(model)}:generateContent`;
}

function compactObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null));
}

function parseGeminiResponse(
  value: unknown,
  maxImageBytes: number,
): { images: GeneratedImage[]; text: string[]; finishReasons: string[] } {
  if (!value || typeof value !== "object") throw new Error("Google Gemini returned an invalid response object.");
  const candidates = (value as Record<string, unknown>).candidates;
  if (!Array.isArray(candidates)) throw new Error("Google Gemini response is missing candidates[].");

  const images: GeneratedImage[] = [];
  const text: string[] = [];
  const finishReasons: string[] = [];

  for (const rawCandidate of candidates) {
    if (!rawCandidate || typeof rawCandidate !== "object") continue;
    const candidate = rawCandidate as Record<string, unknown>;
    if (typeof candidate.finishReason === "string") finishReasons.push(candidate.finishReason);
    const content = candidate.content;
    if (!content || typeof content !== "object") continue;
    const parts = (content as Record<string, unknown>).parts;
    if (!Array.isArray(parts)) continue;

    for (const rawPart of parts) {
      if (!rawPart || typeof rawPart !== "object") continue;
      const part = rawPart as Record<string, unknown>;
      if (part.thought === true) continue;
      if (typeof part.text === "string" && part.text.trim()) text.push(part.text.trim());

      const inlineData = part.inlineData ?? part.inline_data;
      if (!inlineData || typeof inlineData !== "object") continue;
      const imagePart = inlineData as Record<string, unknown>;
      if (typeof imagePart.data !== "string") continue;
      images.push(
        decodeBase64Image(
          imagePart.data,
          typeof imagePart.mimeType === "string"
            ? imagePart.mimeType
            : typeof imagePart.mime_type === "string"
              ? imagePart.mime_type
              : undefined,
          maxImageBytes,
        ),
      );
    }
  }

  return { images, text, finishReasons };
}

function redactedParts(input: AdapterRequest): Record<string, unknown>[] {
  return [
    { text: input.finalPrompt },
    ...input.inputImages.map((image) => ({
      inlineData: {
        mimeType: image.mimeType,
        data: `<${image.data.length} bytes from ${image.path}>`,
      },
    })),
  ];
}

function requestBody(input: AdapterRequest, includeImageData: boolean): Record<string, unknown> {
  const { request, inputImages, finalPrompt } = input;
  const imageConfig = compactObject({
    aspectRatio: request.aspectRatio,
    imageSize: request.imageSize,
  });
  const parts = includeImageData
    ? [
        { text: finalPrompt },
        ...inputImages.map((image) => ({
          inlineData: { mimeType: image.mimeType, data: image.data.toString("base64") },
        })),
      ]
    : redactedParts(input);

  return {
    contents: [{ role: "user", parts }],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
      ...(Object.keys(imageConfig).length > 0 ? { imageConfig } : {}),
    },
  };
}

export async function runGoogleGemini(
  input: AdapterRequest,
  runtime: AdapterRuntime,
): Promise<AdapterResult> {
  const { request, model } = input;
  const requestedCount = request.n ?? 1;
  const url = endpoint(model.baseUrl, model.model);
  const warnings: string[] = [];

  if (request.outputFormat !== undefined) {
    warnings.push("Gemini native image output chooses its own MIME format; outputFormat is used only for capability reporting.");
  }
  if (request.outputCompression !== undefined) warnings.push("Gemini native image adapter ignores outputCompression.");
  if (request.seed !== undefined) warnings.push("Gemini native image adapter ignores seed.");
  if (request.personGeneration !== undefined) warnings.push("Gemini native image adapter ignores personGeneration.");
  if (request.safetyFilterLevel !== undefined) warnings.push("Gemini native image adapter ignores safetyFilterLevel.");
  if (request.enhancePrompt !== undefined) warnings.push("Gemini native image adapter ignores enhancePrompt.");
  if (request.addWatermark !== undefined) warnings.push("Gemini native image adapter ignores addWatermark.");

  if (request.dryRun) {
    return {
      images: [],
      providerText: [],
      warnings,
      requestPreview: {
        endpoint: `/v1beta/models/${model.model}:generateContent`,
        method: "POST",
        requests: requestedCount,
        body: requestBody(input, false),
      },
    };
  }

  const headers = {
    "content-type": "application/json",
    ...resolveModelHeaders(model, runtime.env),
  };
  const images: GeneratedImage[] = [];
  const providerText: string[] = [];
  const finishReasons: string[] = [];

  while (images.length < requestedCount) {
    const response = await requestJson<unknown>({
      fetch: runtime.fetch,
      url,
      init: { method: "POST", headers, body: JSON.stringify(requestBody(input, true)) },
      signal: runtime.signal,
      timeoutMs: runtime.requestTimeoutMs,
      maxAttempts: runtime.maxAttempts,
      maxBytes: runtime.maxResponseBytes,
      label: `Google Gemini image generation (${model.model})`,
    });
    const parsed = parseGeminiResponse(response, runtime.maxImageBytes);
    images.push(...parsed.images);
    providerText.push(...parsed.text);
    finishReasons.push(...parsed.finishReasons);
    if (parsed.images.length === 0) break;
  }

  if (images.length === 0) {
    const explanation = providerText.length
      ? providerText.join(" ")
      : finishReasons.length
        ? `finish reason: ${finishReasons.join(", ")}`
        : "no image parts were present";
    throw new Error(`Google Gemini returned no images (${explanation}).`);
  }
  if (images.length < requestedCount) warnings.push(`Requested ${requestedCount} images but Gemini returned ${images.length}.`);

  return {
    images: images.slice(0, requestedCount),
    providerText,
    warnings,
  };
}
