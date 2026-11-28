# Node LoopScope Trace 接线

## 采集点对照

| Python 采集点 | Node Core 执行入口 | LoopScope 映射 | 状态与验证 |
| --- | --- | --- | --- |
| `trace.py` 新建、恢复、结束 Run | `packages/core/src/agent/core.ts` 的 `run_started`、`run_resumed`、`final` | run span、Collector 快照与终态 `/finish` | 通用 Core 观测端口和 Web Host 注入已实现；devserver Core/共享包回归通过；真实聊天回放待验收 |
| `hooks.py` Provider 请求、轮次及 usage | `packages/core/src/agent/providers/runtime.ts` 实际 transport 请求封装；`core.ts` 消费 Provider usage | provider/context/cache span、usage 表 | 请求 body 来自最终 Provider wire；usage 只取 Provider 返回值；Core 52/52、共享包 5/5 devserver 回归通过 |
| `hooks.py` 工具调用、结果、错误 | `packages/core/src/agent/core.ts` 的 `executeTool`、`applyTool` | tool span input/output/status | 结果来自 Core 执行回执；Core 真实工具轮回归通过，Host 接线回归 2/2 通过；UI 回放待验收 |
| `hooks.py` 上下文、History、工具 Schema、能力目录、最终输出 | `packages/core/src/agent/runner.ts` Canonical context snapshot、`providers/runtime.ts` Provider boundary、`core.ts` final event | context/history/output span；实际请求快照另取 Provider wire | Canonical source、最终 wire 行布局指纹、Schema 摘要、能力目录计数和最终回复/错误均有 span |
| `cache_probe.py` 缓存边界与 Prefix Diff | `ProviderRuntime` 最终 wire 的 `providerCacheDiagnostics`、cache anchor 和历史清理摘要 | cache span 及每 Run 最近 12 轮 metadata | token 数只记 Provider usage；reflection/compaction 通过同一 ProviderRuntime 分支请求观测 |
| Python 的 Web/IM/定时任务入口 | Web `createWebAgentReconstructor`、IM `createImAgentReconstructor`、定时任务 `createScheduledTaskHarness` 共用 Core Runtime | source 分别为 `web`、`im`、`scheduled` | Web/IM/定时任务都已从可信 Host 注入独立 source；devserver 已有 IM Trace 页面回放，但新 IM Run 的 preparation/RAG/终态仍待完整验收 |

## 当前 Node 覆盖补充（2026-11-19）

- Core 结构日志经 `AgentRunLogPort` 输出 ISO 时间戳、Run 指纹、轮次和允许的枚举/数字字段；Provider 重试、失败、不完整/空结果、含耗时与完成数的并行工具批次、工具失败、交互恢复失败、上下文压缩/超限恢复、回复门拦截、轮次上限和最终化失败均有事件。聊天正文、工具输入和异常正文不进入普通日志。
- LoopScope 额外保留 `Final response` / `Agent error` 输出 span，以及最终 Provider boundary 上下文布局、工具 Schema 和能力目录的结构摘要；这些摘要不重复复制正文，完整 Provider 请求仍保留在受控 Provider request span，Canonical context snapshot 沿用原有上下文记录。
- LoopScope 面板同时识别旧版 `llm` 与新版 `provider` 模型调用 span，确保从新版 usage 事件读取 Run token 卡片、模型标签、span token chip 和导出轮次摘要。
- Node 的 Run/轮次 token 口径现统一为总输入（fresh + cache read + cache write）；UI 兼容历史 Node 记录中 `input` 仅代表 fresh 的格式。Provider 请求历史、System prompt、snapshot 和多层子 span 会回到对应 `LLM round` 卡片，前缀完整性按上一轮稳定消息边界比较。devserver 前端文件已同步，尚待新的真实 Run 回放确认最终呈现。
- 2026-11-19 devserver 回放已确认：一个已有真实 Run 的 Collector 记录包含 Run 终态、耗时、Provider usage 和工具 span；LoopScope 页面修复同步后显示 Input、Output、Cache、Total 与 50 个 span。该次回放没有新建 Run。
- Provider 观测的模型标签改用已解析的 Provider 配置模型名；页面也会隐藏旧记录中 `gugu-model-v1.*` 不透明身份值，避免将内部身份凭据展示在 Run 标题。
- Web、IM 与定时任务分别使用 `web`、`im`、`scheduled` LoopScope source，避免同一 Collector 将 IM/定时 trace 错标成 Web。IM 与定时任务复用 Web Host 的受控日志端口；观测端口不可用时不应影响 Agent 主链路。
- 反思分支使用独立 `reflection` source 和隔离 Run ID，记录反思缓存支持状态、输入/新鲜/缓存 token、命中率、scope、触发来源及耗时；不复制反思提示词或输出正文到专用 trace。
- 会话 Monitor 同时查询新版统一 `im` source 和旧版按平台命名的 IM source，兼容既有 Python Trace；新版 IM Run 仍统一写入 `im`。
- 2026-11-20 devserver 只读回看确认：飞书会话 Monitor 可加载 3 条、QQ 会话可加载 10 条 IM Run；飞书最新可见 Run 有 60 个 span，QQ 最新可见 Run 有 12 个 span。QQ Run 只有 Provider continuation 与请求 span，没有 Core 根/Run preparation/RAG/终态 span。
- `createAgentRuntimeWithContextFactory` 从显式、Runtime 或 Provider 端口中解析唯一 observation，并同时传给 ProviderRuntime 和 Core Runner；此前异步 Context Factory 只把端口传给 ProviderRuntime，导致 IM trace 有 Provider span、缺 Core 根、Run preparation、RAG、工具和终态 span。已修复装配；新 IM Run 的运行态复验仍待完成。
- 飞书旧 Run 的 60 个 span 都引用缺失的 Run 根节点，Monitor 原先只渲染无 parent 的 span，导致计数有数据但详情区空白。现将 parent 缺失的 span 作为可见树根；devserver 浏览器已确认 60 个 Provider/continuation span 展开显示。该旧 Run 仍为 running、无终态与 RAG span，需新 Host 构建验证 Core 修复。
- JSONL 结构日志统一先写 ISO `time` 字段，Debug 日志读取器可直接解析时间；Web Host 普通 console 输出保留时间前缀，日志文件不可写的 stderr 提示也带 ISO 时间。生产构建静态检查通过，devserver 运行进程尚未加载此改动。
- 本补充的 UI 修复已在 devserver 对已有真实 Collector Run 完成运行态回放；完整的 Collector 开关、离线、超时、并发、恢复/取消与 IM/定时任务矩阵仍未完成。

