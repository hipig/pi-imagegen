import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { BUILTIN_IMAGE_MODELS, loadImagegenConfig } from "../src/config.ts";
import { buildFinalPrompt } from "../src/prompt.ts";

test("built-in catalog contains only OpenAI Images models and defaults to GPT Image 2", () => {
  assert.equal(BUILTIN_IMAGE_MODELS["gpt-image-2"]?.adapter, "openai-images");
  assert.equal(BUILTIN_IMAGE_MODELS["chatgpt-image-latest"]?.adapter, "openai-images");
  assert.equal(BUILTIN_IMAGE_MODELS["gpt-image-2"]?.capabilities.transparency, false);
  assert.equal(BUILTIN_IMAGE_MODELS["codex-subscription"], undefined);
  assert.equal(BUILTIN_IMAGE_MODELS["gemini-3-pro-image"], undefined);

  const defaults = loadImagegenConfig("/virtual/project", false, {
    home: "/virtual/home",
    exists: () => false,
  });
  assert.equal(defaults.defaultModel, "gpt-image-2");
});

test("global and trusted project config merge image aliases without independent credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-imagegen-config-"));
  const home = join(root, "home");
  const cwd = join(root, "project");
  const globalDir = join(home, ".pi", "agent");
  const projectDir = join(cwd, ".pi");
  mkdirSync(globalDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });

  writeFileSync(
    join(globalDir, "imagegen.json"),
    JSON.stringify({
      defaultModel: "local-flux",
      outputDir: "global-images",
      models: {
        "local-flux": {
          adapter: "openai-images",
          model: "flux.dev",
          baseUrl: "https://ignored.invalid/v1",
          apiKeyEnv: "IGNORED_IMAGE_KEY",
          headers: { Authorization: "Bearer ${IGNORED_IMAGE_KEY}" },
          capabilities: { edit: false, references: false, mask: false, maxInputImages: 0 },
        },
        invalid: { adapter: "google-gemini", model: "gemini-image" },
      },
    }),
  );
  writeFileSync(
    join(projectDir, "imagegen.json"),
    JSON.stringify({
      outputDir: "project-images",
      models: {
        "gpt-image-1": false,
        "local-flux": { description: "Project Flux alias." },
      },
    }),
  );

  try {
    const config = loadImagegenConfig(cwd, true, { home, env: {} });
    assert.equal(config.defaultModel, "local-flux");
    assert.equal(config.outputDir, "project-images");
    assert.equal(config.models["local-flux"]?.model, "flux.dev");
    assert.equal(config.models["local-flux"]?.description, "Project Flux alias.");
    assert.equal(config.models["local-flux"]?.capabilities.edit, false);
    assert.equal(config.models["gpt-image-1"], undefined);
    assert.equal(config.models.invalid, undefined);
    assert.equal(config.loadedConfigPaths.length, 2);
    assert.match(config.warnings.join("\n"), /baseUrl is ignored/);
    assert.match(config.warnings.join("\n"), /apiKeyEnv is ignored/);
    assert.match(config.warnings.join("\n"), /headers is ignored/);
    assert.match(config.warnings.join("\n"), /adapter is unsupported: google-gemini/);

    const untrusted = loadImagegenConfig(cwd, false, { home, env: {} });
    assert.equal(untrusted.outputDir, "global-images");
    assert.ok(untrusted.models["gpt-image-1"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("removed subscription and Google adapters cannot be restored through config", () => {
  const config = loadImagegenConfig("/virtual/project", false, {
    home: "/virtual/home",
    exists: () => true,
    readFile: () =>
      JSON.stringify({
        defaultModel: "codex-subscription",
        models: {
          "codex-subscription": { adapter: "codex-subscription", model: "gpt-image-2" },
          "google-image": { adapter: "google-imagen", model: "imagen-4.0-generate-001" },
        },
      }),
  });

  assert.equal(config.models["codex-subscription"], undefined);
  assert.equal(config.models["google-image"], undefined);
  assert.equal(config.defaultModel, "gpt-image-2");
  assert.match(config.warnings.join("\n"), /adapter is unsupported: codex-subscription/);
  assert.match(config.warnings.join("\n"), /adapter is unsupported: google-imagen/);
  assert.match(config.warnings.join("\n"), /using 'gpt-image-2'/);
});

test("structured prompt preserves exact text and edit invariants", () => {
  const prompt = buildFinalPrompt({
    mode: "edit",
    prompt: "Replace the backdrop with a warm studio scene.",
    useCase: "product-mockup",
    assetType: "marketplace hero image",
    imagePaths: ["product.png", "lighting.jpg"],
    inputRoles: ["edit target", "lighting reference"],
    subject: "The existing bottle",
    exactText: "NORTH STAR",
    constraints: "Change only the background; preserve bottle geometry, label, and colors.",
    negativePrompt: "extra bottles, warped typography",
  });

  assert.match(prompt, /^Use case: product-mockup/m);
  assert.match(prompt, /Primary request: Replace the backdrop/);
  assert.match(prompt, /Image 1: edit target; Image 2: lighting reference/);
  assert.match(prompt, /Text \(verbatim\): "NORTH STAR"/);
  assert.match(prompt, /Constraints: Change only the background/);
  assert.match(prompt, /Avoid: extra bottles, warped typography/);
});

test("augmentPrompt false sends the user's prompt verbatim", () => {
  assert.equal(
    buildFinalPrompt({ mode: "generate", prompt: "  A finished provider prompt.  ", augmentPrompt: false }),
    "A finished provider prompt.",
  );
});
