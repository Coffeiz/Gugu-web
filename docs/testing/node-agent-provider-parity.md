# N3 Provider 行为映射与验收边界

本轮实现可移植 Provider 协议和实际 Harness 接线，未切换 Python 的生产调用方。完整模块、调用点、逐 Python 定义、TS 用例及剩余断言见 [机器清单](node-agent-provider-parity.json)。定义数、参数化展开数与套件总数分别记录，不能把绿色总数解释为全部逐断言等价。

## 目录与生产路径

| 职责 | 实际实现 | 验证范围 |
|---|---|---|
| 厂商选择、能力、推理策略 | `providers/registry.ts`、`base.ts`、`vendors/policies.ts` | 可信配置副本、模型与协议矩阵；不代替 BYOK/Host 配置校验 |
| Chat/Responses/Anthropic/Ollama | 对应驱动及历史适配器 | 实际出站 body、SSE/NDJSON、工具参数/顺序、usage、空答/截断/错误/取消 |
| Harness 接线与独立分支 | `providers/runtime.ts` | 实际 Canonical→HTTP→工具轮→final；交互恢复、非聊天 JSON、实际 wire 快照 |
| 缓存、池、清洗与观测 | `cache.ts`、`client-pool.ts`、`sanitize.ts`、`cache-probe.ts` | 确定前缀、同进程协调、scope 生命周期、固定安全错误；不代替 Redis/Collector |
| Node 网络边界 | `providers/transport/` | 真实合成 TCP/TLS/CONNECT、DNS 固定、重定向拒绝、背压与超时；独立包入口 |
| 搜索、上传、ASR | `providers/vendors/` | 各厂商 HTTP/Schema/限制和明确拒绝；授权文件/探测/转码仍需 Media adapter |

Harness 固定 18 文件树保持原样；本轮只在既定职责文件补充非法工具参数及初始媒体消费的领域契约。`harness.ts` 不堆 Provider 业务，Provider 不依赖 Fastify、Electron、数据库或 Python，工具不从 Provider 直接执行。依赖闭包回归检查可移植 Provider/Harness/Executor 入口。

## 已执行的验证

- Python：当前 Git 基线的 Provider 和相邻 **43 文件、517 通过、0 失败/错误/跳过**，普通 Linux 原生串行 13.75 秒。初次缺 ffprobe 的跳过已经补依赖后实际消除。隔离配置、SQLite/fake 服务，不改用户运行配置、不调用生产 Provider、不用 Docker/xdist；未在 devserver 复验。
- Core：在 `gugu-core/` 使用 Node 26 执行 `node scripts/run-tests.mjs unit`，**36 文件、855 通过、0 失败/跳过**，包含共享 Harness 和 6 个快速 Provider 文件。
- Provider：`node node_modules/vitest/vitest.mjs run tests/agent/providers`，**7 文件、366 通过、0 失败/跳过**；其中真实网络文件按 `external_service` 归慢层。该集合与快速层重叠，不能相加冒充新增测试数。
- 严格检查与构建：`tsc -p tsconfig.tests.json --noEmit`、`node scripts/build.mjs` 通过。最终补齐三轮签名幂等、跨协议 Area 不变和完整媒体请求组合后，重新运行完整快速层、Provider 专项、测试类型检查及构建。
- 元数据：7 个 Provider 文件均登记 `tests/suites.json` 和测试元数据。全仓元数据检查仍受既有 WebUI/未跟踪桌面第三方测试登记缺口影响；不修改无关文件掩盖该结果。
- 未执行真实付费 Provider、PG/Redis、跨进程恢复、生产 Host/UI/部署及 GitHub CI。本轮无 Python 改动；原 Harness 918 项的历史结果不替代本轮 Provider 基准。

## 明确差异与剩余责任

Core 暴露归一事件和安全 `ProviderError`，不复刻 Python SDK 异常类、私有 Timeout 桥接或 `contextvars` 对象身份。原 SDK 内部裸 `AttributeError`/`IndexError` 的盲重试退役；已收到正文、工具参数、thinking/signature 之后不重发整轮。已收到片段但 SDK 因缺块尚未发布 token 的旧参数也会安全失败，这是已记录的收紧差异。

Node 的私有 wire/continuation 只在绑定身份的有界进程内暂存；跨 Run、过期、成功收尾或进程重启后不能依赖该引用恢复。加密持久 reasoning、旧 provenance 清理、SQL 历史/摘要水位原子事务、持久 Run/Job/租约/outbox、Redis 多进程协调与 LoopScope 白名单仍需真实 adapter。接口、内存实现和 fake 不计这些责任完成。

Host 的 BYOK 查询/解密/目的地绑定、Admin API 和配置保存、工具注册/Schema 校验/确认/权限、模型上下文绑定、RAG embedding、媒体授权及 FFmpeg、标题/摘要/反思调度和 Web/IM/Worker 调用点均未因 Provider 本体可调用而自动完成。SOCKS、自定义 CA 环境文件自动加载及 Host 网络配置热更新亦未完成。逐条部分覆盖保留原缺口；机器清单中的延后不是已经证明等价。

每组详细审查记录分别保存在 [OpenAI](provider-audit-openai.json)、[Anthropic](provider-audit-anthropic.json)、[厂商](provider-audit-vendors.json)、[共享规则](provider-audit-shared.json) 和 [相邻边界](provider-audit-boundaries.json)，主清单整合最新结论。真实适配和生产切换必须另行验收，不允许以本文总数关闭全部 N3 任务。