## 架构与安全边界

- `packages/core/src/agent/observation.ts` 是通用跨端端口；Core 没有 LoopScope 或 Host 依赖。
- `packages/loopscope/` 提供开关、Collector 快照转换、敏感字段清理和有界异步上报；`apps/web-host/src/main.ts` 只在 `LOOPSCOPE_ENABLED=1|true|yes|on` 时构造 trace recorder。
- Web Host 通过已经固定目标并拒绝重定向的 Node transport 上报。Collector 慢、离线或失败只影响独立队列，不等待或抛回 Agent。
- `LOOPSCOPE_ENDPOINT` 默认 `http://127.0.0.1:4320`。只读代理仍走原认证路由；采集开关只控制写入 trace 的采集器。
- 单 Run 最多保存 600 spans、48 MiB；进程最多保留 12 个 Run，异步队列最多 64 个快照/64 MiB。正文不做截断；超过 Run 上限时整条标记 `trace_capture_unavailable=trace_size_limit`，不伪报部分采集为完整数据。大请求以 gzip 传输。
- 行为回归只在 devserver 执行：`packages/core/tests/agent/providers/runtime.test.ts` 52/52 通过；`packages/loopscope/trace.test.js` 5/5 通过；`apps/web-host/tests/host/http/loopscope/trace.test.ts` 2/2 通过。未在本地运行测试。
- 本轮 Core 和 Host 全量类型检查在 devserver 超过 120 秒仍未返回结果，检查状态未知且不能标为通过；Node 行为回归均正常完成。Host 全量检查还会先重建 Core、FS、Charts，未拿到 Host `tsc` 结果。

## 当前验收边界

- 已实现且有 devserver 自动回归：Core 通用观测事件（含 reflection/compaction 分支 Provider 请求、usage、输出）；共享 Collector 写入/终态重试、凭据清理和队列容量限制；Web Host 条件装配；保留现有只读代理认证边界。
- 已验收 Node Web 聊天路径：`apps/web/vite.config.js` 当时未配置代理覆盖，默认将 5174 的 `/api` 请求转发到 Node Web Host 9595；devserver 上验收时该端口由 `apps/web-host/src/main.ts` 进程监听。合成账号在 5174 新会话连续完成两轮，第一轮调用 `get_tool_schema` 并返回 `get_current_time` 空参数 Schema，第二轮复述空参数结论且没有再次调用工具。未认证直连 Node `/api/v1/agent/chat` 返回 401，确认路由受登录保护。
- Collector 回放仍未验收：两轮聊天验收时 Node Host 进程环境未设置 `LOOPSCOPE_ENABLED`，代码按设计保持默认关闭；当时 Collector 健康检查正常，该合成会话没有对应 trace。没有改持久运行配置。启用受控测试 Host 的 `LOOPSCOPE_ENABLED=1` 后，还需验收 Collector/UI 的 Input、Output、Context、Tool、Provider usage 与 Run 终态；同时验证关闭开关无上报、Collector 离线/超时下聊天与历史提交正常、并发、恢复/取消、终态重试和凭据过滤。
- 后续联调中断：LoopScope 左栏会话来自 Gugu 的 `/agent/sessions`，Run 回放来自 Collector。浏览器观察到账号仍显示已连接，左栏为空，Node Host 和 Collector 连接被拒绝。随后从开发机直连 5174 会话接口和 LoopScope 健康代理均超时，SSH 未完成握手，当前无法确认标准服务已恢复。
- 验收边界：Reflection 专用 Trace 与其缓存观测已实现，尚未用新的真实反思调用验收；已观察的 IM Run 有 Collector 记录，但仍需用新 IM Run 核对 Run preparation、RAG 和终态 span。Collector/UI 的离线、超时、并发、恢复/取消与终态重试矩阵仍待完成。
- Collector/UI 仍独立构建、部署和运行；Gugu Host 不启动 Collector，也不等待其就绪。
