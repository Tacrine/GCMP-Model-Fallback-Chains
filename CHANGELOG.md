# 更新日志

本拓展为 **GCMP (`vicanent.gcmp`) 的附属拓展** — 依赖 GCMP 提供底层模型供应商, 本拓展只负责把 GCMP 已注册的模型组织成跨供应商自动回退链。安装本拓展前必须已安装 GCMP (当前基线: GCMP ≥ 0.28.x, 对应 VS Code ≥ 1.125.0)。未检测到 GCMP 时, 拓展会弹出安装引导并停止注册。

## [0.1.1] - 2026-09-13

### 修复
- **命令面板里的二级菜单失效**: 从命令面板 (`Ctrl+Shift+P`) 运行 **Fallback Router: Manage** 时, "Add target / Remove target / Move up / Move down / Test this target" 全部没有效果, 且操作后菜单直接消失。
  - 原因: 上一级选择器刚关闭时立刻弹出的下一级选择器会被 VS Code 立即关闭 (widget 销毁竞态); 旧实现没有重试、没有错误提示, 一次静默失败就结束了整个流程。
  - 现在每个操作结束后**回到动作菜单**继续操作: 新增 **Back to chain list** 项, 按 `Esc` 同样回到链列表, 不必反复打开命令面板。
  - 所有选择器与输入框声明 `ignoreFocusOut`, 并在上一级控件关闭后留 150ms 缓冲; 若选择器在打开后 250ms 内被宿主误关闭, 会自动重弹一次, 而不是静默什么都不做。
  - 动作改为按内部标签分派 (不再比较本地化文案), 操作抛错时弹出错误提示 (此前静默失败)。
  - 每次写入前重新读取 `fallbackRouter.chains`: 连续多次增删/排序不会互相覆盖。
  - 移动到链首/链尾时给出提示且不写入无变化的配置。
  - 回归验证: 单元测试覆盖菜单状态机与 VS Code 适配层, 另有扩展宿主端到端用例 `npm run test:e2e:manage` (脚本化 QuickPick/InputBox 驱动真实 `Manage` 命令, 断言每次操作后动作菜单重现且配置写入落地)。

## [0.1.0] - 2026-09-11

### 破坏性变更
- **改为 GCMP 附属拓展**: 声明 `extensionDependencies: ["vicanent.gcmp"]`, 引擎下限升至 VS Code ≥ 1.125, 要求 GCMP ≥ 0.28.x。
- **删除 HTTP 传输栈** (`chat-completions` / `responses` 原生流式、`src/transport/httpTransport.ts`、`src/convert/` 全部移除): 所有目标现在均为 `proxy` 目标; 配置加载时旧 `http` 目标会被自动剥离 (计数见 `droppedHttpTargets`), 需通过 **管理 → 导入 GCMP 配置** 重新导入。
- **删除 `setApiKey`** (`fallbackrouter.setApiKey` 命令) 与全部密钥管理: 本拓展不再接触或存储任何 API 密钥, 密钥统一在 GCMP 中配置。`fallbackrouter.cleanup` 现在会清除迁移期间捕获的旧 `fallbackrouter.*` 密钥 (引用清单存于 globalState `legacySecretRefs`, 幂等) 以及熔断器状态。
- **配置变更**: 随 HTTP 栈一并移除 `fallbackRouter.timeouts`; `chains` 目标只接受 `kind: "proxy"`。`importMode` 保留 (`family` | `exact`)。
- **导入重写**: 导入 GCMP 配置改为读取**实时** `vscode.lm.selectChatModels` 结果 (与 GCMP 声明的供应商列表取交集过滤, 排除 `fallbackrouter` 供应商), 直接写入 `fallbackRouter.chains`, 带回环校验与失败回滚。
- **能力实时合并**: 链的 `maxInputTokens` / `toolCalling` / `imageInput` 取自已注册聊天模型的实时元数据 (元数据缺失时回退到保守默认值)。

### 新增
- 复合语言模型提供方 (`fallbackrouter` 供应商), 对外暴露模型回退链。
- 有序回退链: 逐目标退避重试 + 逐目标熔断器。
- 代理传输 (委托给已有 BYOK 供应商, 如 GCMP)。
- 混流中段策略: 首段前静默切换、出文本后可见提示、工具调用后中止。
- GCMP 配置导入器, 支持 family/exact 分组; "Add target" 可直接从 GCMP 实时模型列表选择 (与手动输入并存)。
- 管理、应用、预热、默认模型、诊断、清理命令。
- 全量本地化 (中英自动切换): 设置界面、命令面板、运行时菜单/弹窗。
- 可观测性: 输出通道日志、状态栏、诊断命令、脱敏处理。
- Mock 上游 + 确定性故障注入 QA (`npm run qa:faults`)。

### 文档
- README (中文为主 + 英文摘要): 问题陈述、接线步骤 (模型选择器 vs `chat.planAgent.defaultModel` / `chat.exploreAgent.defaultModel` / `chat.utilityModel`)、配置总览、命令参考、安全说明、局限、故障排查。
- `docs/configuration.md`: `fallbackRouter.*` 设置全字段参考表、链/目标结构、GCMP 导入行为、`managementCommand` 弃用说明。
