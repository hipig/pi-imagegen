# Pi Imagegen

一个面向 Pi 的 OpenAI Images 生图与修图扩展。它注册 `image_gen` 和 `imagegen_models` 两个工具，复用当前 Pi 模型 provider 已解析的 API Key、base URL 与自定义 headers，请求同一 provider 的：

```text
POST <current-provider-base-url>/images/generations
POST <current-provider-base-url>/images/edits
```

当当前 base URL 以 `/v1` 结尾时，对应标准的 `/v1/images/generations` 与 `/v1/images/edits`。

扩展不再支持 ChatGPT/Codex subscription 生图，也不再维护独立的 `OPENAI_API_KEY`、`GEMINI_API_KEY`、Google Imagen 或 Gemini Image 鉴权路径。

## 凭据与路由

每次 `image_gen` 调用会通过 Pi 的：

```ts
ctx.modelRegistry.getApiKeyAndHeaders(ctx.model)
```

解析一次当前模型的最终凭据。该调用得到的 API Key、headers 和凭据级 base URL 会形成一次调用内不可变的鉴权快照；`n` 拆分出的多个请求及 429/5xx 重试复用同一份快照。

支持的当前 provider API 类型：

- `openai-responses`
- `openai-completions`

以下情况会在发起图片请求前失败：

- 当前 provider 是 `openai-codex` 或 API 类型是 `openai-codex-responses`
- 当前 provider 使用 Anthropic、Google、Azure 等非标准 `/v1/images` API 类型
- 当前 provider 没有向 Pi 暴露 API Key
- 当前 provider 的 base URL 不是有效的 HTTP(S) 地址

标准情况下扩展发送 `Authorization: Bearer <current-api-key>`。如果当前 provider 已解析出显式 `Authorization` header，则遵循 Pi 的 header 优先级并保留该值；其他当前 provider headers 也会传给同一 host 的图片端点。凭据不会写入工具结果、日志、图片路径或 `imagegen.json`。

通过 Pi 的 `/login`、`models.json`、provider 扩展或启动参数配置当前 provider。不要在聊天中粘贴 API Key。

## 能力

- 文生图、参考图生图、图片编辑、多图合成与 PNG mask 编辑
- Codex imagegen 风格结构化提示词：用途、场景、主体、构图、光线、材质、原样文字、约束与避坑项
- `n=1..10` 同提示词变体
- OpenAI Images 尺寸、质量、透明背景、输出格式/压缩、输入保真度与 moderation 参数
- 原图与可选 web 缩小副本落盘，默认不覆盖，自动追加 `-v2`、`-v3`
- MIME 魔数校验、输入/响应大小上限、超时、取消、429/5xx 重试与错误信息限长
- 全局配置与可信项目配置叠加；每次调用重新读取
- `dryRun` 不解析凭据、不访问网络，只验证当前 provider 类型、静态 base URL、请求参数和输入文件

图像生成具有随机性。插件可以统一提示词与参数工作流，但不能保证不同调用之间逐像素一致。

## 内置图片模型

图片模型与当前 Pi 的文本模型相互独立。当前 provider 决定 host 和凭据，`image_gen.model` 决定发送到 Images API 的图片模型 ID。

| 配置名 | 生成 | 编辑/参考 | Mask | 透明 | 说明 |
|---|---:|---:|---:|---:|---|
| `gpt-image-2` | ✓ | ✓ | ✓ | — | 默认；GPT Image 2 |
| `gpt-image-2-2026-04-21` | ✓ | ✓ | ✓ | — | 固定快照 |
| `chatgpt-image-latest` | ✓ | ✓ | ✓ | ✓ | ChatGPT Images 滚动别名 |
| `gpt-image-1.5` | ✓ | ✓ | ✓ | ✓ | 透明输出与高输入保真度 |
| `gpt-image-1` | ✓ | ✓ | ✓ | ✓ | 兼容模型 |
| `gpt-image-1-mini` | ✓ | ✓ | ✓ | ✓ | 低成本草图/变体 |

