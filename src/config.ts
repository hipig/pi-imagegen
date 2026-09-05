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

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const CODEX_SUBSCRIPTION_BASE_URL = "https://chatgpt.com/backend-api/codex";
const GOOGLE_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ADAPTERS = new Set<ImageAdapterName>([
  "codex-subscription",
  "openai-images",
  "google-imagen",
  "google-gemini",
]);

const CODEX_SUBSCRIPTION_CAPABILITIES: ModelCapabilities = {
  generate: true,
  edit: true,
  references: true,
  mask: false,
  transparency: true,
  inputFidelity: false,
  maxInputImages: 5,
  maxOutputsPerRequest: 1,
};

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
  // Matches the Codex imagegen compatibility policy. This can be overridden in imagegen.json.
  transparency: false,
  inputFidelity: false,
};

const IMAGEN_CAPABILITIES: ModelCapabilities = {
  generate: true,
  edit: false,
  references: false,
  mask: false,
  transparency: false,
  inputFidelity: false,
  maxInputImages: 0,
  maxOutputsPerRequest: 4,
};

const GEMINI_IMAGE_CAPABILITIES: ModelCapabilities = {
  generate: true,
  edit: true,
  references: true,
  mask: false,
  transparency: false,
  inputFidelity: false,
  maxInputImages: 16,
  maxOutputsPerRequest: 1,
};

function cloneCapabilities(value: ModelCapabilities): ModelCapabilities {
  return { ...value };
}

function builtInModel(
  id: string,
  adapter: ImageAdapterName,
  description: string,
  capabilities: ModelCapabilities,
): ImageModelDefinition {
  return {
    id,
    adapter,
    model: adapter === "codex-subscription" ? "gpt-image-2" : id,
    baseUrl:
      adapter === "codex-subscription"
        ? CODEX_SUBSCRIPTION_BASE_URL
        : adapter === "openai-images"
          ? OPENAI_BASE_URL
          : GOOGLE_BASE_URL,
    apiKeyEnv:
      adapter === "codex-subscription"
        ? undefined
        : adapter === "openai-images"
          ? "OPENAI_API_KEY"
          : "GEMINI_API_KEY",
    headers: {},
    description,
    capabilities: cloneCapabilities(capabilities),
  };
}

