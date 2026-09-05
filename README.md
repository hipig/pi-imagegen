# Pi Imagegen Multi-Model

一个面向 Pi 的 Codex/ChatGPT 风格生图扩展与配套 skill。它注册 `image_gen` 和 `imagegen_models` 两个工具，默认复用 Pi 的 `openai-codex` OAuth（或本机 Codex 的 ChatGPT 登录）并直连 Codex 图片端点；也可在同一套工作流下接入 OpenAI GPT Image、ChatGPT Image、Google Imagen、Gemini 原生图片模型，以及可配置的 OpenAI-compatible 第三方/本地模型。

生成结果会安全落盘，同时作为 base64 图片块返回给 Pi，因此模型与 TUI 可以直接预览并继续做局部编辑。

## 能力

- 文生图、参考图生图、图片编辑、多图合成和 OpenAI PNG mask 编辑
- Codex imagegen 风格的结构化提示词：用途、场景、主体、构图、光线、材质、原样文字、约束和避坑项
- `n=1..10` 同提示词变体；不同资产应由 agent 并行发起不同工具调用
- 尺寸、质量、透明背景、输出格式/压缩、输入保真度，以及 Google 原生 `aspectRatio` / `imageSize`
- 原图与可选 web 缩小副本落盘，默认不覆盖，自动追加 `-v2`、`-v3`
- MIME 魔数校验、输入/响应大小上限、超时、取消、429/5xx 重试、错误信息限长
- 默认 `codex-subscription` 直接调用 Codex 的 ChatGPT 订阅图片端点，不启动 Codex agent/exe，也不要求 `OPENAI_API_KEY`
- API Key 只从环境变量读取；订阅 OAuth 优先使用 Pi 的 `openai-codex` 凭据存储，也可从环境变量或本机 Codex `auth.json` 读取；工具结果不会输出凭据
- 全局和可信项目配置叠加；每次调用重新读取，修改后无需重启扩展进程
- `dryRun` 可在不调用供应商、不要求 API Key 的情况下验证并查看脱敏请求

图像生成具有随机性。插件可对齐 Codex/ChatGPT imagegen 的功能、参数语义和提示词工作流，但无法保证两次独立调用或不同模型之间逐像素一致。

## 内置模型

| 配置名 | Adapter | 生成 | 编辑/参考 | Mask | 透明 | 说明 |
|---|---|---:|---:|---:|---:|---|
| `codex-subscription` | Codex subscription | ✓ | ✓ | — | ✓* | **默认**；ChatGPT/Codex OAuth，固定使用 `gpt-image-2` 与 Codex `auto` 参数 |
| `gpt-image-2` | OpenAI Images API | ✓ | ✓ | ✓ | — | Platform API Key 路径；与 Codex wire model 一致 |
| `gpt-image-2-2026-04-21` | OpenAI Images | ✓ | ✓ | ✓ | — | 固定快照 |
| `chatgpt-image-latest` | OpenAI Images | ✓ | ✓ | ✓ | ✓ | ChatGPT Images 滚动别名 |
| `gpt-image-1.5` | OpenAI Images | ✓ | ✓ | ✓ | ✓ | 透明输出与输入保真度 fallback |
| `gpt-image-1` | OpenAI Images | ✓ | ✓ | ✓ | ✓ | 兼容模型 |
| `gpt-image-1-mini` | OpenAI Images | ✓ | ✓ | ✓ | ✓ | 低成本草图/变体 |
| `imagen-4.0-generate-001` | Google Imagen | ✓ | — | — | — | Imagen 4 |
| `imagen-4.0-ultra-generate-001` | Google Imagen | ✓ | — | — | — | Imagen 4 Ultra |
| `imagen-3.0-generate-002` | Google Imagen | ✓ | — | — | — | Imagen 3 兼容路径 |
| `gemini-2.5-flash-image` | Google Gemini | ✓ | ✓ | — | — | 快速生成与对话式编辑 |
| `gemini-3-pro-image` | Google Gemini | ✓ | ✓ | — | — | 高质量、多图合成和原生尺寸控制 |

