---
name: imagegen
description: Generate or edit images in Pi with Codex-style prompting and workflow. Use for image creation, illustrations, product mockups, logos, diagrams, UI mockups, marketing graphics, image editing, inpainting, compositing, style transfer, background changes, transparent assets, and multi-model OpenAI-compatible image generation through the active Pi provider's API key and /v1/images endpoints.
---

# Image generation and editing

Use the `image_gen` tool for image work. It saves every output to disk and returns inline image previews. Requests reuse the active Pi model provider's resolved API key, base URL, and headers. Use `imagegen_models` when the requested image model or capability may not be supported, or when current-provider compatibility needs diagnosis.

## Core workflow

1. Determine whether this is generation, generation with references, or an edit.
2. Preserve the user's requirements. Do not invent characters, branding, text, objects, or style details that materially change the request.
3. Choose the image model only when needed. Otherwise omit `model` and use the configured default.
4. Build a concise structured request using the fields below.
5. Invoke `image_gen`. For several distinct assets, make separate calls; use `n` only for variants of the same prompt.
6. Inspect the returned images. If a result misses a requirement, make one focused follow-up edit rather than rebuilding the entire prompt.
7. Report the saved paths, image model, and active provider. Mention ignored-parameter or provider warnings.

Generated outputs are stochastic. Functional behavior and prompt semantics can match Codex/ChatGPT imagegen, but separate calls cannot be guaranteed pixel-identical.

## Provider and model policy

- The active Pi provider must use `openai-responses` or `openai-completions`, expose an API key, and implement OpenAI-compatible `/images/generations` and `/images/edits` endpoints beneath its base URL.
- `openai-codex` and ChatGPT/Codex subscription credentials are not supported. Never route around this restriction or copy OAuth tokens into another endpoint.
- `gpt-image-2` is the default image model for general generation and editing.
- `chatgpt-image-latest` is for an explicitly requested rolling ChatGPT Images model/effect.
- `gpt-image-1.5` is for transparent output or explicit high input fidelity when the default model's configured capabilities do not provide it.
- `gpt-image-1-mini` is for lower-cost drafts or broad variant exploration.
- Configured aliases may expose other models through the active provider's OpenAI-compatible Images endpoints.

Never silently replace an explicitly requested image model. If it lacks a required capability, explain the conflict and propose a compatible configured model.

## Prompt structure

When `augmentPrompt` is omitted or true, fill only the relevant fields. The tool creates this structure:

- Use case and asset type
- Primary request
- Input image roles
- Scene/backdrop
- Subject and key details
- Style/medium
- Composition/framing
- Lighting/mood
- Palette
- Materials/textures
- Text verbatim
- Constraints
- Avoid list

Put critical invariants in `constraints`, especially for edits: "change only X; keep Y unchanged." Put rendered copy in `exactText` exactly as the user supplied it. Use `negativePrompt` for concrete visual failures, not vague aesthetic language. Set `augmentPrompt: false` only when the user supplies a finished prompt that must be sent verbatim.

Useful `useCase` values include `photorealistic-natural`, `product-mockup`, `ui-mockup`, `infographic-diagram`, `scientific-educational`, `ads-marketing`, `logo-brand`, `illustration-story`, `identity-preserve`, `precise-object-edit`, `style-transfer`, `compositing`, and `sketch-to-render`.

## Inputs and editing

- Pass local raster paths through `imagePaths` in semantic order.
- Set `inputRoles` when there is more than one input, for example `edit target`, `identity reference`, `style reference`, or `layout reference`.
- Use `mode: edit` to modify an existing image. Editing requires at least one input image.
- Use `mode: generate` with `imagePaths` only for models configured to accept references and when the desired result is a new asset rather than a modification.
- A `maskPath` must be a PNG and is supported only by configured mask-capable models. Masked edits use exactly one target image.
- For identity or product preservation, use `inputFidelity: high` only on a model that advertises it and state the unchanged attributes in `constraints`.
- For a follow-up edit, use the previously generated output path as the first `imagePaths` item and write a new output unless the user explicitly asks to overwrite.

## Dimensions and output

- Use `size` as `auto` or a provider-supported `WIDTHxHEIGHT` value.
- Transparent output requires `background: transparent` and `outputFormat: png` or `webp`, plus a transparency-capable configured model.
- Default output location is `output/imagegen/`. Existing files are never replaced unless `overwrite: true`; version suffixes are added instead.
- Use `downscaleMaxDim` when the user also needs a web-sized copy.
- Do not use `dryRun` for normal generation. It is for provider/configuration diagnosis or when the user asks to inspect the wire request.

## Safety and credentials

Do not ask the user to paste API keys or OAuth tokens into chat. If `imagegen_models` reports the active provider as unavailable, ask the user to select an API-key-backed OpenAI-compatible Pi provider and configure it through Pi `/login`, `models.json`, or the provider's documented setup. Do not inspect or expose `auth.json`. The tool must never place credentials in prompts, output paths, results, logs, or checked-in configuration.
