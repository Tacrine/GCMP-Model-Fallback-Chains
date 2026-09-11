# 配置参考（Configuration Reference）

本文档是 `copilot-model-fallback`（Copilot Model Fallback Router）的完整配置字段参考。所有键均属于 `contributes.configuration`，在 VS Code 设置中以 `fallbackRouter.*` 前缀出现；默认值来自 `package.json` 与 `src/config.ts` 中的 `normalizeConfig`。

> 值校验规则：非法值不会被拒绝写入，而是**回退到默认值**并在输出面板（"Fallback Router"）记录 warning；结构非法的链会被整体丢弃（计入 `droppedChains`）。

## 1. 顶层字段

| 键 | 类型 | 默认值 | 枚举 | 说明 |
|---|---|---|---|---|
| `fallbackRouter.chains` | `array` | `[]` | — | 复合模型链数组。每条链是有序目标列表，按序尝试，失败切换下一个。 |
| `fallbackRouter.retry` | `object` | 见 §2 | — | 单目标重试策略（指数退避）。 |
| `fallbackRouter.circuitBreaker` | `object` | 见 §3 | — | 单目标熔断器。 |
| `fallbackRouter.timeouts` | `object` | 见 §4 | — | HTTP 传输各阶段墙钟预算。 |
| `fallbackRouter.maxTurnMs` | `number` | `600000`（10 分钟） | — | 整条链从开始到结束的硬截止时间；超时抛 `Turn deadline exceeded (maxTurnMs=...)`。必须为正数，非法回退默认。 |
| `fallbackRouter.maxTargetsPerTurn` | `number` | `5` | — | 每轮最多尝试的目标数量（取链前 N 个）；范围 1–100，越界回退默认。 |
| `fallbackRouter.importMode` | `string` | `family` | `family` \| `exact` | GCMP 导入分组模式，见 §6。 |
| `fallbackRouter.retryOnRateLimit` | `boolean` | `false` | — | 是否把限流错误（HTTP 429、`rateLimited`、`quotaExceeded`）视为可重试。默认 `false`，与 Copilot"不因限流重试"的意图一致。 |
| `fallbackRouter.noticeStyle` | `string` | `markdown` | `markdown` \| `plain` | 中流切换（已输出文本后切换目标）时可见通知的样式。 |
| `fallbackRouter.logLevel` | `string` | `info` | `off` \| `error` \| `info` \| `debug` | 输出面板（"Fallback Router"）日志级别；非法值回退 `info`。 |

### 默认值汇总（`src/config.ts`）

```jsonc
{
  "chains": [],
  "retry": { "maxAttempts": 3, "initialDelayMs": 1000, "backoffFactor": 2, "maxDelayMs": 15000 },
  "circuitBreaker": { "failureThreshold": 3, "cooldownMs": 60000 },
  "timeouts": { "connectMs": 10000, "headersMs": 15000, "firstByteMs": 60000, "stallMs": 120000 },
  "maxTurnMs": 600000,
  "maxTargetsPerTurn": 5,
  "importMode": "family",
  "retryOnRateLimit": false,
  "noticeStyle": "markdown",
  "logLevel": "info"
}
```

## 2. `fallbackRouter.retry`（单目标重试）

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `maxAttempts` | `number` | `3` | 单目标最大尝试次数；范围 1–10，越界回退默认。 |
| `initialDelayMs` | `number` | `1000` | 首次重试前等待（毫秒）；必须为正数。 |
| `backoffFactor` | `number` | `2` | 退避倍数；必须为正数。 |
| `maxDelayMs` | `number` | `15000` | 退避等待的上限（毫秒）；必须为正数。 |

行为：目标失败且错误被判定为**可重试**时，按 `initialDelayMs × backoffFactor^n` 退避重试，最多 `maxAttempts` 次；超过后**切换到下一个目标**（如果有）。

### 可重试性判定（`src/router/router.ts` 的 `classifyRetryable`）

- **可重试**：网络错误（`ECONNREFUSED`、`ETIMEDOUT`、`fetch failed`、超时、中止、停滞）、HTTP 500/502/503/504、流中解析出的对应错误码。
- **不可重试**：HTTP 401/403（鉴权失败）、`missingApiKey`（未录入密钥）、HTTP 429 / `rateLimited` / `quotaExceeded`（**除非** `retryOnRateLimit: true`）。
- 注意：不可重试的错误同样会**切换到下一个目标**（回退逻辑与重试无关），只是不对当前目标做退避重试。

## 3. `fallbackRouter.circuitBreaker`（单目标熔断）

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `failureThreshold` | `number` | `3` | 连续失败多少次后熔断打开；范围 1–100，越界回退默认。 |
| `cooldownMs` | `number` | `60000` | 熔断打开后的冷却时长（毫秒）；必须为正数。 |

状态机（`src/router/circuitBreaker.ts`）：

