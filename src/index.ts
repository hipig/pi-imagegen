import { StringEnum, Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  resizeImage,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { runImageAdapter } from "./adapters/index.ts";
import {
  loadImagegenConfig,
  resolveGlobalImagegenConfigPath,
  resolveProjectImagegenConfigPath,
  type ImagegenConfigLoadOptions,
} from "./config.ts";
import {
  decodeBase64Image,
  loadInputImages,
  loadMask,
  saveDerivedImage,
  saveGeneratedImages,
} from "./files.ts";
import { buildFinalPrompt, IMAGE_USE_CASES } from "./prompt.ts";
import { createProxyAwareFetch } from "./proxy-fetch.ts";
import type {
  AdapterRuntime,
  GeneratedImage,
  ImageGenRequest,
  ImageProviderRoute,
  ImagegenToolDetails,
} from "./types.ts";

const SUPPORTED_PROVIDER_APIS = new Set(["openai-completions", "openai-responses"]);
const REQUEST_OWNED_HEADERS = new Set(["connection", "content-length", "content-type", "host", "transfer-encoding"]);

const imageGenParameters = Type.Object({
  prompt: Type.String({
    description: "The exact image generation or edit request. Preserve user intent and requested text verbatim.",
    minLength: 1,
    maxLength: 32_000,
  }),
  mode: Type.Optional(
    StringEnum(["generate", "edit"] as const, {
      description: "generate creates a new asset (optionally using references); edit modifies input images.",
    }),
  ),
  model: Type.Optional(
    Type.String({ description: "Configured model alias. Omit to use imagegen.json defaultModel." }),
  ),
  imagePaths: Type.Optional(
    Type.Array(Type.String(), {
      description: "Local raster image paths used as edit targets or references, in semantic order.",
      maxItems: 16,
    }),
  ),
  maskPath: Type.Optional(Type.String({ description: "PNG alpha mask path for supported OpenAI edit models." })),
  inputRoles: Type.Optional(
    Type.Array(Type.String(), {
      description: "Optional role for each imagePath, such as 'edit target' or 'style reference'.",
      maxItems: 16,
    }),
  ),
  n: Type.Optional(Type.Integer({ description: "Number of output images (1-10).", minimum: 1, maximum: 10 })),
  size: Type.Optional(
    Type.String({ description: "OpenAI Images size: auto or a provider-supported WIDTHxHEIGHT value." }),
  ),
  quality: Type.Optional(StringEnum(["low", "medium", "high", "auto"] as const)),
  background: Type.Optional(StringEnum(["transparent", "opaque", "auto"] as const)),
  outputFormat: Type.Optional(StringEnum(["png", "jpeg", "webp"] as const)),
  outputCompression: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
  inputFidelity: Type.Optional(StringEnum(["low", "high"] as const)),
  moderation: Type.Optional(StringEnum(["auto", "low"] as const)),
  useCase: Type.Optional(StringEnum(IMAGE_USE_CASES, { description: "Production use-case taxonomy." })),
  assetType: Type.Optional(Type.String({ description: "Intended output asset, e.g. hero image or app icon." })),
  scene: Type.Optional(Type.String()),
  subject: Type.Optional(Type.String()),
  style: Type.Optional(Type.String()),
  composition: Type.Optional(Type.String()),
  lighting: Type.Optional(Type.String()),
  palette: Type.Optional(Type.String()),
  materials: Type.Optional(Type.String()),
  exactText: Type.Optional(Type.String({ description: "Text that must appear verbatim in the image." })),
  constraints: Type.Optional(Type.String({ description: "Must-keep and must-not-change requirements." })),
  negativePrompt: Type.Optional(Type.String({ description: "Concrete artifacts or content to avoid." })),
  augmentPrompt: Type.Optional(
    Type.Boolean({ description: "Build a labeled structured prompt. Defaults to true; false sends prompt verbatim." }),
  ),
  outputPath: Type.Optional(Type.String({ description: "Explicit output file path. Multiple images receive numeric suffixes." })),
  outputDir: Type.Optional(Type.String({ description: "Output directory override." })),
  overwrite: Type.Optional(Type.Boolean({ description: "Replace existing files. Defaults to false and creates -v2, -v3, etc." })),
  downscaleMaxDim: Type.Optional(
    Type.Integer({ description: "Also save a resized copy whose longest edge is at most this many pixels.", minimum: 1 }),
  ),
  downscaleSuffix: Type.Optional(Type.String({ description: "Suffix for resized copies. Defaults to -web." })),
  dryRun: Type.Optional(Type.Boolean({ description: "Validate and show a redacted wire request without calling the provider." })),
});

export interface ImagegenExtensionDependencies {
  fetch?: typeof globalThis.fetch;
  env?: Record<string, string | undefined>;
  config?: Omit<ImagegenConfigLoadOptions, "env">;
}

function currentEnv(dependencies: ImagegenExtensionDependencies): Record<string, string | undefined> {
  return dependencies.env ?? process.env;
}

function loadConfig(ctx: ExtensionContext, dependencies: ImagegenExtensionDependencies) {
  const env = currentEnv(dependencies);
  return loadImagegenConfig(ctx.cwd, ctx.isProjectTrusted(), { ...dependencies.config, env });
}

function resolveConfiguredModel(
  modelId: string,
  models: ReturnType<typeof loadImagegenConfig>["models"],
) {
  const direct = models[modelId];
  if (direct) return direct;
  const upstreamMatches = Object.values(models).filter((model) => model.model === modelId);
  if (upstreamMatches.length === 1) return upstreamMatches[0]!;
  throw new Error(
    `Unknown image model '${modelId}'. Call imagegen_models to list configured aliases, then use one of those exact names.`,
  );
}

function selectConfiguredModel(
  requestedModel: string | undefined,
  config: ReturnType<typeof loadImagegenConfig>,
): ReturnType<typeof resolveConfiguredModel> {
  const explicitModel = requestedModel?.trim();
  return resolveConfiguredModel(explicitModel || config.defaultModel, config.models);
}

function validateProviderBaseUrl(value: string, provider: string): string {
  const normalized = value.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`Current Pi provider '${provider}' has an invalid base URL.`);
  }
  if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.username || parsed.password) {
    throw new Error(`Current Pi provider '${provider}' must use an HTTP(S) base URL without embedded credentials.`);
  }
  return normalized;
}

