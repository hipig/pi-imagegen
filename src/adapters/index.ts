import { runCodexSubscription } from "./codex-subscription.ts";
import { runGoogleGemini } from "./google-gemini.ts";
import { runGoogleImagen } from "./google-imagen.ts";
import { runOpenAIImages } from "./openai.ts";
import type { AdapterRequest, AdapterResult, AdapterRuntime, ImageGenRequest } from "../types.ts";

const IMAGEN_ASPECT_RATIOS = new Set(["1:1", "3:4", "4:3", "9:16", "16:9"]);
const GEMINI_ASPECT_RATIOS = new Set([
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
]);

function greatestCommonDivisor(a: number, b: number): number {
  let x = a;
  let y = b;
  while (y !== 0) {
    const remainder = x % y;
    x = y;
    y = remainder;
  }
  return x;
}

function normalizeGoogleDimensions(
  request: ImageGenRequest,
  adapter: "google-imagen" | "google-gemini",
): { request: ImageGenRequest; warnings: string[] } {
  const warnings: string[] = [];
  if (!request.size || request.size === "auto") return { request, warnings };
  const match = /^(\d+)x(\d+)$/.exec(request.size);
  if (!match) throw new Error("size must be 'auto' or WIDTHxHEIGHT, for example 1024x1024.");
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width < 1 || height < 1) throw new Error("size width and height must be positive.");
  const divisor = greatestCommonDivisor(width, height);
  const ratio = `${width / divisor}:${height / divisor}`;
  const supported = adapter === "google-imagen" ? IMAGEN_ASPECT_RATIOS : GEMINI_ASPECT_RATIOS;
  if (!supported.has(ratio)) {
    throw new Error(`${adapter} cannot represent exact size ${request.size}; use one of these aspect ratios: ${[...supported].join(", ")}.`);
  }
  if (request.aspectRatio && request.aspectRatio !== ratio) {
    throw new Error(`size ${request.size} implies aspect ratio ${ratio}, but aspectRatio is ${request.aspectRatio}.`);
  }
  warnings.push(`${adapter} maps size ${request.size} to aspect ratio ${ratio}; exact pixel dimensions are provider-controlled.`);
  return { request: { ...request, aspectRatio: request.aspectRatio ?? ratio }, warnings };
}

function validateRequest(input: AdapterRequest): { input: AdapterRequest; warnings: string[] } {
  const { request, model, inputImages, mask } = input;
  const capabilities = model.capabilities;
  const n = request.n ?? 1;
  const warnings: string[] = [];
  let normalizedRequest = request;

  if (request.mode === "generate" && request.inputFidelity !== undefined) {
    normalizedRequest = { ...request, inputFidelity: undefined };
    warnings.push("inputFidelity applies only to edit mode; it was ignored for generation.");
  }

  if (!Number.isInteger(n) || n < 1 || n > 10) throw new Error("n must be an integer between 1 and 10.");
  if (!capabilities.generate) throw new Error(`Model '${model.id}' is not configured for image generation.`);
  if (request.mode === "edit" && !capabilities.edit) throw new Error(`Model '${model.id}' does not support image editing.`);
  if (request.mode === "edit" && inputImages.length === 0) throw new Error("Edit mode requires at least one imagePath.");
  if (inputImages.length > 0 && !capabilities.references) {
    throw new Error(`Model '${model.id}' does not accept input/reference images.`);
  }
  if (inputImages.length > capabilities.maxInputImages) {
    throw new Error(`Model '${model.id}' accepts at most ${capabilities.maxInputImages} input images.`);
  }
  if (mask && !capabilities.mask) throw new Error(`Model '${model.id}' does not support masks.`);
  if (mask && request.mode !== "edit") throw new Error("maskPath is only valid in edit mode.");
  if (mask && inputImages.length !== 1) throw new Error("Masked editing requires exactly one input image.");
  if (request.background === "transparent" && !capabilities.transparency) {
    throw new Error(`Model '${model.id}' does not support transparent output.`);
  }
  if (request.background === "transparent" && request.outputFormat && !["png", "webp"].includes(request.outputFormat)) {
    throw new Error("Transparent output requires PNG or WebP format.");
  }
  if (normalizedRequest.inputFidelity && !capabilities.inputFidelity) {
    throw new Error(`Model '${model.id}' does not support inputFidelity.`);
  }
  if (request.outputCompression !== undefined && (!Number.isInteger(request.outputCompression) || request.outputCompression < 0 || request.outputCompression > 100)) {
    throw new Error("outputCompression must be an integer between 0 and 100.");
  }
  if (request.downscaleMaxDim !== undefined && (!Number.isInteger(request.downscaleMaxDim) || request.downscaleMaxDim < 1)) {
    throw new Error("downscaleMaxDim must be a positive integer.");
  }
  if (
    request.downscaleSuffix !== undefined &&
    (request.downscaleSuffix.length > 64 || /[\\/\0]/.test(request.downscaleSuffix))
  ) {
    throw new Error("downscaleSuffix must be at most 64 characters and cannot contain path separators.");
  }
  if (request.inputRoles && request.inputRoles.length > inputImages.length) {
    warnings.push("Extra inputRoles entries were ignored because there are fewer input images.");
  }
  if (request.aspectRatio && !/^\d+:\d+$/.test(request.aspectRatio)) {
    throw new Error("aspectRatio must use WIDTH:HEIGHT syntax, for example 16:9.");
  }

  if (model.adapter === "google-imagen" || model.adapter === "google-gemini") {
    const dimensions = normalizeGoogleDimensions(normalizedRequest, model.adapter);
    normalizedRequest = dimensions.request;
    warnings.push(...dimensions.warnings);
    if (request.quality !== undefined) warnings.push(`${model.adapter} ignores quality; use imageSize instead.`);
    if (request.background && request.background !== "auto") warnings.push(`${model.adapter} ignores non-transparent background controls.`);
  }
  if (model.adapter === "google-imagen" && request.outputFormat === "webp") {
    throw new Error("Google Imagen supports PNG or JPEG output, not WebP.");
  }
  if (model.adapter === "google-imagen" && request.imageSize === "4K") {
    throw new Error("Google Imagen supports 1K or 2K imageSize, not 4K.");
  }

  return { input: { ...input, request: normalizedRequest }, warnings };
}

export async function runImageAdapter(
  input: AdapterRequest,
  runtime: AdapterRuntime,
): Promise<AdapterResult> {
  const validated = validateRequest(input);
  let result: AdapterResult;
  if (validated.input.model.adapter === "codex-subscription") {
    result = await runCodexSubscription(validated.input, runtime);
  } else if (validated.input.model.adapter === "openai-images") {
    result = await runOpenAIImages(validated.input, runtime);
  } else if (validated.input.model.adapter === "google-imagen") {
    result = await runGoogleImagen(validated.input, runtime);
  } else {
    result = await runGoogleGemini(validated.input, runtime);
  }
  return { ...result, warnings: [...validated.warnings, ...result.warnings] };
}
