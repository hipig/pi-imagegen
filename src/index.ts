import { StringEnum, Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  resizeImage,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { runImageAdapter } from "./adapters/index.ts";
import {
  credentialsFromCodexAccessToken,
  inspectCodexSubscriptionAuth,
  readCodexSubscriptionCredentials,
  type CodexSubscriptionCredentials,
} from "./codex-auth.ts";
import {
  credentialStatus,
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
  ImagegenToolDetails,
} from "./types.ts";

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
    Type.String({ description: "OpenAI size (auto or WIDTHxHEIGHT). Google maps exact ratios to aspectRatio." }),
  ),
  quality: Type.Optional(StringEnum(["low", "medium", "high", "auto"] as const)),
  background: Type.Optional(StringEnum(["transparent", "opaque", "auto"] as const)),
  outputFormat: Type.Optional(StringEnum(["png", "jpeg", "webp"] as const)),
  outputCompression: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
  inputFidelity: Type.Optional(StringEnum(["low", "high"] as const)),
  moderation: Type.Optional(StringEnum(["auto", "low"] as const)),
  aspectRatio: Type.Optional(Type.String({ description: "Provider-native ratio such as 1:1, 16:9, or 4:3." })),
  imageSize: Type.Optional(StringEnum(["1K", "2K", "4K"] as const)),
  personGeneration: Type.Optional(StringEnum(["dont_allow", "allow_adult"] as const)),
  safetyFilterLevel: Type.Optional(
    StringEnum(["block_low_and_above", "block_medium_and_above", "block_only_high"] as const),
  ),
  seed: Type.Optional(Type.Integer({ minimum: 0, maximum: 2_147_483_647 })),
  enhancePrompt: Type.Optional(Type.Boolean()),
  addWatermark: Type.Optional(Type.Boolean()),
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

async function resolveCodexCredentials(
  ctx: ExtensionContext,
  env: Record<string, string | undefined>,
): Promise<CodexSubscriptionCredentials> {
  try {
    const auth = await ctx.modelRegistry?.getProviderAuth?.("openai-codex");
    const accessToken = auth?.auth.apiKey?.trim();
    if (accessToken) return credentialsFromCodexAccessToken(accessToken, "pi-openai-codex");
  } catch {
    // Fall through to the Codex CLI login shared on this machine.
  }
  return readCodexSubscriptionCredentials(env);
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
  env: Record<string, string | undefined>,
): { model: ReturnType<typeof resolveConfiguredModel>; warning?: string } {
  const explicitModel = requestedModel?.trim();
  const model = resolveConfiguredModel(explicitModel || config.defaultModel, config.models);
  if (
    !explicitModel &&
    model.adapter === "openai-images" &&
    model.apiKeyEnv === "OPENAI_API_KEY" &&
    !env.OPENAI_API_KEY
  ) {
    const subscription = config.models["codex-subscription"];
    if (subscription) {
      return {
        model: subscription,
        warning: `OPENAI_API_KEY is unavailable; routed configured default '${model.id}' to Codex ChatGPT subscription image generation.`,
      };
    }
  }
  return { model };
}

async function modelCredentialStatus(
  model: ReturnType<typeof resolveConfiguredModel>,
  env: Record<string, string | undefined>,
  ctx: ExtensionContext,
): Promise<string> {
  if (model.adapter === "codex-subscription") {
    try {
      await resolveCodexCredentials(ctx, env);
      return "ready";
    } catch {
      return (await inspectCodexSubscriptionAuth(env)).state;
    }
  }
  return credentialStatus(model, env);
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
      `Dry run validated for ${details.model} (${details.adapter}).`,
      JSON.stringify(details.requestPreview, null, 2),
      details.warnings.length ? `Warnings:\n- ${details.warnings.join("\n- ")}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  const lines = [
    `Generated ${details.paths.length} image${details.paths.length === 1 ? "" : "s"} with ${details.model} (${details.adapter}).`,
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
          "Generate or edit images with the default Codex/ChatGPT subscription, configured OpenAI GPT Image/ChatGPT Image, Google Imagen, Gemini native image, or custom OpenAI-compatible model. Saves files and returns inline image previews. Use imagegen_models before choosing a non-default model.",
        parameters: imageGenParameters,
        executionMode: "parallel",

        async execute(_toolCallId, params, signal, onUpdate, ctx) {
          const config = loadConfig(ctx, dependencies);
          const env = currentEnv(dependencies);
          const selected = selectConfiguredModel(params.model, config, env);
          const model = selected.model;
          const mode = params.mode ?? (params.maskPath || (params.imagePaths?.length ?? 0) > 0 ? "edit" : "generate");
          const request: ImageGenRequest = { ...params, mode };
          const inputImages = await loadInputImages(request.imagePaths ?? [], ctx.cwd, config.maxImageBytes);
          const mask = request.maskPath ? await loadMask(request.maskPath, ctx.cwd, config.maxImageBytes) : undefined;
          const finalPrompt = buildFinalPrompt(request);
          const baseWarnings = [
            ...config.warnings,
            ...(selected.warning ? [selected.warning] : []),
            ...(transportWarning ? [transportWarning] : []),
          ];

          onUpdate?.({
            content: [{ type: "text", text: `${request.dryRun ? "Validating" : "Generating"} with ${model.id}…` }],
            details: {
              status: "running",
              mode,
              model: model.id,
              upstreamModel: model.model,
              adapter: model.adapter,
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
            env,
            resolveCodexSubscriptionCredentials: () => resolveCodexCredentials(ctx, env),
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
        description: "List configured image generation model aliases, adapters, capabilities, and credential readiness.",
        parameters: Type.Object({}),
        async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
          const env = currentEnv(dependencies);
          const config = loadConfig(ctx, dependencies);
          const models = await Promise.all(
            Object.values(config.models).map(async (model) => ({
              id: model.id,
              adapter: model.adapter,
              upstreamModel: model.model,
              credential: await modelCredentialStatus(model, env, ctx),
              credentialEnv: model.apiKeyEnv,
              capabilities: model.capabilities,
              description: model.description,
              isDefault: model.id === config.defaultModel,
            })),
          );
          const text = [
            `Default image model: ${config.defaultModel}`,
            ...models.map(
              (model) =>
                `${model.isDefault ? "*" : "-"} ${model.id} [${model.adapter}; ${model.credential}] — ${capabilitySummary(config.models[model.id]!)} — ${model.description}`,
            ),
            config.warnings.length ? `Warnings:\n- ${config.warnings.join("\n- ")}` : "",
          ]
            .filter(Boolean)
            .join("\n");
          return { content: [{ type: "text", text }], details: { defaultModel: config.defaultModel, models, warnings: config.warnings } };
        },
      }),
    );

    pi.registerCommand("imagegen", {
      description: "Show imagegen status, model list, and config paths",
      handler: async (args, ctx) => {
        const command = args.trim().toLowerCase();
        const config = loadConfig(ctx, dependencies);
        if (command === "models") {
          const env = currentEnv(dependencies);
          const lines = await Promise.all(
            Object.values(config.models).map(
              async (model) => `${model.id} — ${model.adapter} — ${await modelCredentialStatus(model, env, ctx)}`,
            ),
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
        const status = model ? await modelCredentialStatus(model, currentEnv(dependencies), ctx) : undefined;
        ctx.ui.notify(
          model
            ? `imagegen default: ${model.id} (${model.adapter}, ${status})\nOutput: ${config.outputDir}`
            : "imagegen has no available model.",
          model ? "info" : "error",
        );
      },
    });
  };
}

export default createImagegenExtension();