`gpt-image-2` 的透明背景与 `inputFidelity` 默认按当前兼容策略关闭；若所用 gateway 明确支持，可在配置中覆盖 capabilities。

## 安装

项目要求 Node.js 22.19 或更高版本，以及 Pi 0.84.4 或兼容版本。

```powershell
pi install "D:/Pi Extensions/pi-imagegen"
```

然后在 Pi 中执行：

```text
/reload
/imagegen status
/imagegen models
```

也可以临时加载扩展代码：

```powershell
pi --no-extensions -e "D:/Pi Extensions/pi-imagegen/src/index.ts"
```

## 配置

按优先级读取：

1. 全局：`~/.pi/agent/imagegen.json`，设置 `PI_CODING_AGENT_DIR` 时改用该目录
2. 可信项目：`<project>/.pi/imagegen.json`

项目配置会覆盖全局配置。配置只管理图片模型别名、能力边界、输出与网络限制：

```json
{
  "defaultModel": "gpt-image-2",
  "outputDir": "output/imagegen",
  "inlinePreviewLimit": 4,
  "models": {
    "gateway-flux": {
      "adapter": "openai-images",
      "model": "flux.1-dev",
      "description": "Flux model exposed by the active Pi gateway.",
      "capabilities": {
        "generate": true,
        "edit": false,
        "references": false,
        "mask": false,
        "transparency": false,
        "inputFidelity": false,
        "maxInputImages": 0,
        "maxOutputsPerRequest": 4
      }
    }
  }
}
```

模型键是传给 `image_gen.model` 的别名。新模型只能声明 `openai-images` adapter，其上游必须接受 OpenAI Images 请求并返回 `data[].b64_json` 或 `data[].url`。

`baseUrl`、`apiKeyEnv` 与 `headers` 不再属于图片模型配置。旧配置中的这些字段会被忽略并产生 warning，防止当前 Pi Key 被项目图片配置重定向到另一个 host。请在 Pi 当前 provider 的 `models.json` 或 provider 扩展中配置路由与鉴权。

将模型值设为 `false`、`null` 或 `{ "enabled": false }` 可禁用模型。`capabilities` 是发网前的能力边界；只有声明支持编辑、参考图、mask 或透明输出后，工具才会发送对应参数。

完整示例见 [imagegen.example.json](./imagegen.example.json)。

## 使用

```text
生成一个 1024x1024 app 图标，主体是极简蓝色纸飞机，保存到 assets/app-icon.png。
```

```text
把 @product.png 的背景换成温暖的摄影棚布景，只改背景，产品形状、标签文字和颜色必须保持不变。
```

常用参数：

- `mode`：`generate` 或 `edit`
- `imagePaths` / `inputRoles`：编辑目标、参考图及语义角色
- `model`：`imagegen_models` 列出的图片模型别名
- `n`：同一提示词的变体数
- `size`、`background`、`outputFormat`、`quality`、`inputFidelity`、`moderation`
- `exactText`、`constraints`、`negativePrompt` 与其他结构化提示字段
- `outputPath` / `outputDir`、`overwrite`、`downscaleMaxDim`
- `dryRun`：验证并输出脱敏请求，不解析 Key、不访问网络

`imagegen_models` 和 `/imagegen status` 会显示当前 provider、API 类型、base URL 与可用状态，但不会显示 API Key 或鉴权 headers。`/imagegen config` 会显示配置文件路径。

## 开发验证

```powershell
npm install
npm run check
npm pack --dry-run --json
```

测试使用本地 mock HTTP 响应，不消耗真实图片 API 配额。

## License

Apache-2.0。提示词工作流与兼容行为参考 Codex imagegen skill；OpenAI-compatible 调用遵循 Images API 的请求与响应形状。