`codex-subscription` 的透明背景通过提示词表达，但 wire 参数与 Codex 内置工具一致，始终使用 `background=auto`，因此不能保证 alpha 输出。`gpt-image-2` 的透明背景与 `inputFidelity` 默认按 Codex imagegen 兼容策略关闭；如公开 API 能力发生变化，可以在配置中显式覆盖 capabilities。

## 安装

项目要求 Node.js 22.19 或更高版本，以及 Pi 0.84.4 或兼容版本。

在 PowerShell 中执行本地安装：

```powershell
pi install "D:/Pi Extensions/pi-imagegen"
```

然后在 Pi 中执行：

```text
/reload
/imagegen status
/imagegen models
```

也可以仅临时加载扩展代码（不会自动安装配套 skill）：

```powershell
pi --no-extensions -e "D:/Pi Extensions/pi-imagegen/src/index.ts"
```

本仓库不会替你修改全局 Pi 配置，也不会自动执行全局安装。

## Codex 订阅默认与认证

没有 `imagegen.json` 时，默认模型是 `codex-subscription`。它不会调用 `codex.exe` 来生成图片，而是按 OpenAI Codex 开源实现的协议直接请求：

```text
POST https://chatgpt.com/backend-api/codex/images/generations
POST https://chatgpt.com/backend-api/codex/images/edits
```

认证按以下优先级读取：

1. Pi 的 `openai-codex` OAuth 凭据（通过 Pi 的 model registry 解析；到期时由 Pi 的串行凭据存储安全刷新）
2. `CODEX_ACCESS_TOKEN` 加 `CHATGPT_ACCOUNT_ID`（主要用于受控运行环境）
3. `$CODEX_HOME/auth.json`
4. `~/.codex/auth.json`

可在 Pi 中使用 `/login` 并选择 OpenAI Codex / ChatGPT Plus/Pro。若 Pi 尚未登录，扩展会自动尝试本机 Codex CLI 的现有 ChatGPT 登录。

扩展只使用 OAuth `access_token` 与 ChatGPT account ID，不输出 token、不把它写入 Pi 配置，也不会把 OAuth header 发往可配置的第三方地址。订阅 adapter 的 host、wire model 和自定义 headers 均被锁定；项目配置无法把凭据重定向到其他服务器。

Pi 管理的 `openai-codex` OAuth 会通过 Pi 自身的凭据存储刷新。Codex CLI `auth.json` fallback 则保持只读：扩展不会自行交换或写回其中的 refresh token。若 fallback access token 已过期，先在 Codex 中重新登录或发起一次正常请求让 Codex 刷新 `auth.json`，再重试。`/imagegen status` 和 `imagegen_models` 会显示 `ready`、`expired`、`missing` 或 `invalid`，不会显示凭据值。

此路径复用 ChatGPT/Codex 产品订阅权益与其限额，不走 OpenAI Platform API Key 计费；它是 Codex 开源客户端公开的产品后端契约，而不是承诺长期稳定的公开 Platform API。服务端可变更端点、模型、资格或限额，扩展会明确报错而不会偷偷切换到付费 API。

若配置默认模型是使用 `OPENAI_API_KEY` 的 OpenAI Images 模型、调用时没有显式传 `model`，且 Key 不存在，扩展会回退到 `codex-subscription`。显式选择模型时绝不静默替换。

## API Key

只有使用 OpenAI Platform、Google 或自定义供应商模型时才需要相应 Key。根据模型设置环境变量，然后从同一终端启动 Pi：

```powershell
$env:OPENAI_API_KEY = "..."
$env:GEMINI_API_KEY = "..."
pi
```

不要把密钥写进提示词、聊天消息或提交到仓库。`imagegen_models` 会显示某个模型的凭据状态和所需环境变量名，但不会显示值。

## 配置

按优先级读取：

1. 全局：`~/.pi/agent/imagegen.json`（若设置 `PI_CODING_AGENT_DIR`，则位于该目录）
2. 可信项目：`<project>/.pi/imagegen.json`

项目配置会覆盖全局配置。复制 [imagegen.example.json](./imagegen.example.json) 即可开始：

