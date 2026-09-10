export type ImageAdapterName = "openai-images";

export type ImageMode = "generate" | "edit";
export type ImageQuality = "low" | "medium" | "high" | "auto";
export type ImageBackground = "transparent" | "opaque" | "auto";
export type ImageOutputFormat = "png" | "jpeg" | "webp";
export type InputFidelity = "low" | "high";

export interface ModelCapabilities {
  generate: boolean;
  edit: boolean;
  references: boolean;
  mask: boolean;
  transparency: boolean;
  inputFidelity: boolean;
  maxInputImages: number;
  maxOutputsPerRequest: number;
}

export interface ImageModelDefinition {
  /** User-facing model alias used by the tool. */
  id: string;
  /** Wire adapter. */
  adapter: ImageAdapterName;
  /** Upstream model identifier. */
  model: string;
  description: string;
  capabilities: ModelCapabilities;
}

export interface ImageProviderRoute {
  /** Active Pi provider whose API key and endpoint are reused. */
  provider: string;
  api: string;
  baseUrl: string;
  headers: Record<string, string>;
}

export interface ImagegenConfig {
  defaultModel: string;
  outputDir: string;
  requestTimeoutMs: number;
  maxAttempts: number;
  maxImageBytes: number;
  maxResponseBytes: number;
  inlinePreviewLimit: number;
  models: Record<string, ImageModelDefinition>;
  loadedConfigPaths: string[];
  warnings: string[];
}

export interface PromptFields {
  useCase?: string;
  assetType?: string;
  scene?: string;
  subject?: string;
  style?: string;
  composition?: string;
  lighting?: string;
  palette?: string;
  materials?: string;
  exactText?: string;
  constraints?: string;
  negativePrompt?: string;
  inputRoles?: string[];
  augmentPrompt?: boolean;
}

export interface ImageGenRequest extends PromptFields {
  mode: ImageMode;
  prompt: string;
  model?: string;
  imagePaths?: string[];
  maskPath?: string;
  n?: number;
  size?: string;
  quality?: ImageQuality;
  background?: ImageBackground;
  outputFormat?: ImageOutputFormat;
  outputCompression?: number;
  inputFidelity?: InputFidelity;
  moderation?: "auto" | "low";
  outputPath?: string;
  outputDir?: string;
  overwrite?: boolean;
  downscaleMaxDim?: number;
  downscaleSuffix?: string;
  dryRun?: boolean;
}

export interface LoadedImage {
  path: string;
  fileName: string;
  data: Buffer;
  mimeType: string;
}

export interface AdapterRequest {
  request: ImageGenRequest;
  finalPrompt: string;
  model: ImageModelDefinition;
  inputImages: LoadedImage[];
  mask?: LoadedImage;
}

export interface GeneratedImage {
  data: Buffer;
  mimeType: string;
  revisedPrompt?: string;
}

export interface AdapterResult {
  images: GeneratedImage[];
  providerText: string[];
  warnings: string[];
  requestPreview?: Record<string, unknown>;
}

export interface AdapterRuntime {
  fetch: typeof globalThis.fetch;
  route: ImageProviderRoute;
  signal?: AbortSignal;
  requestTimeoutMs: number;
  maxAttempts: number;
  maxImageBytes: number;
  maxResponseBytes: number;
}

export interface SavedImage {
  path: string;
  mimeType: string;
  bytes: number;
}

export interface ImagegenToolDetails {
  status: "running" | "dry-run" | "completed";
  mode: ImageMode;
  model: string;
  upstreamModel: string;
  adapter: ImageAdapterName;
  provider: string;
  providerApi: string;
  baseUrl: string;
  prompt: string;
  paths: string[];
  downscaledPaths: string[];
  revisedPrompts: string[];
  providerText: string[];
  warnings: string[];
  inlinePreviews: number;
  requestPreview?: Record<string, unknown>;
}
