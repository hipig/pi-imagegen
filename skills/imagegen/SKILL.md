---
name: imagegen
description: Generate or edit images in Pi with Codex-style prompting and workflow. Use for image creation, illustrations, product mockups, logos, diagrams, UI mockups, marketing graphics, image editing, inpainting, compositing, style transfer, background changes, transparent assets, and multi-model image generation through the default Codex/ChatGPT subscription, OpenAI GPT Image/ChatGPT Image API, Google Imagen, Gemini native image models, or configured compatible endpoints.
---

# Image generation and editing

Use the `image_gen` tool for image work. It saves every output to disk and returns inline image previews. Use `imagegen_models` when the user asks for a particular provider/model, when the requested capability may not be supported, or when credentials/configuration need diagnosis.

## Core workflow

1. Determine whether this is generation, generation with references, or an edit.
2. Preserve the user's requirements. Do not invent characters, branding, text, objects, or style details that materially change the request.
3. Choose the model only when needed. Otherwise omit `model` and use the configured default.
4. Build a concise structured request using the fields below.
5. Invoke `image_gen`. For several distinct assets, make separate calls; use `n` only for variants of the same prompt.
6. Inspect the returned images. If a result misses a requirement, make one focused follow-up edit rather than rebuilding the entire prompt.
7. Report the saved paths and the model used. Mention any provider downgrade/ignored-parameter warnings.

Generated outputs are stochastic. Functional behavior and prompt semantics can match Codex/ChatGPT imagegen, but separate calls cannot be guaranteed pixel-identical.

## Model policy

- `codex-subscription`: default path; directly uses the local Codex ChatGPT OAuth login and subscription image entitlement with `gpt-image-2`. Prefer for general generation and editing when the user does not name a provider/model.
- `gpt-image-2`: OpenAI Platform API-key path for general high-quality generation and editing. Select only when the user/config explicitly wants Platform API behavior.
- `chatgpt-image-latest`: use when the user explicitly asks for the rolling ChatGPT Images model/effect.
- `gpt-image-1.5`: use for transparent output or explicit high input fidelity when the default model cannot provide it.
- `gpt-image-1-mini`: use for lower-cost drafts or broad variant exploration.
- `imagen-4.0-generate-001` / `imagen-4.0-ultra-generate-001`: generation-only Google Imagen paths; Ultra is the high-fidelity choice.
- `gemini-2.5-flash-image`: fast native image generation and conversational edits.
- `gemini-3-pro-image`: higher-quality Gemini generation, multi-image composition, and edits; supports provider-native image sizing up to 4K where available.

Never silently replace an explicitly requested model. If it lacks a required capability, explain the conflict and propose a compatible model. An implicit OpenAI default may fall back to `codex-subscription` only when `OPENAI_API_KEY` is unavailable; report the warning returned by the tool. Configured aliases may add local or third-party OpenAI-compatible image models.

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

Put critical invariants in `constraints`, especially for edits: “change only X; keep Y unchanged.” Put rendered copy in `exactText` exactly as the user supplied it. Use `negativePrompt` for concrete visual failures, not vague aesthetic language. Set `augmentPrompt: false` only when the user supplies a finished prompt that must be sent verbatim.

Useful `useCase` values include `photorealistic-natural`, `product-mockup`, `ui-mockup`, `infographic-diagram`, `scientific-educational`, `ads-marketing`, `logo-brand`, `illustration-story`, `identity-preserve`, `precise-object-edit`, `style-transfer`, `compositing`, and `sketch-to-render`.

## Inputs and editing

- Pass local raster paths through `imagePaths` in semantic order.
- Set `inputRoles` when there is more than one input, for example `edit target`, `identity reference`, `style reference`, or `layout reference`.
- Use `mode: edit` to modify an existing image. Editing requires at least one input image.
- Use `mode: generate` with `imagePaths` only for models that accept references and when the desired result is a new asset rather than a modification.
- A `maskPath` must be a PNG and is supported only by configured mask-capable models. Masked edits use exactly one target image.
- For identity or product preservation, use `inputFidelity: high` only on a model that advertises it and state the unchanged attributes in `constraints`.
- For a follow-up edit, use the previously generated output path as the first `imagePaths` item and write a new output unless the user explicitly asks to overwrite.

## Dimensions and output

- Codex subscription parity always sends `size=auto`, `quality=auto`, and `background=auto`; exact size/format controls are advisory prompt requirements and any downgrade appears in warnings.
- OpenAI Platform models accept `size` (`auto` or provider-supported `WIDTHxHEIGHT`).
- Google models prefer `aspectRatio` and `imageSize`. If `size` is used, the tool maps an exactly supported ratio but cannot promise exact pixels.
- Transparent output requires `background: transparent` and `outputFormat: png` or `webp`, plus a transparency-capable model.
- Default output location is `output/imagegen/`. Existing files are never replaced unless `overwrite: true`; version suffixes are added instead.
- Use `downscaleMaxDim` when the user also needs a web-sized copy.
- Do not use `dryRun` for normal generation. It is for provider/configuration diagnosis or when the user asks to inspect the wire request.

## Safety and credentials

Do not ask the user to paste API keys or OAuth tokens into chat. For `codex-subscription`, if `imagegen_models` reports `missing` or `expired`, first tell the user to use Pi `/login` and choose OpenAI Codex / ChatGPT Plus/Pro; the extension can also reuse a valid local Codex CLI login. Do not ask them to expose `auth.json`. For Platform/Google/custom models, tell them to set the environment variable shown by `imagegen_models` (normally `OPENAI_API_KEY` or `GEMINI_API_KEY`) and restart/reload Pi. Never place credentials in prompts, output paths, tool results, or checked-in configuration.
