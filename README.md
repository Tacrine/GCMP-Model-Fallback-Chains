# Copilot Model Fallback Router（`copilot-model-fallback`）

> 一个为 VS Code Copilot 提供**跨提供商自动回退（fallback）复合模型**的扩展。注册 `fallbackrouter` 语言模型提供商，把多个上游模型组合成一条有序链：前一个目标失败时自动切换到下一个，让 agent 会话在单个中继/网关故障时存活下来。

---

## English Summary

**Copilot Model Fallback Router** registers a `languageModelChatProviders` vendor named `fallbackrouter` and exposes composite models such as `fallbackrouter:deepseek` (display name `deepseek (fallback)`). Each composite model is an ordered chain of upstream targets (direct HTTP to OpenAI-compatible endpoints, or proxy delegation to existing BYOK providers like GCMP). If a target fails — timeout, stall, HTTP 5xx, or (optionally) rate limit — the next target in the chain is tried automatically, mid-stream when safe.

**Wiring (important):** this extension CANNOT intercept Copilot's built-in model picker. You must either select the composite model manually in the picker, or point settings at it — `chat.planAgent.defaultModel`, `chat.exploreAgent.defaultModel`, `chat.utilityModel` etc. See [接线方式](#接线方式重要) below for exact keys and value formats.