- `closed`（关闭）：正常放行。连续失败达到 `failureThreshold` 次 → `open`。
- `open`（打开）：在 `cooldownMs` 内**跳过**该目标（直接进入下一个目标）。冷却结束后自动转为 `halfOpen`。
- `halfOpen`（半开）：放行**单个**探测请求——成功 → 复位 `closed` 并清零失败计数；失败 → 立即重新 `open` 并刷新冷却。
- 状态按 `fallbackrouter.breaker.<targetKey>` 持久化在 `context.globalState`，重启 VS Code 后保留；`fallbackrouter.cleanup` 可一键清除。状态栏会显示 `FR: <chain> · open/halfOpen`。

## 4. `fallbackRouter.timeouts`（HTTP 传输墙钟预算）

| 字段 | 类型 | 默认值 | 阶段 | 说明 |
|---|---|---|---|---|
| `connectMs` | `number` | `10000` | 建连 + 响应头 | 与 `headersMs` 合计为"从发起到收到响应头"的总预算（`Promise.race([fetch, timeout(connectMs + headersMs)])`）。 |
| `headersMs` | `number` | `15000` | 建连 + 响应头 | 见上；两者合计默认 25s。 |
| `firstByteMs` | `number` | `60000` | 首个流式字节 | 收到响应头后、等待第一个数据块的预算；超时判定为可重试失败。 |
| `stallMs` | `number` | `120000` | 流式传输中 | 相邻两个数据块之间的静默预算。"连接被接受（TCP accept）后不再发声"这类故障由它兜住——一旦流开始后两个块之间静默超过 `stallMs`，判定停滞并切换目标。 |

所有字段必须为正数，非法回退默认。注意：这些预算只约束 HTTP 传输本身；整链还受 `maxTurnMs` 约束。超时错误被判定为可重试（触发退避重试与下一个目标切换）。

## 5. `fallbackRouter.chains`（链与目标）

```ts
interface Chain {
  id: string;                 // [a-zA-Z0-9_-]+，唯一；复合模型 id 为 fallbackrouter:<id>
  name: string;               // 显示名；复合模型显示名为 "<name> (fallback)"，缺省取 id
  targets: Target[];          // 有序，非空
}
```

### 5.1 `http` 目标（A2，官方路径，直连 OpenAI 兼容端点）

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `kind` | `"http"` | 是 | — | 目标类型。 |
| `baseUrl` | `string` | 是 | — | 基础地址，如 `https://example.com/v1`；与端点拼接。 |
| `model` | `string` | 是 | — | 上游模型标识，原样透传。 |
| `secretRef` | `string` | 是（空串也合法，见下） | — | API key 的引用名；密钥存于 SecretStorage 键 `fallbackrouter.<secretRef>`。若目标通过 `customHeader.Authorization` 提供鉴权，可留空。 |
| `apiType` | `"chat-completions"` \| `"responses"` | 是 | — | 请求端点与协议：`/chat/completions`（chat-completions）或 `/responses`（responses，`input` 格式 + `tool_choice`）。 |
| `customHeader` | `object` | 否 | — | 逐字附加的请求头，**优先级最高**（含 `Authorization`，存在时不使用 SecretStorage 密钥）。 |
| `modelsEndpoint` | `string` | 否 | `/models` | probe（`fallbackrouter.manage` 中的 "Test this target"）使用的端点。 |
| `maxInputTokens` | `number` | 否 | `128000` | 输入上限；链的 `maxInputTokens` 取各目标最小值。 |
| `maxOutputTokens` | `number` | 否 | `4096` | 输出上限；链的 `maxOutputTokens` 取各目标最小值。 |
| `toolCalling` | `boolean` | 否 | `true` | 是否支持工具调用；`false` 时该目标在需要工具的场景会被 preflight 跳过。 |
| `imageInput` | `boolean` | 否 | `false` | 是否支持图像输入；`true` 且所有目标都支持时，链才声明图像能力。 |

鉴权：运行时 `Authorization: Bearer <key>` 来自 SecretStorage（`context.secrets.get('fallbackrouter.<secretRef>')`）；若 `customHeader` 已提供 `Authorization`，则以 `customHeader` 为准。密钥缺失且无自定义 Authorization 时，该目标快速失败并提示运行 `fallbackrouter.setApiKey`。

### 5.2 `proxy` 目标（A1，委托已有 BYOK 提供商）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `kind` | `"proxy"` | 是 | 目标类型。 |
| `vendor` | `string` | 是 | 已有 BYOK 提供商的 vendor（如 `gcmp.compatible`）。**禁止 `fallbackrouter`**（自递归，会被丢弃）。 |
| `modelId` | `string` | 是 | 通过 `vscode.lm.selectChatModels({vendor, id})` 可解析的模型 id。 |

鉴权：复用 BYOK 提供商自身的模型与密钥，**本扩展不接触**这些密钥（见 README 安全说明）。preflight 不做能力检查（委托给上游 provider），解析不到模型时快速失败并提示检查配置或安装对应 BYOK 提供商。

### 5.3 校验与丢弃规则（`normalizeChains`）

