import { runOpenAIImages } from "./openai.ts";
import type { AdapterRequest, AdapterResult, AdapterRuntime } from "../types.ts";

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
  return { input: { ...input, request: normalizedRequest }, warnings };
}

export async function runImageAdapter(
  input: AdapterRequest,
  runtime: AdapterRuntime,
): Promise<AdapterResult> {
  const validated = validateRequest(input);
  const result = await runOpenAIImages(validated.input, runtime);
  return { ...result, warnings: [...validated.warnings, ...result.warnings] };
}
