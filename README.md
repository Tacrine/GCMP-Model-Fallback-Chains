# GCMP Model Fallback Chains

> 简体中文 · [English Summary](#english-summary)

一个把多个**具体供应商模型**串成**复合模型链**的 VS Code 扩展：链上目标按序尝试，失败自动切下一个目标。它是 [vicanent.gcmp](https://marketplace.visualstudio.com/items?itemName=vicanent.gcmp)（下称 GCMP）的**附属扩展**——本扩展不再拥有任何 HTTP 传输、不再管理任何 API key、不再读取任何 SecretStorage；模型与密钥全部由 GCMP 提供，运行时通过 `vscode.lm.selectChatModels` **实时委托**。

- 模型 id = 复合模型 id `fallbackrouter:<chainId>`（例如 `fallbackrouter:oai-o1-mini`）
- 一个链 = 有序 `proxy` 目标列表 → 单一入口，多供应商冗余

---

## English Summary

A VS Code extension that chains **concrete per-vendor models** (provided by the GCMP extension, `vicanent.gcmp`) into composite fallback chains. Targets are attempted in order; on failure the router transparently moves to the next target. This extension is a **companion to GCMP**: it has no HTTP transport, no API-key management, and no direct model access of its own — at runtime every target is delegated to `vscode.lm.selectChatModels` against models GCMP registered. The composite model id follows the scheme `fallbackrouter:<chainId>`.

---

## 工作原理

```
        ┌─────────────────────────────────────────────┐
        │  GCMP (vicanent.gcmp)                        │
        │  · 多个供应商 key 配置                        │
        │  · 向 VS Code 注册 language model providers  │
        └───────────────┬─────────────────────────────┘
                        │ vscode.lm.selectChatModels({vendor, id})
                        ▼
        ┌─────────────────────────────────────────────┐
        │  本扩展 (fallbackrouter)                     │
        │  · proxy 目标 → 实时委托 GCMP 注册的模型       │
        │  · retry / circuit breaker / turn deadline   │
        │  · 目标失败 → 自动切换下一个目标               │
        └───────────────┬─────────────────────────────┘
                        │ 复合模型 fallbackrouter:<chainId>
                        ▼
              VS Code / Copilot 聊天界面
```

- **代理委托**：每个 `proxy` 目标 = `vendor` + `modelId`，运行时解析为 GCMP 注册的具体模型聊天提供商。
- **实时能力合并**：链的 `maxInputTokens` / `toolCalling` / `imageInput` 来自 `selectChatModels` 实时元数据（AND toolCalling / AND imageInput / token 取链内最小值）；元数据缺失时走保守默认，从不乐观声明。
- **切换语义**：目标错误、超时、熔断打开、不可重试错误 → 切下一个目标；链全耗尽 → 抛出组合错误。切换发生在目标层面，不重放已输出文本。

完整配置字段见 [docs/configuration.md](docs/configuration.md)。

---

## 安装

1. 安装本扩展（`gcmp-model-fallback-chains`）。
2. **先安装 GCMP**：本扩展声明了 `extensionDependencies: ["vicanent.gcmp"]`，并在引擎下限要求 VS Code ≥ 1.125。**如果 GCMP 未安装**，本扩展激活时会弹出错误提示并引导你安装 GCMP。
3. 在 **GCMP 的密钥配置**中录入各供应商的 API key（本扩展不接触任何 key）。
4. GCMP 版本要求：**≥ 0.28.x**。升级 GCMP 后请复核兼容性（见下文「命名兼容与升级复核」）。

## 快速开始

1. 在 GCMP 中配置好供应商密钥，确认 GCMP 的模型在 AI 聊天中可用。
2. 打开命令面板 → **Fallback Router: Manage** → **Import GCMP config**：从实时模型清单生成代理链草稿，预览后**直接写入** `fallbackRouter.chains`（写后自动回环校验，失败回滚）。
3. 在 Copilot Chat / Agent 设置中把模型指到复合模型（接线）：

| 接线目标 | 值 |
|---|---|
| `chat.planAgent.defaultModel` | `fallbackrouter:<chainId>` |
| `chat.exploreAgent.defaultModel` | `fallbackrouter:<chainId>` |
| `chat.utilityModel` | `fallbackrouter:<chainId>` |

也可用 **Fallback Router: Set default model** 命令写入（先校验复合模型可解析）。

4. 开始对话。首个目标失败 → 自动切换下一个目标；切换在中流发生时给出可见通知（`noticeStyle` 控制样式）。

### 手工配置示例

```jsonc
// settings.json
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

> `vendor` 必须写 GCMP 运行时公布的**具体供应商**（如 `gcmp.compatible`），禁止 `fallbackrouter`（自递归）与 `gcmp.*` 通配。模型 id 以 GCMP 运行时公布为准，本扩展不硬编码。密钥在 GCMP 侧配置，本扩展不存储任何 key。

## 功能与命令

| 命令 id | 标题 | 说明 |
|---|---|---|
| `fallbackrouter.manage` | Fallback Router: Manage | 链管理 UI：增删/排序/测试目标、**Import GCMP config**（实时导入）、打开设置 |
| `fallbackrouter.apply` | Fallback Router: Apply imported chains | 剪贴板 JSON → `fallbackRouter.chains`（写前验证 + 写后回环，失败回滚） |
| `fallbackrouter.warmup` | Fallback Router: Warm up proxy targets | 解析并报告所有 `proxy` 目标的模型可见性 |
| `fallbackrouter.set-default-model` | Fallback Router: Set default model | 写入 `chat.planAgent.defaultModel` / `chat.exploreAgent.defaultModel` / `chat.utilityModel`（先校验可解析） |
| `fallbackrouter.showDiagnostics` | Fallback Router: Show diagnostics | 自检 + 链/目标清单（markdown 文档 + 日志） |
| `fallbackrouter.cleanup` | Fallback Router: Clean up stored data | 清除迁移前遗留的旧密钥（`fallbackrouter.<ref>`，引用名单存于 globalState `legacySecretRefs`）与熔断状态（`fallbackrouter.breaker.*`）。幂等、容错 |

> 密钥全部改在 GCMP 侧配置，本扩展不再管理任何 API key（v0.1.0 起，密钥管理命令已随 HTTP 栈一并移除）。

## 配置参考（摘要）

完整字段与校验规则见 [docs/configuration.md](docs/configuration.md)。

| 键 | 默认值 | 说明 |
|---|---|---|
| `fallbackRouter.chains` | `[]` | 复合模型链（proxy 目标） |
| `fallbackRouter.retry` | `{maxAttempts: 3, initialDelayMs: 1000, backoffFactor: 2, maxDelayMs: 15000}` | 单目标重试（指数退避） |
| `fallbackRouter.circuitBreaker` | `{failureThreshold: 3, cooldownMs: 60000}` | 单目标熔断 |
| `fallbackRouter.maxTurnMs` | `600000` | 整链硬截止时间 |
| `fallbackRouter.maxTargetsPerTurn` | `5` | 每轮最多尝试的目标数 |
| `fallbackRouter.importMode` | `family` | GCMP 导入分组模式（`family` \| `exact`） |
| `fallbackRouter.retryOnRateLimit` | `false` | 是否把限流视为可重试 |
| `fallbackRouter.noticeStyle` | `markdown` | 中流切换通知样式 |
| `fallbackRouter.logLevel` | `info` | 输出面板日志级别 |

> `fallbackRouter.timeouts`（HTTP 传输预算）已随 HTTP 栈删除（v0.1.0）。

## 迁移说明（v0.1.x）

v0.1.0 起本扩展**不再支持 `http` 目标**（HTTP 传输与密钥管理命令已删除）：

- 旧配置中的 `http` 目标在加载时**自动剥离**：每个被剥离的目标计数到 `droppedHttpTargets`，其密钥引用名被捕获到 globalState `legacySecretRefs`（供 `fallbackrouter.cleanup` 一次性清除旧密钥），链中其余 proxy 目标保留；配置加载日志给出警告。
- 请把密钥迁到 GCMP（GCMP 密钥配置），然后用 **Manage → Import GCMP config** 重新导入生成代理链。
- 整条链全是 http 目标 → 整链丢弃（计入 `droppedChains`），并提示重新导入。
- 残留的 `fallbackrouter.*` 密钥与熔断状态可用 **Fallback Router: Clean up stored data** 一次性清除。

## 命名兼容与 GCMP 升级复核

- **版本下限**：本扩展依赖 GCMP **≥ 0.28.x**（`package.json` 的 `extensionDependencies` 与引擎下限）。
- **vendor 命名兼容**：GCMP 注册的 vendor 形如 `gcmp.<organization>`（如 `gcmp.compatible`）。本扩展只写具体供应商，运行时按 vendor 过滤委托；第三方 vendor 若与 GCMP 命名冲突，由导入时的**交集校验**兜底（仅导入 GCMP 声明清单 ∩ 实时清单中的模型）。
- **升级复核**：每次升级 GCMP 后，重新审视 GCMP 的 `dist` 中 `selectChatModels` 调用点仍带 vendor 过滤，并确认本扩展的 `ProxyTransport.resolve` 中 `vendor !== 'fallbackrouter'` 防线未失效（防止递归委托）。模型 id 清单不硬编码——以 GCMP 运行时公布为准。

## 安全说明

- **密钥**：全部归 GCMP 管理；本扩展不接触、不存储任何 API key。历史遗留的 `fallbackrouter.*` 密钥仅由 `cleanup` 命令移除。
- **脱敏**：`src/util/redact.ts` 对日志中的敏感值（redactKeys 命中项）做脱敏，即使出现在错误消息中也不会原样打印。
- **数据**：只有链配置（用户设置）、熔断状态（globalState）、迁移捕获的密钥引用名单（globalState「名称」而非「值」，绝不读 key 值进删除循环）会被持久化。

## 诚实边界

- `selectChatModels` 结果依赖 GCMP 的注册状态；GCMP 未安装/未注册模型时，本扩展无法解析任何目标（会给出明确错误与安装引导）。
- 实时能力合并受平台元数据限制：1.137 的 `ChatModel` 无 capabilities 字段时，`toolCalling` 保守保持 `true`（从不乐观降级）、`imageInput` 不声明、token 取保守默认。
- 中流切换不重放提示词与已输出文本；首目标已产出的内容保持原样，后续目标只对新请求生效。
- 没有 `money_back` 之类的承诺：回退链能提升可用性，但不能消除所有提供商故障。

## 故障排查

- **"找不到模型 fallbackrouter:xxx"** → 确认 GCMP 已安装且已配置密钥；用 **Fallback Router: Warm up proxy targets** 检查每个目标是否可解析。
- **导入生成空列表** → GCMP 未注册任何模型（检查 GCMP 密钥配置）；或交集过滤把候选都滤掉了（检查 GCMP 声明清单）。
- **切换似乎"重复"** → 目标错误被判定为可重试时会先退避重试；429 需要 `retryOnRateLimit: true` 才会重试。
- **状态栏显示 `FR: <chain> · open`** → 目标熔断打开，冷却期间直接跳过该目标；`fallbackrouter.cleanup` 可清除熔断状态。
- 详细日志：输出面板 → "Fallback Router"。

## 开发

```bash
npm install
npm run typecheck   # tsc --noEmit（src）
npm test            # vitest run（单元测试；不含扩展宿主 spike）
npm run test:e2e    # 扩展宿主 spike：嵌套 LM 委托门（@vscode/test-electron）
npm run qa:faults   # 故障注入 QA bundle
npm run package     # vsce package → .vsix
```

## 参与贡献 / License

见 [LICENSE](LICENSE)（MIT）。