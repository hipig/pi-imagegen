import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type {
  ImageAdapterName,
  ImageModelDefinition,
  ImagegenConfig,
  ModelCapabilities,
} from "./types.ts";

export const IMAGEGEN_CONFIG_FILE = "imagegen.json";
export const DEFAULT_OUTPUT_DIR = "output/imagegen";
export const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;
export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_MAX_IMAGE_BYTES = 50 * 1024 * 1024;
export const DEFAULT_MAX_RESPONSE_BYTES = 120 * 1024 * 1024;
export const DEFAULT_INLINE_PREVIEW_LIMIT = 4;

const ADAPTERS = new Set<ImageAdapterName>(["openai-images"]);

const OPENAI_CAPABILITIES: ModelCapabilities = {
  generate: true,
  edit: true,
  references: true,
  mask: true,
  transparency: true,
  inputFidelity: true,
  maxInputImages: 16,
  maxOutputsPerRequest: 10,
};

const GPT_IMAGE_2_CAPABILITIES: ModelCapabilities = {
  ...OPENAI_CAPABILITIES,
  // Conservative defaults; gateways may opt into newer capabilities in imagegen.json.
  transparency: false,
  inputFidelity: false,
};

function cloneCapabilities(value: ModelCapabilities): ModelCapabilities {
  return { ...value };
}

function builtInModel(
  id: string,
  description: string,
  capabilities: ModelCapabilities,
): ImageModelDefinition {
  return {
    id,
    adapter: "openai-images",
    model: id,
    description,
    capabilities: cloneCapabilities(capabilities),
  };
}

export const BUILTIN_IMAGE_MODELS: Readonly<Record<string, ImageModelDefinition>> = Object.freeze({
  "gpt-image-2": builtInModel(
    "gpt-image-2",
    "Default GPT Image generation and editing model.",
    GPT_IMAGE_2_CAPABILITIES,
  ),
  "gpt-image-2-2026-04-21": builtInModel(
    "gpt-image-2-2026-04-21",
    "Pinned GPT Image 2 snapshot.",
    GPT_IMAGE_2_CAPABILITIES,
  ),
  "chatgpt-image-latest": builtInModel(
    "chatgpt-image-latest",
    "Rolling ChatGPT Images production alias.",
    OPENAI_CAPABILITIES,
  ),
  "gpt-image-1.5": builtInModel(
    "gpt-image-1.5",
    "GPT Image 1.5; native transparent output and high-fidelity edit controls.",
    OPENAI_CAPABILITIES,
  ),
  "gpt-image-1": builtInModel(
    "gpt-image-1",
    "Legacy GPT Image model for compatibility.",
    OPENAI_CAPABILITIES,
  ),
  "gpt-image-1-mini": builtInModel(
    "gpt-image-1-mini",
    "Lower-cost GPT Image model for drafts and preview batches.",
    OPENAI_CAPABILITIES,
  ),
});

export interface ImagegenConfigLoadOptions {
  env?: Record<string, string | undefined>;
  home?: string;
  exists?: (path: string) => boolean;
  readFile?: (path: string, encoding: "utf8") => string;
  projectConfigDirName?: string;
}

interface MutableConfigState {
  defaultModel: string;
  outputDir: string;
  requestTimeoutMs: number;
  maxAttempts: number;
  maxImageBytes: number;
  maxResponseBytes: number;
  inlinePreviewLimit: number;
  models: Record<string, ImageModelDefinition>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    return undefined;
  }
  return value;
}

function defaultCapabilities(): ModelCapabilities {
  return cloneCapabilities(OPENAI_CAPABILITIES);
}

function cloneModels(): Record<string, ImageModelDefinition> {
  return Object.fromEntries(
    Object.entries(BUILTIN_IMAGE_MODELS).map(([id, model]) => [
      id,
      {
        ...model,
        capabilities: cloneCapabilities(model.capabilities),
      },
    ]),
  );
}

function applyCapabilityOverrides(
  base: ModelCapabilities,
  value: unknown,
  warningPrefix: string,
  warnings: string[],
): ModelCapabilities {
  if (value === undefined) return cloneCapabilities(base);
  if (!isRecord(value)) {
    warnings.push(`${warningPrefix}.capabilities must be an object; keeping existing capabilities.`);
    return cloneCapabilities(base);
  }

  const next = cloneCapabilities(base);
  for (const key of [
    "generate",
    "edit",
    "references",
    "mask",
    "transparency",
    "inputFidelity",
  ] as const) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== "boolean") {
      warnings.push(`${warningPrefix}.capabilities.${key} must be boolean; ignoring it.`);
      continue;
    }
    next[key] = value[key];
  }

  for (const key of ["maxInputImages", "maxOutputsPerRequest"] as const) {
    if (value[key] === undefined) continue;
    const parsed = boundedInteger(value[key], key === "maxInputImages" ? 0 : 1, key === "maxInputImages" ? 16 : 10);
    if (parsed === undefined) {
      warnings.push(`${warningPrefix}.capabilities.${key} is outside the supported range; ignoring it.`);
      continue;
    }
    next[key] = parsed;
  }

  return next;
}