**Honest limits:** there is no official fallback API; the extension host does not retry provider calls; and when every target in a chain fails, the task will still stop (an interruption cannot be eliminated, only made much rarer). See [诚实边界](#诚实边界limitations).

---

## 这是什么？它解决什么问题？

Copilot Chat / agent 会话（plan、explore 等）把请求发给单一语言模型提供商。一旦该提供商的中继、网关或上游出现故障，整个 agent 会话就会中断——已经进行的推理、工具调用上下文全部作废，用户只能重开任务。

在真实使用中这类故障并不罕见（测量到的请求失败率约为 **5.5%**，这里仅作为说明性动机数据，并非本扩展自身的失败率）。本扩展的思路是：**与其依赖单一目标，不如把多个目标串成链**——第一个失败就尝试下一个，把"一次会话中断"变成"一次几秒钟的透明切换"。

## 工作原理

- 扩展注册语言模型提供商 `fallbackrouter`，并暴露**复合模型**：
  - 模型 id：`fallbackrouter:<chainId>`（如 `fallbackrouter:deepseek`）
  - 显示名：`<chain.name> (fallback)`（如 `deepseek (fallback)`）
  - 能力取链内目标的最小公集（`maxInputTokens` / `maxOutputTokens` 取各目标最小值，工具调用能力为"任一目标支持即可"）。
- 一条**链（chain）**是若干**目标（target）**的有序列表，按顺序尝试：
  - `http` 目标：直连 OpenAI 兼容端点（`/chat/completions` 或 `/responses`）。
  - `proxy` 目标：委托给已有 BYOK 提供商（如 `gcmp.compatible`）注册的模型。
- 切换时机（混合中流策略）：
  - 首个内容块输出**之前**失败：静默切换，用户无感知；
  - 已输出文本后失败：切换时插入一条可见通知（样式由 `fallbackRouter.noticeStyle` 控制）；
  - **工具调用之后**失败：不再切换，中止当前轮次（切换工具调用结果不安全）。
- 每一轮受 `fallbackRouter.maxTargetsPerTurn` 与 `fallbackRouter.maxTurnMs` 约束，避免无限重试拖死会话。

## 快速开始

1. 安装扩展（VS Code ≥ 1.106，激活事件 `onLanguageModelChatProvider:fallbackrouter`）。
2. 在设置中配置 `fallbackRouter.chains`（至少一条链、每个链至少一个目标；也可用 `fallbackrouter.manage` 里的 "Import GCMP config" 从 `gcmp.compatibleModels` 一键生成，再 `fallbackrouter.apply` 应用）。
3. 为 `http` 目标录入密钥：命令面板运行 **Fallback Router: Set API Key**（`fallbackrouter.setApiKey`），密钥存入 VS Code SecretStorage，不会明文落盘。
4. 按下方[接线方式](#接线方式重要)把 Copilot 指向复合模型。
5. 用 **Fallback Router: Show Diagnostics**（`fallbackrouter.showDiagnostics`）自检：确认 `selfCheck` 列出 `fallbackrouter:<chainId>`。

## 接线方式（重要）

> ⚠️ 本扩展**无法**拦截 Copilot 已有的模型选择器。Copilot 只会看到 `fallbackrouter` 提供商下的复合模型，你必须显式选择或配置它，二选一：

**(a) 在模型选择器中手动选择**：在 Copilot 模型选择器里选择复合模型（显示名 `<chain.name> (fallback)`，如 `deepseek (fallback)`）。简单直接，但每个会话都要手动选一次。

**(b) 把相关设置指向复合模型**（推荐，一劳永逸）。注意两类设置键的**值格式不同**：

| 设置键 | 值格式 | 示例 |
|---|---|---|
| `chat.planAgent.defaultModel` | `<chain.name> (fallback)`（显示名） | `deepseek (fallback)` |
| `chat.exploreAgent.defaultModel` | `<chain.name> (fallback)`（显示名） | `deepseek (fallback)` |
| `inlineChat.defaultModel` | `<chain.name> (fallback)`（显示名） | `deepseek (fallback)` |
| `chat.utilityModel` | `fallbackrouter/fallbackrouter:<chainId>`（vendor/id 格式） | `fallbackrouter/fallbackrouter:deepseek` |
| `chat.utilitySmallModel` | `fallbackrouter/fallbackrouter:<chainId>`（vendor/id 格式） | `fallbackrouter/fallbackrouter:deepseek` |

`settings.json` 示例：

```jsonc
{
  "chat.planAgent.defaultModel": "deepseek (fallback)",
  "chat.exploreAgent.defaultModel": "deepseek (fallback)",
  "inlineChat.defaultModel": "deepseek (fallback)",
  "chat.utilityModel": "fallbackrouter/fallbackrouter:deepseek",
  "chat.utilitySmallModel": "fallbackrouter/fallbackrouter:deepseek"
}
```

也可以运行 **Fallback Router: Set default model**（`fallbackrouter.set-default-model`）：它会自动写入 `chat.planAgent.defaultModel`、`chat.exploreAgent.defaultModel`、`chat.utilityModel` 三个键（值格式如上），并在写入前先回环校验复合模型可解析，解析失败则拒绝写入。

## 配置参考

完整字段表见 [docs/configuration.md](docs/configuration.md)。这里给出速览（所有默认值来自 `package.json` 与 `src/config.ts`）：

| 键 | 默认值 | 说明 |
|---|---|---|
| `fallbackRouter.chains` | `[]` | 复合模型链：有序目标列表，失败时按序切换 |
| `fallbackRouter.retry` | `{maxAttempts:3, initialDelayMs:1000, backoffFactor:2, maxDelayMs:15000}` | 单目标重试策略（指数退避） |
| `fallbackRouter.circuitBreaker` | `{failureThreshold:3, cooldownMs:60000}` | 单目标熔断器 |
| `fallbackRouter.timeouts` | `{connectMs:10000, headersMs:15000, firstByteMs:60000, stallMs:120000}` | HTTP 各阶段墙钟预算 |
| `fallbackRouter.maxTurnMs` | `600000` | 整链墙钟截止时间 |
| `fallbackRouter.maxTargetsPerTurn` | `5` | 每轮最多尝试的目标数 |
| `fallbackRouter.importMode` | `family` | GCMP 导入分组模式（`family` \| `exact`） |
| `fallbackRouter.retryOnRateLimit` | `false` | 是否把限流（429 / `rateLimited` / `quotaExceeded`）视为可重试 |
| `fallbackRouter.noticeStyle` | `markdown` | 中流切换通知样式（`markdown` \| `plain`） |
| `fallbackRouter.logLevel` | `info` | 输出面板日志级别（`off` \| `error` \| `info` \| `debug`） |

### 目标（Target）两种形态

```jsonc
// http 目标：直连 OpenAI 兼容端点（A2，官方路径）
{
  "kind": "http",
  "baseUrl": "https://example.com/v1",
  "model": "some-model",
  "secretRef": "gcmp.someprovider",           // 密钥存于 SecretStorage: fallbackrouter.<secretRef>
  "apiType": "chat-completions",              // 或 "responses"
  "customHeader": { "Authorization": "..." }, // 可选，优先级最高
  "modelsEndpoint": "/models",                // 可选，probe 用
  "maxInputTokens": 128000, "maxOutputTokens": 4096,
  "toolCalling": true, "imageInput": false
}

// proxy 目标：委托给已有 BYOK 提供商（A1）
{ "kind": "proxy", "vendor": "gcmp.compatible", "modelId": "some-provider/some-model" }
```

### 墙钟与限流语义（务必理解）

- **`fallbackRouter.timeouts`**（HTTP 目标）分阶段计时，全部是墙钟（wall-clock）预算：
  - `connectMs` + `headersMs`：从发起请求到收到响应头（含 TCP 建连）的总预算；
  - `firstByteMs`：收到响应头后、等待**第一个**流式字节的预算；
  - `stallMs`：流式传输开始后，**相邻两个数据块之间**的静默预算——"连接被接受（TCP accept）后不再发声"这类故障由它兜住。
- **`fallbackRouter.maxTurnMs`**：整条链从开始到结束的硬截止时间，超时抛 `Turn deadline exceeded (maxTurnMs=...)`。
- **`fallbackRouter.maxTargetsPerTurn`**：每轮最多尝试前 N 个目标，防止链过长拖死会话。
- **`fallbackRouter.retryOnRateLimit`**（默认 `false`）：Copilot 的设计意图是**不因限流重试**，本扩展默认保持一致——429 / `rateLimited` / `quotaExceeded` 默认**不重试**（但会尝试下一个目标；设为 `true` 才把限流视为可重试）。5xx（500/502/503/504）与网络错误（`ECONNREFUSED`、`ETIMEDOUT`、超时、停滞）默认可重试；401/403 不可重试。

## A1 与 A2：两种接入方式对比

- **A1 — ProxyTransport（`proxy` 目标）**：通过 `vscode.lm.selectChatModels({vendor, id})` 复用已有 BYOK 提供商（如 GCMP）注册的模型与密钥。**优点**：无需为本扩展再次录入任何 API key，直接复用现有提供商的身份与计费。**缺点**：依赖 `selectChatModels` 委托与 provider 协商的**未文档化行为**；`fallbackrouter.warmup` 只能报告目标是否可解析（`canSendRequest` 因无法泛化解析 `LanguageModelAccessInformation` 而标记为 `n/a`）；且禁止把 `fallbackrouter` 自身作为 proxy 供应商（防递归）。
- **A2 — HttpTransport（`http` 目标）**：官方路径——直连 OpenAI 兼容端点（`/chat/completions` 或 `/responses`，SSE 流式），支持 `customHeader`、`modelsEndpoint`、probe 测试。**优点**：行为确定、可控（分阶段超时、熔断、令牌统计都精确）。**缺点**：需要录入 API key（`fallbackrouter.setApiKey`，存 SecretStorage）并配置 `baseUrl`/`model`/`secretRef`。

一般建议：已有可用 BYOK 提供商时用 A1（零密钥成本），追求确定性与可控性时用 A2。

## 命令

| 命令 id | 标题 | 作用 |
|---|---|---|
| `fallbackrouter.setApiKey` | Fallback Router: Set API Key for target | 为某个 `http` 目标录入 API key（密码输入框），存入 SecretStorage（键 `fallbackrouter.<secretRef>`） |
| `fallbackrouter.warmup` | Fallback Router: Warm up proxy targets | 对每个 `proxy` 目标执行 `selectChatModels` 解析，报告找到的模型数量与 id，验证配置是否可解析 |
| `fallbackrouter.manage` | Fallback Router: Manage | 链管理 UI：选择链后可增/删目标、上下移动、测试单个目标、导入 GCMP 配置、打开设置 |
| `fallbackrouter.apply` | Fallback Router: Apply imported chains | 读取剪贴板中的链 JSON 数组，写入 `fallbackRouter.chains`（全局），写后回环校验模型可解析，失败自动回滚 |
| `fallbackrouter.set-default-model` | Fallback Router: Set default model | 选择复合模型并写入 `chat.planAgent.defaultModel` / `chat.exploreAgent.defaultModel` / `chat.utilityModel`（写入前校验可解析，否则拒绝） |
| `fallbackrouter.showDiagnostics` | Fallback Router: Show diagnostics | 自检（`selfCheck` 列出 `fallbackrouter:<chainId>`）+ 输出所有链与目标清单，打开 markdown 文档并写日志 |
| `fallbackrouter.cleanup` | Fallback Router: Clean up stored data | 删除所有已存 API key（SecretStorage `fallbackrouter.*`）与 `globalState` 中的熔断状态（`fallbackrouter.breaker.*`） |

### 关于 `managementCommand` 弃用

`package.json` 中 `contributes.languageModelChatProviders` 目前仍声明 `"managementCommand": "fallbackrouter.manage"`，但 VS Code 已弃用该字段（其官方替代 `configuration` 目前仍是 proposed-only API）。本扩展在可预见的版本中继续使用 `managementCommand`；迁移路径：待 `configuration` 字段稳定后，将其替换为 `configuration`（指向设置项而非命令），管理入口随之迁移到设置 UI。详见 [docs/configuration.md §8](docs/configuration.md#8-managementcommand-弃用说明)。

## 安全说明

- **密钥只存 VS Code SecretStorage**：`fallbackrouter.setApiKey` 通过 `context.secrets.store('fallbackrouter.<secretRef>', key)` 写入，由 VS Code 托管，**不会明文落盘**。代码中所有读取都是 `context.secrets.get('fallbackrouter.<ref>')`。
- **日志脱敏**：`src/util/redact.ts` 的 `redact()` 把所有已知密钥（长度 ≥ 4）替换为 `***`，并正则清洗 `authorization` / `api-key` / `x-api-key` 头值；输出面板、状态栏、诊断、错误对象全部经过同一脱敏入口（`src/observability.ts`）。
- **不读取其他扩展的密钥**：本扩展只读写自己管理的 `fallbackrouter.*` 密钥；GCMP 导入仅读取公共配置 `gcmp.compatibleModels`，不触碰 GCMP 的 SecretStorage。SecretStorage 没有枚举 API，扩展只跟踪自己写入过的引用。
- **清理**：`fallbackrouter.cleanup` 可一键删除全部已存密钥与熔断状态。

## 诚实边界（Limitations）

- **无法拦截 Copilot 已有的模型选择器**：本扩展不能劫持模型选择，只能提供新的复合模型供你选择或配置（见[接线方式](#接线方式重要)）。
- **扩展宿主不会重试 provider 调用**：VS Code 的 agent 循环不会因为 provider 返回错误而自动重试同一轮；重试只发生在本扩展内部（`fallbackRouter.retry`），一旦整链失败，错误会原样上抛。
- **没有官方 fallback API**：Copilot 目前只有用户可见的 Auto 模型选择，不存在官方的"自动回退"开关；本扩展是基于 `languageModelChatProviders` 扩展点自行实现的。
- **整链全部失败时，任务仍会停止（will stop）**：本扩展把中断概率从"单个目标故障即中断"降到"所有目标同时故障才中断"，但**无法消除**所有中断。
- 官方参考资料：
  - https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider
  - https://code.visualstudio.com/docs/agent-customization/language-models
  - https://code.visualstudio.com/api/references/vscode-api#languageModelChatProviders

## 故障排查

- **所有目标都失败，任务还是停了**：这是设计行为。错误信息形如 `... (chain=<chainId>, target=...)`，可在 Chat 错误详情或输出面板（"Fallback Router"）中看到是哪个链、哪个目标最后失败。
- **如何定位**：运行 **Fallback Router: Show Diagnostics**（`fallbackrouter.showDiagnostics`）。先看 `selfCheck` 是否列出 `fallbackrouter:<chainId>`（没有则说明链未注册成功，检查 `fallbackRouter.chains` 结构与日志中的 dropped 警告）；再看各目标清单。`fallbackRouter.logLevel` 设为 `debug` 可看到每个 HTTP 目标的请求与超时细节。
- **API key 缺失**：`http` 目标缺少密钥会得到 `API key missing for <secretRef>; run "Fallback Router: Set API Key"` 的明确提示，按提示运行 `fallbackrouter.setApiKey` 即可。
- **熔断器如何复位**：目标连续失败达到 `failureThreshold`（默认 3）后熔断器打开（`open`），在 `cooldownMs`（默认 60s）内跳过该目标；冷却结束后自动进入 `halfOpen`（半开），放行**单个**探测请求——成功则复位为 `closed` 并清零失败计数，失败则立即重新打开并刷新冷却。熔断状态持久化在 `globalState`（`fallbackrouter.breaker.*`），也可用 `fallbackrouter.cleanup` 一键清除。
- **proxy 目标不可用**：先确认对应 BYOK 提供商已安装并注册了模型，再运行 `fallbackrouter.warmup` 验证解析结果。

## 文档

- 完整配置字段参考：[docs/configuration.md](docs/configuration.md)
- 变更记录：[CHANGELOG.md](CHANGELOG.md)

## License

MIT