export const BUILTIN_IMAGE_MODELS: Readonly<Record<string, ImageModelDefinition>> = Object.freeze({
  "codex-subscription": builtInModel(
    "codex-subscription",
    "codex-subscription",
    "Codex/ChatGPT subscription image generation through the official Codex backend contract; no Platform API key required.",
    CODEX_SUBSCRIPTION_CAPABILITIES,
  ),
  "gpt-image-2": builtInModel(
    "gpt-image-2",
    "openai-images",
    "Codex CLI parity default; strongest current GPT Image generation and editing model.",
    GPT_IMAGE_2_CAPABILITIES,
  ),
  "gpt-image-2-2026-04-21": builtInModel(
    "gpt-image-2-2026-04-21",
    "openai-images",
    "Pinned GPT Image 2 snapshot.",
    GPT_IMAGE_2_CAPABILITIES,
  ),
  "chatgpt-image-latest": builtInModel(
    "chatgpt-image-latest",
    "openai-images",
    "Rolling ChatGPT Images production alias.",
    OPENAI_CAPABILITIES,
  ),
  "gpt-image-1.5": builtInModel(
    "gpt-image-1.5",
    "openai-images",
    "GPT Image 1.5; native transparent output and high-fidelity edit controls.",
    OPENAI_CAPABILITIES,
  ),
  "gpt-image-1": builtInModel(
    "gpt-image-1",
    "openai-images",
    "Legacy GPT Image model for compatibility.",
    OPENAI_CAPABILITIES,
  ),
  "gpt-image-1-mini": builtInModel(
    "gpt-image-1-mini",
    "openai-images",
    "Lower-cost GPT Image model for drafts and preview batches.",
    OPENAI_CAPABILITIES,
  ),
  "imagen-4.0-generate-001": builtInModel(
    "imagen-4.0-generate-001",
    "google-imagen",
    "Google Imagen 4 generation model.",
    IMAGEN_CAPABILITIES,
  ),
  "imagen-4.0-ultra-generate-001": builtInModel(
    "imagen-4.0-ultra-generate-001",
    "google-imagen",
    "Google Imagen 4 Ultra for highest-fidelity generation.",
    IMAGEN_CAPABILITIES,
  ),
  "imagen-3.0-generate-002": builtInModel(
    "imagen-3.0-generate-002",
    "google-imagen",
    "Google Imagen 3 compatibility model.",
    IMAGEN_CAPABILITIES,
  ),
  "gemini-2.5-flash-image": builtInModel(
    "gemini-2.5-flash-image",
    "google-gemini",
    "Fast Gemini native image generation and conversational editing.",
    GEMINI_IMAGE_CAPABILITIES,
  ),
  "gemini-3-pro-image": builtInModel(
    "gemini-3-pro-image",
    "google-gemini",
    "High-quality Gemini native image generation, multi-image composition, and editing.",
    GEMINI_IMAGE_CAPABILITIES,
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

function defaultCapabilities(adapter: ImageAdapterName): ModelCapabilities {
  if (adapter === "codex-subscription") return cloneCapabilities(CODEX_SUBSCRIPTION_CAPABILITIES);
  if (adapter === "google-imagen") return cloneCapabilities(IMAGEN_CAPABILITIES);
  if (adapter === "google-gemini") return cloneCapabilities(GEMINI_IMAGE_CAPABILITIES);
  return cloneCapabilities(OPENAI_CAPABILITIES);
}

function defaultBaseUrl(adapter: ImageAdapterName): string {
  if (adapter === "codex-subscription") return CODEX_SUBSCRIPTION_BASE_URL;
  return adapter === "openai-images" ? OPENAI_BASE_URL : GOOGLE_BASE_URL;
}

function defaultApiKeyEnv(adapter: ImageAdapterName): string | undefined {
  if (adapter === "codex-subscription") return undefined;
  return adapter === "openai-images" ? "OPENAI_API_KEY" : "GEMINI_API_KEY";
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function cloneModels(): Record<string, ImageModelDefinition> {
  return Object.fromEntries(
    Object.entries(BUILTIN_IMAGE_MODELS).map(([id, model]) => [
      id,
      {
        ...model,
        headers: { ...model.headers },
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

function mergeHeaders(
  current: Record<string, string>,
  value: unknown,
  warningPrefix: string,
  warnings: string[],
): Record<string, string> {
  if (value === undefined) return { ...current };
  if (!isRecord(value)) {
    warnings.push(`${warningPrefix}.headers must be an object; keeping existing headers.`);
    return { ...current };
  }

  const next = { ...current };
  for (const [name, rawValue] of Object.entries(value)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
      warnings.push(`${warningPrefix}.headers contains an invalid header name; ignoring it.`);
      continue;
    }
    if (rawValue === null || rawValue === false) {
      delete next[name];
    } else if (typeof rawValue === "string" && !/[\r\n]/.test(rawValue)) {
      next[name] = rawValue;
    } else {
      warnings.push(`${warningPrefix}.headers.${name} must be a single-line string or null; ignoring it.`);
    }
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
    let upstreamModel = nonEmptyString(rawOverride.model) ?? (sameAdapter ? current.model : undefined) ?? id;
    let baseUrlCandidate = normalizeBaseUrl(
      nonEmptyString(rawOverride.baseUrl) ?? (sameAdapter ? current.baseUrl : defaultBaseUrl(adapter)),
    );
    if (adapter === "codex-subscription") {
      if (upstreamModel !== "gpt-image-2") {
        warnings.push(`${warningPrefix}.model is fixed to gpt-image-2 for Codex subscription parity; ignoring '${upstreamModel}'.`);
      }
      if (baseUrlCandidate !== CODEX_SUBSCRIPTION_BASE_URL) {
        warnings.push(`${warningPrefix}.baseUrl cannot override the official Codex subscription endpoint; ignoring it.`);
      }
      upstreamModel = "gpt-image-2";
      baseUrlCandidate = CODEX_SUBSCRIPTION_BASE_URL;
    }
    try {
      const parsedBaseUrl = new URL(baseUrlCandidate);
      if (parsedBaseUrl.protocol !== "https:" && parsedBaseUrl.protocol !== "http:") {
        throw new Error("only HTTP(S) URLs are supported");
      }
    } catch (error) {
      warnings.push(
        `${warningPrefix}.baseUrl is invalid: ${error instanceof Error ? error.message : String(error)}; ignoring this model.`,
      );
      continue;
    }
    let apiKeyEnv: string | undefined = sameAdapter ? current.apiKeyEnv : defaultApiKeyEnv(adapter);
    if (Object.hasOwn(rawOverride, "apiKeyEnv")) {
      const requestedEnv = nonEmptyString(rawOverride.apiKeyEnv);
      if (requestedEnv && !ENV_NAME_PATTERN.test(requestedEnv)) {
        warnings.push(`${warningPrefix}.apiKeyEnv is not a valid environment variable name; ignoring this model.`);
        continue;
      }
      apiKeyEnv = requestedEnv;
    }
    if (adapter === "codex-subscription") {
      if (Object.hasOwn(rawOverride, "apiKeyEnv")) {
        warnings.push(`${warningPrefix}.apiKeyEnv is ignored because Codex subscription uses ChatGPT OAuth.`);
      }
      apiKeyEnv = undefined;
    }
    if (adapter === "codex-subscription" && rawOverride.headers !== undefined) {
      warnings.push(`${warningPrefix}.headers are ignored to prevent OAuth credential forwarding.`);
    }

    models[id] = {
      id,
      adapter,
      model: upstreamModel,
      baseUrl: baseUrlCandidate,
      apiKeyEnv,
      headers:
        adapter === "codex-subscription"
          ? {}
          : mergeHeaders(sameAdapter ? current.headers : {}, rawOverride.headers, warningPrefix, warnings),
      description: nonEmptyString(rawOverride.description) ?? current?.description ?? `Custom ${adapter} image model.`,
      capabilities: applyCapabilityOverrides(
        sameAdapter ? current.capabilities : defaultCapabilities(adapter),
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
    defaultModel: "codex-subscription",
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
    const fallback =
      state.models["codex-subscription"]
        ? "codex-subscription"
        : state.models["gpt-image-2"]
          ? "gpt-image-2"
          : Object.keys(state.models)[0];
    if (fallback) {
      warnings.push(`Configured default model '${state.defaultModel}' is unavailable; using '${fallback}'.`);
      state.defaultModel = fallback;
    }
  }

  return { ...state, loadedConfigPaths, warnings };
}

function interpolateEnvironment(value: string, env: Record<string, string | undefined>): string {
  const escapedDollar = "\u0000PI_IMAGEGEN_DOLLAR\u0000";
  const protectedValue = value.replaceAll("$$", escapedDollar);
  const replaced = protectedValue.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, braced, plain) => {
    const name = (braced ?? plain) as string;
    const resolved = env[name];
    if (resolved === undefined) throw new Error(`Required environment variable '${name}' is not set.`);
    return resolved;
  });
  return replaced.replaceAll(escapedDollar, "$");
}

export function resolveModelHeaders(
  model: ImageModelDefinition,
  env: Record<string, string | undefined>,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (model.apiKeyEnv) {
    const key = env[model.apiKeyEnv];
    if (!key) {
      throw new Error(
        `Model '${model.id}' requires ${model.apiKeyEnv}. Set it in your environment; do not paste API keys into chat.`,
      );
    }
    if (model.adapter === "openai-images") headers.Authorization = `Bearer ${key}`;
    else headers["x-goog-api-key"] = key;
  }

  for (const [name, value] of Object.entries(model.headers)) {
    headers[name] = interpolateEnvironment(value, env);
  }
  return headers;
}

export function credentialStatus(
  model: ImageModelDefinition,
  env: Record<string, string | undefined>,
): "ready" | "missing" | "not-required" {
  if (!model.apiKeyEnv) return "not-required";
  return env[model.apiKeyEnv] ? "ready" : "missing";
}