function applyModelOverrides(
  models: Record<string, ImageModelDefinition>,
  value: unknown,
  sourceLabel: string,
  warnings: string[],
): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    warnings.push(`${sourceLabel}: models must be an object; ignoring it.`);
    return;
  }

  for (const [id, rawOverride] of Object.entries(value)) {
    const warningPrefix = `${sourceLabel}: models.${id}`;
    if (!id.trim()) {
      warnings.push(`${sourceLabel}: empty model aliases are not allowed; ignoring one entry.`);
      continue;
    }
    if (rawOverride === false || rawOverride === null) {
      delete models[id];
      continue;
    }
    if (!isRecord(rawOverride)) {
      warnings.push(`${warningPrefix} must be an object, false, or null; ignoring it.`);
      continue;
    }
    if (rawOverride.enabled === false) {
      delete models[id];
      continue;
    }

    const current = models[id];
    const requestedAdapter = nonEmptyString(rawOverride.adapter);
    if (requestedAdapter && !ADAPTERS.has(requestedAdapter as ImageAdapterName)) {
      warnings.push(`${warningPrefix}.adapter is unsupported: ${requestedAdapter}`);
      continue;
    }
    const adapter = (requestedAdapter as ImageAdapterName | undefined) ?? current?.adapter;
    if (!adapter) {
      warnings.push(`${warningPrefix}.adapter is required for a new model; ignoring it.`);
      continue;
    }

    const sameAdapter = current?.adapter === adapter;
    for (const key of ["baseUrl", "apiKeyEnv", "headers"] as const) {
      if (Object.hasOwn(rawOverride, key)) {
        warnings.push(`${warningPrefix}.${key} is ignored; image requests reuse the active Pi provider route and API key.`);
      }
    }

    models[id] = {
      id,
      adapter,
      model: nonEmptyString(rawOverride.model) ?? (sameAdapter ? current.model : undefined) ?? id,
      description: nonEmptyString(rawOverride.description) ?? current?.description ?? `Custom ${adapter} image model.`,
      capabilities: applyCapabilityOverrides(
        sameAdapter ? current.capabilities : defaultCapabilities(),
        rawOverride.capabilities,
        warningPrefix,
        warnings,
      ),
    };
  }
}

function applyConfigDocument(
  state: MutableConfigState,
  value: unknown,
  sourceLabel: string,
  warnings: string[],
): void {
  if (!isRecord(value)) {
    warnings.push(`${sourceLabel}: root value must be a JSON object; ignoring it.`);
    return;
  }

  state.defaultModel = nonEmptyString(value.defaultModel) ?? state.defaultModel;
  state.outputDir = nonEmptyString(value.outputDir) ?? state.outputDir;
  state.requestTimeoutMs = boundedInteger(value.requestTimeoutMs, 1_000, 1_800_000) ?? state.requestTimeoutMs;
  state.maxAttempts = boundedInteger(value.maxAttempts, 1, 10) ?? state.maxAttempts;
  state.maxImageBytes = boundedInteger(value.maxImageBytes, 1_048_576, 209_715_200) ?? state.maxImageBytes;
  state.maxResponseBytes = boundedInteger(value.maxResponseBytes, 1_048_576, 524_288_000) ?? state.maxResponseBytes;
  state.inlinePreviewLimit = boundedInteger(value.inlinePreviewLimit, 0, 10) ?? state.inlinePreviewLimit;
  applyModelOverrides(state.models, value.models, sourceLabel, warnings);
}

function expandHome(input: string, home: string): string {
  if (input === "~") return home;
  if (input.startsWith("~/") || input.startsWith("~\\")) return join(home, input.slice(2));
  return input;
}

export function resolveGlobalImagegenConfigPath(options: ImagegenConfigLoadOptions = {}): string {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const piDir = env.PI_CODING_AGENT_DIR?.trim();
  return piDir
    ? join(resolve(expandHome(piDir, home)), IMAGEGEN_CONFIG_FILE)
    : join(home, ".pi", "agent", IMAGEGEN_CONFIG_FILE);
}

export function resolveProjectImagegenConfigPath(
  cwd: string,
  options: ImagegenConfigLoadOptions = {},
): string {
  return join(cwd, options.projectConfigDirName ?? CONFIG_DIR_NAME, IMAGEGEN_CONFIG_FILE);
}

export function loadImagegenConfig(
  cwd: string,
  projectTrusted: boolean,
  options: ImagegenConfigLoadOptions = {},
): ImagegenConfig {
  const exists = options.exists ?? existsSync;
  const readFile = options.readFile ?? ((path: string, encoding: "utf8") => readFileSync(path, encoding));
  const warnings: string[] = [];
  const loadedConfigPaths: string[] = [];
  const state: MutableConfigState = {
    defaultModel: "gpt-image-2",
    outputDir: DEFAULT_OUTPUT_DIR,
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    maxImageBytes: DEFAULT_MAX_IMAGE_BYTES,
    maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
    inlinePreviewLimit: DEFAULT_INLINE_PREVIEW_LIMIT,
    models: cloneModels(),
  };

  const candidates = [resolveGlobalImagegenConfigPath(options)];
  if (projectTrusted) candidates.push(resolveProjectImagegenConfigPath(cwd, options));

  for (const path of candidates) {
    if (!exists(path)) continue;
    try {
      const parsed = JSON.parse(readFile(path, "utf8")) as unknown;
      applyConfigDocument(state, parsed, path, warnings);
      loadedConfigPaths.push(path);
    } catch (error) {
      warnings.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (!state.models[state.defaultModel]) {
    const fallback = state.models["gpt-image-2"] ? "gpt-image-2" : Object.keys(state.models)[0];
    if (fallback) {
      warnings.push(`Configured default model '${state.defaultModel}' is unavailable; using '${fallback}'.`);
      state.defaultModel = fallback;
    }
  }

  return { ...state, loadedConfigPaths, warnings };
}