function currentProviderIdentity(ctx: ExtensionContext) {
  const currentModel = ctx.model;
  if (!currentModel) throw new Error("No active Pi model is selected; select an API-key-backed OpenAI-compatible model first.");
  if (currentModel.provider === "openai-codex" || currentModel.api === "openai-codex-responses") {
    throw new Error(
      "The active openai-codex provider uses a ChatGPT subscription and is not supported. Select an API-key-backed OpenAI-compatible provider.",
    );
  }
  if (!SUPPORTED_PROVIDER_APIS.has(currentModel.api)) {
    throw new Error(
      `Current Pi provider '${currentModel.provider}' uses '${currentModel.api}', which is not compatible with /v1/images. Select a provider using openai-completions or openai-responses.`,
    );
  }
  return currentModel;
}

function mergeProviderAuthHeaders(
  configured: Readonly<Record<string, string | null>> | undefined,
  apiKey: string,
): Record<string, string> {
  const headers = Object.fromEntries(
    Object.entries(configured ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== null && !REQUEST_OWNED_HEADERS.has(entry[0].toLowerCase()),
    ),
  );
  const hasAuthorization = Object.keys(headers).some((name) => name.toLowerCase() === "authorization");
  if (!hasAuthorization) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

async function resolveCurrentProviderRoute(
  ctx: ExtensionContext,
  requireApiKey: boolean,
): Promise<ImageProviderRoute> {
  const currentModel = currentProviderIdentity(ctx);
  const staticBaseUrl = validateProviderBaseUrl(currentModel.baseUrl, currentModel.provider);
  if (!requireApiKey) {
    return {
      provider: currentModel.provider,
      api: currentModel.api,
      baseUrl: staticBaseUrl,
      headers: {},
    };
  }

  const resolved = await ctx.modelRegistry.getApiKeyAndHeaders(currentModel);
  if (!resolved.ok) {
    throw new Error(`Could not resolve the current Pi provider API key: ${resolved.error}`);
  }
  const apiKey = resolved.apiKey?.trim();
  if (!apiKey) {
    throw new Error(
      `Current Pi provider '${currentModel.provider}' does not expose an API key. Configure it with /login or select another API-key-backed provider.`,
    );
  }
  return {
    provider: currentModel.provider,
    api: currentModel.api,
    baseUrl: validateProviderBaseUrl(resolved.baseUrl ?? staticBaseUrl, currentModel.provider),
    headers: mergeProviderAuthHeaders(resolved.headers, apiKey),
  };
}

async function inspectCurrentProvider(ctx: ExtensionContext) {
  try {
    return { status: "ready" as const, route: await resolveCurrentProviderRoute(ctx, true) };
  } catch (error) {
    return {
      status: "unavailable" as const,
      provider: ctx.model?.provider,
      api: ctx.model?.api,
      baseUrl: ctx.model?.baseUrl,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function capabilitySummary(model: ReturnType<typeof resolveConfiguredModel>): string {
  const values = ["generate"];
  if (model.capabilities.edit) values.push("edit");
  if (model.capabilities.references) values.push("references");
  if (model.capabilities.mask) values.push("mask");
  if (model.capabilities.transparency) values.push("transparent");
  if (model.capabilities.inputFidelity) values.push("input-fidelity");
  return values.join(", ");
}

function boundedProviderText(values: readonly string[]): string[] {
  const results: string[] = [];
  let remaining = 8_000;
  for (const value of values) {
    if (remaining <= 0) break;
    const text = value.slice(0, Math.min(2_000, remaining));
    results.push(text);
    remaining -= text.length;
  }
  return results;
}

async function createDownscaledCopies(
  images: readonly GeneratedImage[],
  originalPaths: readonly string[],
  request: ImageGenRequest,
  warnings: string[],
  maxImageBytes: number,
): Promise<string[]> {
  if (request.downscaleMaxDim === undefined) return [];
  const results: string[] = [];
  for (let index = 0; index < images.length; index += 1) {
    const image = images[index]!;
    const originalPath = originalPaths[index];
    if (!originalPath) continue;
    try {
      const resized = await resizeImage(new Uint8Array(image.data), image.mimeType, {
        maxWidth: request.downscaleMaxDim,
        maxHeight: request.downscaleMaxDim,
      });
      if (!resized) {
        warnings.push(`Could not create a resized copy for ${originalPath}.`);
        continue;
      }
      const generated = decodeBase64Image(resized.data, resized.mimeType, maxImageBytes);
      const saved = await saveDerivedImage(
        generated,
        originalPath,
        request.downscaleSuffix?.trim() || "-web",
        request.overwrite === true,
      );
      results.push(saved.path);
    } catch (error) {
      warnings.push(
        `Could not create a resized copy for ${originalPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return results;
}

function completionText(details: ImagegenToolDetails): string {
  if (details.status === "dry-run") {
    return [
      `Dry run validated for ${details.model} via ${details.provider}.`,
      JSON.stringify(details.requestPreview, null, 2),
      details.warnings.length ? `Warnings:\n- ${details.warnings.join("\n- ")}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  const lines = [
    `Generated ${details.paths.length} image${details.paths.length === 1 ? "" : "s"} with ${details.model} via ${details.provider}.`,
    ...details.paths.map((path) => `- ${path}`),
  ];
  if (details.downscaledPaths.length) {
    lines.push("Resized copies:", ...details.downscaledPaths.map((path) => `- ${path}`));
  }
  if (details.revisedPrompts.length) {
    lines.push("Provider-revised prompt:", ...details.revisedPrompts.map((prompt) => `- ${prompt}`));
  }
  if (details.providerText.length) lines.push("Provider notes:", ...details.providerText.map((text) => `- ${text}`));
  if (details.warnings.length) lines.push("Warnings:", ...details.warnings.map((warning) => `- ${warning}`));
  return lines.join("\n");
}

export function createImagegenExtension(dependencies: ImagegenExtensionDependencies = {}) {
  const proxyFetch = dependencies.fetch ? undefined : createProxyAwareFetch(currentEnv(dependencies));
  const fetchImpl = dependencies.fetch ?? proxyFetch!.fetch;
  const transportWarning = proxyFetch?.proxyEnabled
    ? "HTTP(S) proxy environment detected; provider requests will use it."
    : undefined;

  return function imagegenExtension(pi: ExtensionAPI): void {
    pi.registerTool(
      defineTool({
        name: "image_gen",
        label: "Image Gen",
        description:
          "Generate or edit images through the active Pi provider's API key and OpenAI-compatible /v1/images endpoints. Saves files and returns inline image previews. Use imagegen_models to check provider compatibility and available image model aliases.",
        parameters: imageGenParameters,
        executionMode: "parallel",

        async execute(_toolCallId, params, signal, onUpdate, ctx) {
          const config = loadConfig(ctx, dependencies);
          const model = selectConfiguredModel(params.model, config);
          const mode = params.mode ?? (params.maskPath || (params.imagePaths?.length ?? 0) > 0 ? "edit" : "generate");
          const request: ImageGenRequest = { ...params, mode };
          const route = await resolveCurrentProviderRoute(ctx, request.dryRun !== true);
          const inputImages = await loadInputImages(request.imagePaths ?? [], ctx.cwd, config.maxImageBytes);
          const mask = request.maskPath ? await loadMask(request.maskPath, ctx.cwd, config.maxImageBytes) : undefined;
          const finalPrompt = buildFinalPrompt(request);
          const baseWarnings = [
            ...config.warnings,
            ...(transportWarning ? [transportWarning] : []),
          ];

          onUpdate?.({
            content: [{ type: "text", text: `${request.dryRun ? "Validating" : "Generating"} with ${model.id} via ${route.provider}…` }],
            details: {
              status: "running",
              mode,
              model: model.id,
              upstreamModel: model.model,
              adapter: model.adapter,
              provider: route.provider,
              providerApi: route.api,
              baseUrl: route.baseUrl,
              prompt: finalPrompt,
              paths: [],
              downscaledPaths: [],
              revisedPrompts: [],
              providerText: [],
              warnings: baseWarnings,
              inlinePreviews: 0,
            } satisfies ImagegenToolDetails,
          });

          const runtime: AdapterRuntime = {
            fetch: fetchImpl,
            route,
            signal,
            requestTimeoutMs: config.requestTimeoutMs,
            maxAttempts: config.maxAttempts,
            maxImageBytes: config.maxImageBytes,
            maxResponseBytes: config.maxResponseBytes,
          };
          const result = await runImageAdapter(
            { request, finalPrompt, model, inputImages, mask },
            runtime,
          );
          const warnings = [...baseWarnings, ...result.warnings];

          if (request.dryRun) {
            const details: ImagegenToolDetails = {
              status: "dry-run",
              mode,
              model: model.id,
              upstreamModel: model.model,
              adapter: model.adapter,
              provider: route.provider,
              providerApi: route.api,
              baseUrl: route.baseUrl,
              prompt: finalPrompt,
              paths: [],
              downscaledPaths: [],
              revisedPrompts: [],
              providerText: boundedProviderText(result.providerText),
              warnings,
              inlinePreviews: 0,
              requestPreview: result.requestPreview,
            };
            return { content: [{ type: "text", text: completionText(details) }], details };
          }

          const saved = await saveGeneratedImages(result.images, request, ctx.cwd, config.outputDir);
          const downscaledPaths = await createDownscaledCopies(
            result.images,
            saved.map((item) => item.path),
            request,
            warnings,
            config.maxImageBytes,
          );
          const inlinePreviews = Math.min(config.inlinePreviewLimit, result.images.length);
          const details: ImagegenToolDetails = {
            status: "completed",
            mode,
            model: model.id,
            upstreamModel: model.model,
            adapter: model.adapter,
            provider: route.provider,
            providerApi: route.api,
            baseUrl: route.baseUrl,
            prompt: finalPrompt,
            paths: saved.map((item) => item.path),
            downscaledPaths,
            revisedPrompts: result.images.flatMap((image) => (image.revisedPrompt ? [image.revisedPrompt] : [])),
            providerText: boundedProviderText(result.providerText),
            warnings,
            inlinePreviews,
          };

          return {
            content: [
              { type: "text", text: completionText(details) },
              ...result.images.slice(0, inlinePreviews).map((image) => ({
                type: "image" as const,
                data: image.data.toString("base64"),
                mimeType: image.mimeType,
              })),
            ],
            details,
          };
        },
      }),
    );

    pi.registerTool(
      defineTool({
        name: "imagegen_models",
        label: "Imagegen Models",
        description: "List image model aliases and check whether the active Pi provider can call /v1/images with its current API key.",
        parameters: Type.Object({}),
        async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
          const config = loadConfig(ctx, dependencies);
          const provider = await inspectCurrentProvider(ctx);
          const providerDetails = provider.status === "ready"
            ? {
                status: provider.status,
                provider: provider.route.provider,
                api: provider.route.api,
                baseUrl: provider.route.baseUrl,
              }
            : provider;
          const providerLine = provider.status === "ready"
            ? `Current Pi provider: ${provider.route.provider} [${provider.route.api}; ready] — ${provider.route.baseUrl}`
            : `Current Pi provider: ${provider.provider ?? "none"} [${provider.api ?? "unknown"}; unavailable]`;
          const models = Object.values(config.models).map((model) => ({
            id: model.id,
            adapter: model.adapter,
            upstreamModel: model.model,
            capabilities: model.capabilities,
            description: model.description,
            isDefault: model.id === config.defaultModel,
          }));
          const text = [
            providerLine,
            provider.status === "unavailable" ? `Reason: ${provider.error}` : "",
            `Default image model: ${config.defaultModel}`,
            ...models.map(
              (model) =>
                `${model.isDefault ? "*" : "-"} ${model.id} [${model.adapter}] — ${capabilitySummary(config.models[model.id]!)} — ${model.description}`,
            ),
            config.warnings.length ? `Warnings:\n- ${config.warnings.join("\n- ")}` : "",
          ]
            .filter(Boolean)
            .join("\n");
          return {
            content: [{ type: "text", text }],
            details: { currentProvider: providerDetails, defaultModel: config.defaultModel, models, warnings: config.warnings },
          };
        },
      }),
    );

    pi.registerCommand("imagegen", {
      description: "Show imagegen status, model list, and config paths",
      handler: async (args, ctx) => {
        const command = args.trim().toLowerCase();
        const config = loadConfig(ctx, dependencies);
        if (command === "models") {
          const lines = Object.values(config.models).map(
            (model) => `${model.id} — ${model.adapter} — ${capabilitySummary(model)}`,
          );
          ctx.ui.notify(lines.join("\n"), "info");
          return;
        }
        if (command === "config") {
          ctx.ui.notify(
            [
              `Global: ${resolveGlobalImagegenConfigPath({ ...dependencies.config, env: currentEnv(dependencies) })}`,
              `Project: ${resolveProjectImagegenConfigPath(ctx.cwd, dependencies.config)}`,
              `Loaded: ${config.loadedConfigPaths.join(", ") || "defaults only"}`,
            ].join("\n"),
            "info",
          );
          return;
        }
        if (command && command !== "status") {
          ctx.ui.notify("Usage: /imagegen [status|models|config]", "warning");
          return;
        }
        const model = config.models[config.defaultModel];
        const provider = await inspectCurrentProvider(ctx);
        ctx.ui.notify(
          model
            ? [
                `imagegen default: ${model.id} (${model.adapter})`,
                provider.status === "ready"
                  ? `Provider: ${provider.route.provider} (${provider.route.api}, ready)\nEndpoint: ${provider.route.baseUrl}`
                  : `Provider unavailable: ${provider.error}`,
                `Output: ${config.outputDir}`,
              ].join("\n")
            : "imagegen has no available model.",
          model && provider.status === "ready" ? "info" : "error",
        );
      },
    });
  };
}

export default createImagegenExtension();
