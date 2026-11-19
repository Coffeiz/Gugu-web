# Node LoopScope Trace 接线

## 采集点对照

| Python 采集点 | Node Core 执行入口 | LoopScope 映射 | 状态与验证 |
| --- | --- | --- | --- |
| `trace.py` 新建、恢复、结束 Run | `packages/core/src/agent/core.ts` 的 `run_started`、`run_resumed`、`final` | run span、Collector 快照与终态 `/finish` | 通用 Core 观测端口和 Web Host 注入已实现；devserver Core/共享包回归通过；真实聊天回放待验收 |
| `hooks.py` Provider 请求、轮次及 usage | `packages/core/src/agent/providers/runtime.ts` 实际 transport 请求封装；`core.ts` 消费 Provider usage | provider/context/cache span、usage 表 | 请求 body 来自最终 Provider wire；usage 只取 Provider 返回值；Core 52/52、共享包 5/5 devserver 回归通过 |
| `hooks.py` 工具调用、结果、错误 | `packages/core/src/agent/core.ts` 的 `executeTool`、`applyTool` | tool span input/output/status | 结果来自 Core 执行回执；Core 真实工具轮回归通过，Host 接线回归 2/2 通过；UI 回放待验收 |
| `context.py` 上下文与快照 | `packages/core/src/agent/runner.ts` 导出的 Canonical context snapshot | context span；实际请求快照另取 Provider wire | 首次准备及后续 Canonical context 更新均可观察；单次及大小上限有界 |
| `cache_probe.py` 缓存边界与 Prefix Diff | `ProviderRuntime` 最终 wire 的 `providerCacheDiagnostics`、cache anchor 和历史清理摘要 | cache span 及每 Run 最近 12 轮 metadata | token 数只记 Provider usage；reflection/compaction 通过同一 ProviderRuntime 分支请求观测 |
| Python 的 Web/IM/定时任务入口 | Web `createWebAgentReconstructor` → `createPersistentAgentRuntime`；Core `createAgentRuntime` 可复用端口 | Web source=`web` | 本轮只接入 Web Agent Host；IM 与定时任务接入取决于其真实生产装配，本次未声称完成 |

## 架构与安全边界

- `packages/core/src/agent/observation.ts` 是通用跨端端口；Core 没有 LoopScope 或 Host 依赖。
- `packages/loopscope/` 提供开关、Collector 快照转换、敏感字段清理和有界异步上报；`apps/web-host/src/main.ts` 只在 `LOOPSCOPE_ENABLED=1|true|yes|on` 时构造 trace recorder。
- Web Host 通过已经固定目标并拒绝重定向的 Node transport 上报。Collector 慢、离线或失败只影响独立队列，不等待或抛回 Agent。
- `LOOPSCOPE_ENDPOINT` 默认 `http://127.0.0.1:4320`。只读代理仍走原认证路由；采集开关只控制写入 trace 的采集器。
- 单 Run 最多保存 600 spans、16 MiB；进程最多保留 12 个 Run，异步队列最多 64 个快照/32 MiB。触及 Run 字节上限时，记录 `trace_capture_unavailable=trace_size_limit`，不伪报完整采集。
- 行为回归只在 devserver 执行：`packages/core/tests/agent/providers/runtime.test.ts` 52/52 通过；`packages/loopscope/trace.test.js` 5/5 通过；`apps/web-host/tests/host/loopscope-trace.test.ts` 2/2 通过。未在本地运行测试。
- 本轮 Core 和 Host 全量类型检查在 devserver 超过 120 秒仍未返回结果，检查状态未知且不能标为通过；Node 行为回归均正常完成。Host 全量检查还会先重建 Core、FS、Charts，未拿到 Host `tsc` 结果。

## 当前验收边界

- 已实现且有 devserver 自动回归：Core 通用观测事件（含 reflection/compaction 分支 Provider 请求、usage、输出）；共享 Collector 写入/终态重试、凭据清理和队列容量限制；Web Host 条件装配；保留现有只读代理认证边界。
- 已验收 Node Web 聊天路径：`apps/web/vite.config.js` 当时未配置代理覆盖，默认将 5174 的 `/api` 请求转发到 Node Web Host 9595；devserver 上验收时该端口由 `apps/web-host/src/main.ts` 进程监听。合成账号在 5174 新会话连续完成两轮，第一轮调用 `get_tool_schema` 并返回 `get_current_time` 空参数 Schema，第二轮复述空参数结论且没有再次调用工具。未认证直连 Node `/api/v1/agent/chat` 返回 401，确认路由受登录保护。
- Collector 回放仍未验收：两轮聊天验收时 Node Host 进程环境未设置 `LOOPSCOPE_ENABLED`，代码按设计保持默认关闭；当时 Collector 健康检查正常，该合成会话没有对应 trace。没有改持久运行配置。启用受控测试 Host 的 `LOOPSCOPE_ENABLED=1` 后，还需验收 Collector/UI 的 Input、Output、Context、Tool、Provider usage 与 Run 终态；同时验证关闭开关无上报、Collector 离线/超时下聊天与历史提交正常、并发、恢复/取消、终态重试和凭据过滤。
- 后续联调中断：LoopScope 左栏会话来自 Gugu 的 `/agent/sessions`，Run 回放来自 Collector。浏览器观察到账号仍显示已连接，左栏为空，Node Host 和 Collector 连接被拒绝。随后从开发机直连 5174 会话接口和 LoopScope 健康代理均超时，SSH 未完成握手，当前无法确认标准服务已恢复。
- 部分接入：reflection/compaction 的 Provider 分支经过 Core 通用 Provider 观测，但本次没有真实调用场景验收。IM 与定时任务没有从当前 Web Host 观测端口装配，需各自可信生产 Host 显式注入同一端口。
- Collector/UI 仍独立构建、部署和运行；Gugu Host 不启动 Collector，也不等待其就绪。
