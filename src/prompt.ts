import type { ImageGenRequest } from "./types.ts";

export const IMAGE_USE_CASES = [
  "photorealistic-natural",
  "product-mockup",
  "ui-mockup",
  "infographic-diagram",
  "scientific-educational",
  "ads-marketing",
  "productivity-visual",
  "logo-brand",
  "illustration-story",
  "stylized-concept",
  "historical-scene",
  "text-localization",
  "identity-preserve",
  "precise-object-edit",
  "lighting-weather",
  "background-extraction",
  "style-transfer",
  "compositing",
  "sketch-to-render",
] as const;

function clean(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function describeInputImages(request: ImageGenRequest): string | undefined {
  const paths = request.imagePaths ?? [];
  if (paths.length === 0) return undefined;

  const descriptions = paths.map((_path, index) => {
    const explicitRole = clean(request.inputRoles?.[index]);
    if (explicitRole) return `Image ${index + 1}: ${explicitRole}`;
    if (request.mode === "edit") return `Image ${index + 1}: ${index === 0 ? "edit target" : "supporting reference"}`;
    return `Image ${index + 1}: reference image`;
  });
  return descriptions.join("; ");
}

/** Build the same labeled, production-oriented prompt shape used by Codex imagegen. */
export function buildFinalPrompt(request: ImageGenRequest): string {
  const prompt = clean(request.prompt);
  if (!prompt) throw new Error("Image prompt cannot be empty.");
  if (request.augmentPrompt === false) return prompt;

  const sections: string[] = [];
  const useCase = clean(request.useCase);
  const assetType = clean(request.assetType);
  const inputImages = describeInputImages(request);

  if (useCase) sections.push(`Use case: ${useCase}`);
  if (assetType) sections.push(`Asset type: ${assetType}`);
  sections.push(`Primary request: ${prompt}`);
  if (inputImages) sections.push(`Input images: ${inputImages}`);
  if (clean(request.scene)) sections.push(`Scene/backdrop: ${clean(request.scene)}`);
  if (clean(request.subject)) sections.push(`Subject: ${clean(request.subject)}`);
  if (clean(request.style)) sections.push(`Style/medium: ${clean(request.style)}`);
  if (clean(request.composition)) sections.push(`Composition/framing: ${clean(request.composition)}`);
  if (clean(request.lighting)) sections.push(`Lighting/mood: ${clean(request.lighting)}`);
  if (clean(request.palette)) sections.push(`Color palette: ${clean(request.palette)}`);
  if (clean(request.materials)) sections.push(`Materials/textures: ${clean(request.materials)}`);
  if (clean(request.exactText)) sections.push(`Text (verbatim): "${clean(request.exactText)}"`);
  if (clean(request.constraints)) sections.push(`Constraints: ${clean(request.constraints)}`);
  if (clean(request.negativePrompt)) sections.push(`Avoid: ${clean(request.negativePrompt)}`);

  return sections.join("\n");
}
