# 配置参考（Configuration Reference）

本文档是 `gcmp-model-fallback-chains`（GCMP Model Fallback Chains）的完整配置字段参考。所有键均属于 `contributes.configuration`，在 VS Code 设置中以 `fallbackRouter.*` 前缀出现；默认值来自 `package.json` 与 `src/config.ts` 中的 `normalizeConfig`。

> 本扩展是 **GCMP 的附属拓展**：模型与密钥都由 [vicanent.gcmp](https://marketplace.visualstudio.com/items?itemName=vicanent.gcmp) 提供。本扩展**不再管理任何 API key**——链上的每个目标都是 `proxy` 目标，运行时通过 `vscode.lm.selectChatModels` 委托给 GCMP 已注册的供应商。
>
> 默认值校验规则：非法值不会被拒绝写入，而是**回退到默认值**并在输出面板（"Fallback Router"）记录 warning；结构非法的链会被整体丢弃（计入 `droppedChains`）。

## 1. 顶层字段

| 键 | 类型 | 默认值 | 枚举 | 说明 |
|---|---|---|---|---|
| `fallbackRouter.chains` | `array` | `[]` | — | 复合模型链数组。每条链是有序目标列表，按序尝试，失败切换下一个。目标只能是 `proxy` 类型（见 §4）。 |
| `fallbackRouter.retry` | `object` | 见 §2 | — | 单目标重试策略（指数退避）。 |
| `fallbackRouter.circuitBreaker` | `object` | 见 §3 | — | 单目标熔断器。 |
| `fallbackRouter.maxTurnMs` | `number` | `600000`（10 分钟） | — | 整条链从开始到结束的硬截止时间；超时抛 `Turn deadline exceeded (maxTurnMs=...)`。必须为正数，非法回退默认。 |
| `fallbackRouter.maxTargetsPerTurn` | `number` | `5` | — | 每轮最多尝试的目标数量（取链前 N 个）；范围 1–100，越界回退默认。 |
| `fallbackRouter.importMode` | `string` | `family` | `family` \| `exact` | GCMP 导入分组模式，见 §5。 |
| `fallbackRouter.retryOnRateLimit` | `boolean` | `false` | — | 是否把限流错误（HTTP 429、`rateLimited`、`quotaExceeded`）视为可重试。默认 `false`，与 Copilot"不因限流重试"的意图一致。 |
| `fallbackRouter.noticeStyle` | `string` | `markdown` | `markdown` \| `plain` | 中流切换（已输出文本后切换目标）时可见通知的样式。 |
| `fallbackRouter.logLevel` | `string` | `info` | `off` \| `error` \| `info` \| `debug` | 输出面板（"Fallback Router"）日志级别；非法值回退 `info`。 |

> `fallbackRouter.timeouts`（HTTP 传输墙钟预算）已随 HTTP 栈删除（v0.1.0）。代理委托的超时由 `maxTurnMs` 与上游提供商自身行为约束。

### 默认值汇总（`src/config.ts`）

```jsonc
{
  "chains": [],
  "retry": { "maxAttempts": 3, "initialDelayMs": 1000, "backoffFactor": 2, "maxDelayMs": 15000 },
  "circuitBreaker": { "failureThreshold": 3, "cooldownMs": 60000 },
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

- **可重试**：网络类错误（`ECONNREFUSED`、`ETIMEDOUT`、`fetch failed`、超时、中止、停滞）、上游 HTTP 500/502/503/504。
- **不可重试**：`NoPermissions` / `Blocked` / `NotFound`（平台 LM 错误码）、HTTP 401/403、HTTP 429 / `rateLimited` / `quotaExceeded`（**除非** `retryOnRateLimit: true`）。
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

## 4. `fallbackRouter.chains`（链与目标）

```ts
interface Chain {
  id: string;                 // [a-zA-Z0-9_-]+，唯一；复合模型 id 为 fallbackrouter:<id>
  name: string;               // 显示名；复合模型显示名为 "<name> (fallback)"，缺省取 id
  targets: Target[];          // 有序，非空，全部为 proxy 目标
}
```

### 4.1 `proxy` 目标（唯一目标形态，委托 GCMP 已注册供应商）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `kind` | `"proxy"` | 是 | 目标类型。 |
| `vendor` | `string` | 是 | 具体供应商 vendor（如 `gcmp.compatible`）。**禁止 `fallbackrouter`**（自递归，会被丢弃）。只写**具体供应商**，不写 `gcmp.*` 通配（运行时解析为空）。vendor 以 GCMP 运行时公布为准，本扩展不硬编码。 |
| `modelId` | `string` | 是 | 通过 `vscode.lm.selectChatModels({vendor, id})` 可解析的模型 id。模型 id 清单**以 GCMP 运行时公布为准**，本扩展不硬编码。 |

能力（`maxInputTokens` / `toolCalling` / `imageInput`）：来自**实时** `selectChatModels` 元数据合并（AND toolCalling / AND imageInput / 取链内 token 最小值）。1.137 平台元数据无 capabilities 字段时走保守默认（toolCalling 保持 true 从不乐观降级，imageInput 无证明不声明）。

鉴权：由 GCMP 侧管理（在 GCMP 的密钥配置中录入各供应商 key），**本扩展不接触、不存储任何 API key**。`fallbackrouter.cleanup` 只清除迁移前遗留的 `fallbackrouter.*` 密钥与熔断状态。

### 4.2 校验与丢弃规则（`normalizeChains`）

- 链 `id` 必须匹配 `^[a-zA-Z0-9_-]+$` 且不重复；否则丢弃。
- 链目标必须非空；否则整链丢弃。
- 目标 `kind` 必须为 `"proxy"`；**`http` 目标自动剥离**（迁移语义）——每个被剥离的 http 目标计数到 `droppedHttpTargets`，其 `secretRef` 引用名被捕获到 globalState `legacySecretRefs`（供 `fallbackrouter.cleanup` 一次性清除旧密钥）；链其余 proxy 目标保留。
- 同一链内重复目标（`proxy:<vendor>/<modelId>`）→ 跳过。
- 单目标链合法但无回退能力，配置加载时给出 warning。
- 被丢弃的链计入 `droppedChains`；`fallbackrouter.apply` 在写入前用同一校验做"写前结构验证"，不合格即拒绝应用。

### 4.3 示例

```jsonc
"fallbackRouter.chains": [
  {
    "id": "deepseek",
    "name": "deepseek",
    "targets": [
      { "kind": "proxy", "vendor": "gcmp.compatible", "modelId": "deepseek/deepseek-chat" },
      { "kind": "proxy", "vendor": "gcmp.compatible", "modelId": "deepseek/deepseek-reasoner" }
    ]
  }
]
```

> **迁移提示**：v0.1.0 起不再支持 `http` 目标。旧配置中的 http 链会在加载时自动剥离并给出警告；请在 GCMP 中配置好密钥后，用 **Fallback Router: Manage → Import GCMP config** 重新导入生成代理链。

## 5. GCMP 导入（`fallbackRouter.importMode` 与 `fallbackrouter.manage` → "Import GCMP config"）

导入源 = **实时 `vscode.lm.selectChatModels`** 结果（GCMP 已注册的全部模型），不读取 GCMP 的 SecretStorage、不再读取静态 `gcmp.compatibleModels`：

- 与 GCMP 声明的供应商清单求**交集过滤**（防止把 GCMP 桥接/网关自身误判为供应商，`gcmp-bridge` 假阳性防护）。
- 跳过 `fallbackrouter` 自身 vendor（防递归）。
- **`family` 模式（默认）**：按"家族名"分组——去掉 `vendor/` 前缀后取第一个 `-` 之前的小写片段。
- **`exact` 模式**：按精确模型 id 分组，非 `[a-zA-Z0-9_-]` 字符替换为 `-`。
- 组内目标按 `vendor` 再 `modelId` 排序，保证草稿链顺序稳定；链 id 取分组键。
- 结果**直接写入** `fallbackRouter.chains`（全局），写后做**回环校验**（确认 `fallbackrouter:<chainId>` 可解析），失败自动回滚到旧值。也可用 **Fallback Router: Apply imported chains**（`fallbackrouter.apply`，剪贴板 JSON → 同通道写入）。
- 无可用模型时给出醒目警告并提示"配置 GCMP"。

## 6. 命令一览

| 命令 id | 标题 | 说明 |
|---|---|---|
| `fallbackrouter.manage` | Fallback Router: Manage | 链管理 UI（增删/排序/测试目标、Import GCMP config、打开设置）。"Add target" 收集 `vendor` + `modelId`（proxy-only）。 |
| `fallbackrouter.apply` | Fallback Router: Apply imported chains | 剪贴板 JSON → `fallbackRouter.chains`（写前验证 + 写后回环，失败回滚） |
| `fallbackrouter.warmup` | Fallback Router: Warm up proxy targets | 解析并报告所有 `proxy` 目标的模型可见性 |
| `fallbackrouter.set-default-model` | Fallback Router: Set default model | 写入 `chat.planAgent.defaultModel` / `chat.exploreAgent.defaultModel` / `chat.utilityModel`（先校验可解析） |
| `fallbackrouter.showDiagnostics` | Fallback Router: Show diagnostics | 自检 + 链/目标清单（markdown 文档 + 日志） |
| `fallbackrouter.cleanup` | Fallback Router: Clean up stored data | 清除迁移时捕获的旧密钥（`fallbackrouter.<ref>`，引用名单存于 globalState `legacySecretRefs`）与熔断状态（`fallbackrouter.breaker.*`）。幂等：二次运行无键可删、无异常。 |

> `fallbackrouter.setApiKey` 已删除（v0.1.0）：密钥改在 GCMP 侧配置，本扩展不再管理任何 API key。

## 7. `managementCommand` 弃用说明

`package.json` 中 `contributes.languageModelChatProviders` 目前仍声明 `"managementCommand": "fallbackrouter.manage"`。VS Code 已弃用该字段（其官方替代 `configuration` 目前仍是 proposed-only API，稳定扩展无法使用）。因此本扩展在可预见的版本中继续使用 `managementCommand`；迁移路径：待 `configuration` 字段稳定后，将 `managementCommand` 替换为 `configuration`（声明指向设置项而非命令），并把"管理入口"迁移到设置 UI 中。删除 `managementCommand` 本身不会破坏扩展功能（它只影响模型选择器中的管理按钮入口），但会让用户少一个发现入口，故保留至今。

## 8. 相关链接

- 语言模型聊天提供商扩展指南：https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider
- Copilot 语言模型自定义文档：https://code.visualstudio.com/docs/agent-customization/language-models
- `languageModelChatProviders` API 参考：https://code.visualstudio.com/api/references/vscode-api#languageModelChatProviders
- GCMP 扩展（vicanent.gcmp）：请在 VS Code 扩展市场中搜索 "GCMP"（附属于本扩展的依赖）。