```json
{
  "defaultModel": "codex-subscription",
  "outputDir": "output/imagegen",
  "inlinePreviewLimit": 4,
  "models": {
    "local-flux": {
      "adapter": "openai-images",
      "model": "flux.1-dev",
      "baseUrl": "http://127.0.0.1:8000/v1",
      "apiKeyEnv": null,
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

模型键是传给 `image_gen.model` 的别名。`codex-subscription` 是受保护的内置 adapter：固定直连官方 Codex host、使用 `gpt-image-2`，并忽略配置中的 `baseUrl`、`apiKeyEnv` 和自定义 headers。其他新模型必须声明以下 adapter 之一：

- `openai-images`：调用 `<baseUrl>/images/generations` 和 `<baseUrl>/images/edits`；兼容端点必须返回 OpenAI 风格 `data[].b64_json` 或 `data[].url`
- `google-imagen`：调用 Gemini Developer API 的 `models/<model>:predict`
- `google-gemini`：调用 `models/<model>:generateContent` 并解析 `inlineData`

将模型值设为 `false`、`null` 或 `{ "enabled": false }` 可禁用内置模型。`apiKeyEnv: null` 表示端点不使用 adapter 的默认 Key；可以通过 headers 引用环境变量：

```json
{
  "models": {
    "private-gateway": {
      "adapter": "openai-images",
      "model": "vendor-model",
      "baseUrl": "https://images.example.com/v1",
      "apiKeyEnv": null,
      "headers": {
        "Authorization": "Bearer ${PRIVATE_IMAGE_API_KEY}"
      }
    }
  }
}
```

`capabilities` 是安全边界。第三方模型只有在这里声明支持编辑、参考图、mask 或透明输出后，工具才会发送对应请求，避免把参数静默发给不支持的供应商。

## 使用

安装后直接用自然语言要求 Pi 生图即可，配套 `imagegen` skill 会组织工具参数。例如：

```text
生成一个透明背景的 1024x1024 app 图标，主体是极简蓝色纸飞机，保存到 assets/app-icon.png。
```

```text
把 @product.png 的背景换成温暖的摄影棚布景，只改背景，产品形状、标签文字和颜色必须保持不变。
```

```text
用 gemini-3-pro-image 把 @sketch.png 转成 16:9 的高保真产品渲染，并同时保存最长边 1400px 的 web 版本。
```

工具的重要参数：

- `mode`: `generate` 或 `edit`
- `imagePaths` / `inputRoles`: 编辑目标和参考图及其语义角色
- `model`: `imagegen_models` 列出的配置别名
- `n`: 同一提示词的变体数
- `size` 或 Google 的 `aspectRatio` / `imageSize`
- `background`, `outputFormat`, `quality`, `inputFidelity`
- `exactText`, `constraints`, `negativePrompt` 与其他结构化提示字段
- `outputPath` / `outputDir`, `overwrite`, `downscaleMaxDim`
- `dryRun`: 只验证和输出脱敏请求

`/imagegen config` 会显示全局、项目和实际加载的配置路径。

## 供应商差异

统一参数层只映射供应商明确支持的能力：

- Codex subscription 直接使用 JSON generation/edit endpoints；编辑输入是 data URL，最多 5 张，`n>1` 会拆成独立请求；尺寸、质量和背景 wire 参数固定为 `auto`，其他无法表达的参数会进入 warnings。
- OpenAI Platform 使用 Images generation/edit endpoints，输入图会通过 multipart 发送。
- Imagen 是 generation-only；`size` 只能转换为供应商支持的精确宽高比，像素尺寸由供应商控制。
- Gemini 原生图片模型通过 `generateContent` 完成生成与编辑；输出 MIME 由模型决定。
- 某个 adapter 不支持的非关键参数会出现在结果 warnings 中；关键能力冲突（例如 Imagen 编辑、非透明模型请求透明背景）会在网络请求前失败。

## 开发验证

```powershell
npm install
npm run check
npm pack --dry-run --json
```

测试使用本地 mock HTTP 响应，不会消耗真实图像 API 配额。

## License

Apache-2.0。提示词工作流与兼容行为参考本机 Codex 官方 imagegen skill（同为 Apache-2.0）；Codex 订阅请求契约参考 OpenAI Codex 开源实现，其他供应商调用基于公开 API/SDK 形状实现。
