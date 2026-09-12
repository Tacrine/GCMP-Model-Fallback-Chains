# 更新日志

本拓展为 **GCMP (`vicanent.gcmp`) 的附属拓展** — 依赖 GCMP 提供底层模型供应商, 本拓展只负责把 GCMP 已注册的模型组织成跨供应商自动回退链。安装本拓展前必须已安装 GCMP (当前基线: GCMP ≥ 0.28.x, 对应 VS Code ≥ 1.125.0)。未检测到 GCMP 时, 拓展会弹出安装引导并停止注册。

## [0.2.0] - 2026-09-14

### 破坏性变更
- **改为 GCMP 附属拓展**: 声明 `extensionDependencies: ["vicanent.gcmp"]`, 引擎下限升至 VS Code ≥ 1.125, 要求 GCMP ≥ 0.28.x。
- **删除 HTTP 传输栈** (`chat-completions` / `responses` 原生流式、`src/transport/httpTransport.ts`、`src/convert/` 全部移除): 所有目标现在均为 `proxy` 目标; 配置加载时旧 `http` 目标会被自动剥离 (计数见 `droppedHttpTargets`), 需通过 **管理 → 导入 GCMP 配置** 重新导入。
- **删除 `setApiKey`** (`fallbackrouter.setApiKey` 命令) 与全部密钥管理: 本拓展不再接触或存储任何 API 密钥, 密钥统一在 GCMP 中配置。`fallbackrouter.cleanup` 现在会清除迁移期间捕获的旧 `fallbackrouter.*` 密钥 (引用清单存于 globalState `legacySecretRefs`, 幂等) 以及熔断器状态。
- **配置变更**: 随 HTTP 栈一并移除 `fallbackRouter.timeouts`; `chains` 目标只接受 `kind: "proxy"`。`importMode` 保留 (`family` | `exact`)。
- **导入重写**: 导入 GCMP 配置改为读取**实时** `vscode.lm.selectChatModels` 结果 (与 GCMP 声明的供应商列表取交集过滤, 排除 `fallbackrouter` 供应商), 直接写入 `fallbackRouter.chains`, 带回环校验与失败回滚。
- **能力实时合并**: 链的 `maxInputTokens` / `toolCalling` / `imageInput` 取自已注册聊天模型的实时元数据 (元数据缺失时回退到保守默认值)。

## [0.1.0] - 2026-09-11

### 新增
- 复合语言模型提供方 (`fallbackrouter` 供应商), 对外暴露模型回退链。
- 有序回退链: 逐目标退避重试 + 逐目标熔断器。
- 两种传输:
  - 代理传输 (委托给已有 BYOK 供应商, 如 GCMP)。
  - HTTP 传输 (原生流式 `chat-completions` 与 `responses`)。
- 混流中段策略: 首段前静默切换、出文本后可见提示、工具调用后中止。
- GCMP 配置导入器, 支持 family/exact 分组。
- 管理、应用、预热、setApiKey、默认模型、诊断、清理命令。
- 可观测性: 输出通道日志、状态栏、诊断命令、脱敏处理。
- Mock 上游 + 确定性故障注入 QA (`npm run qa:faults`)。

### 文档
- README (中文为主 + 英文摘要): 问题陈述、接线步骤 (模型选择器 vs `chat.planAgent.defaultModel` / `chat.exploreAgent.defaultModel` / `chat.utilityModel`)、配置总览、A1 (代理) vs A2 (http) 取舍、命令参考、安全说明、局限、故障排查。
- `docs/configuration.md`: `fallbackRouter.*` 设置全字段参考表、链/目标结构、墙钟与限流语义、GCMP 导入行为、`managementCommand` 弃用说明。