- 链 `id` 必须匹配 `^[a-zA-Z0-9_-]+$` 且不重复；否则丢弃。
- 链目标必须非空；否则整链丢弃。
- 目标 `kind` 必须为 `http` 或 `proxy`；`http` 目标缺 `baseUrl`/`model` 或 `apiType` 非法 → 跳过该目标。
- 同一链内重复目标（`http:<baseUrl>/<model>` 或 `proxy:<vendor>/<modelId>`）→ 跳过。
- 单目标链合法但无回退能力，配置加载时给出 warning。
- 被丢弃的链计入 `droppedChains`；`fallbackrouter.apply` 在写入前用同一校验做"写前结构验证"，不合格即拒绝应用。

### 5.4 示例

```jsonc
"fallbackRouter.chains": [
  {
    "id": "deepseek",
    "name": "deepseek",
    "targets": [
      {
        "kind": "http",
        "baseUrl": "https://example.com/v1",
        "model": "deepseek-chat",
        "secretRef": "gcmp.deepseek",
        "apiType": "chat-completions",
        "toolCalling": true
      },
      {
        "kind": "proxy",
        "vendor": "gcmp.compatible",
        "modelId": "some-provider/some-model"
      }
    ]
  }
]
```

## 6. GCMP 导入（`fallbackRouter.importMode` 与 `fallbackrouter.manage` → "Import GCMP config"）

读取 VS Code 公共配置 `gcmp.compatibleModels`（不读取 GCMP 的 SecretStorage），为每个条目生成 `http` 目标：

- `apiType` 由 `sdkMode` 映射：`openai` → `chat-completions`；`openai-responses` → `responses`；其他值跳过该条目。
- `secretRef = "gcmp." + (provider ?? id)`——即密钥约定为 `fallbackrouter.gcmp.<provider>`。
- 缺 `baseUrl` 或 `model` 的条目跳过（记录 skipped 原因）。
- **`family` 模式（默认）**：按"家族名"分组——去掉 `vendor/` 前缀后取第一个 `-` 之前的小写片段（如 `some-vendor/deepseek-chat` → `deepseek`）。
- **`exact` 模式**：按精确模型 id 分组，非 `[a-zA-Z0-9_-]` 字符替换为 `_`。
- 组内目标按 `secretRef` 再 `model` 排序，保证草稿链顺序稳定；链 id 取分组键。
- 导入结果写入剪贴板并打开一个未命名文档（内含 `// <mode> mode: N chains / M targets` 注释），之后运行 **Fallback Router: Apply imported chains**（`fallbackrouter.apply`）将其写入 `fallbackRouter.chains`（全局）；写后会做回环校验（确认 `fallbackrouter:<chainId>` 可解析），失败自动回滚。

## 7. 命令一览

| 命令 id | 标题 | 说明 |
|---|---|---|
| `fallbackrouter.setApiKey` | Fallback Router: Set API Key for target | 为 `http` 目标录入密钥 → SecretStorage `fallbackrouter.<secretRef>` |
| `fallbackrouter.warmup` | Fallback Router: Warm up proxy targets | 解析并报告所有 `proxy` 目标的模型可见性 |
| `fallbackrouter.manage` | Fallback Router: Manage | 链管理 UI（增删/排序/测试目标、导入 GCMP、打开设置） |
| `fallbackrouter.apply` | Fallback Router: Apply imported chains | 剪贴板 JSON → `fallbackRouter.chains`（写前验证 + 写后回环，失败回滚） |
| `fallbackrouter.set-default-model` | Fallback Router: Set default model | 写入 `chat.planAgent.defaultModel` / `chat.exploreAgent.defaultModel` / `chat.utilityModel`（先校验可解析） |
| `fallbackrouter.showDiagnostics` | Fallback Router: Show diagnostics | 自检 + 链/目标清单（markdown 文档 + 日志） |
| `fallbackrouter.cleanup` | Fallback Router: Clean up stored data | 删除全部密钥（`fallbackrouter.*`）与熔断状态（`fallbackrouter.breaker.*`） |

## 8. `managementCommand` 弃用说明

`package.json` 中 `contributes.languageModelChatProviders` 目前仍声明 `"managementCommand": "fallbackrouter.manage"`。VS Code 已弃用该字段（其官方替代 `configuration` 目前仍是 proposed-only API，稳定扩展无法使用）。因此本扩展在可预见的版本中继续使用 `managementCommand`；迁移路径：待 `configuration` 字段稳定后，将 `managementCommand` 替换为 `configuration`（声明指向设置项而非命令），并把"管理入口"迁移到设置 UI 中。删除 `managementCommand` 本身不会破坏扩展功能（它只影响模型选择器中的管理按钮入口），但会让用户少一个发现入口，故保留至今。

## 9. 相关链接

- 语言模型聊天提供商扩展指南：https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider
- Copilot 语言模型自定义文档：https://code.visualstudio.com/docs/agent-customization/language-models
- `languageModelChatProviders` API 参考：https://code.visualstudio.com/api/references/vscode-api#languageModelChatProviders
