# 咕咕文档导航

本文是 `docs/` 的唯一入口，按当前代码和可复现验证结果维护。目标架构、历史实现和未落地设想必须明确标记，不应与当前行为混写。

## 当前基线

| 范围 | 当前实现 |
|---|---|
| Web 与 Admin | Vue 3、TypeScript、Vite；业务 API 由 Python 3.12 + FastAPI 提供 |
| Agent 与 IM | Python `backend/agent/`、Python worker 和 Python 网关，共用 Agent Loop、上下文、工具、记忆与渠道适配 |
| 数据与任务 | PostgreSQL、SQLAlchemy、Alembic、Redis、APScheduler；用户数据按所有者隔离 |
| 实时更新 | 业务写入发布 canonical event，经 Redis event bus 由 FastAPI SSE 推送到前端；聊天流和 Admin 日志流各自保持独立生命周期 |
| 本地交互同步 | `InteractionSync` 协调本地即时状态、服务端响应和跨标签页事件；画布为 Phase 1 首个接入域，保留实体字段和 Runtime 视觉生命周期边界 |
| 交互终端 | 真实 PTY 使用 WebSocket；它不是资源实时更新 SSE，也不是命令历史列表 |
| TypeScript 边界 | 前端构建、独立 LoopScope 和 RAG lexical worker；不作为公开 API、Agent、IM 或 scheduler 的替代后端 |
| Shell | 用户 Shell 经过沙盒执行器和 Docker 隔离；工作区只提供默认目录，系统范围能力和临时公网出口受权限控制 |
| 观测 | LoopScope 记录 Agent Run、上下文来源、Provider 用量、Prefix Diff 和 cache 证据，属于开发观测工具，不是业务事实源 |

## 推荐阅读顺序

1. [产品总览](product/OVERVIEW.md)：产品边界、页面、技术栈和开发入口。
2. [Agent 文档索引](agent/00-INDEX.md)：Agent 架构、上下文、工具、记忆、渠道和可靠性。
3. [后端现状](backend/OVERVIEW.md)：Python/FastAPI 服务、数据层、进程和接口边界。
4. [部署与运维](ops/deploy.md)：本地、devserver、生产服务、Compose 和常见排障。
5. [PRD 规范](prds/README.md)：需求状态、唯一实施 TODO 和文档更新规则。

## Agent 与 AI

这些是当前架构文档，内容以代码、测试和运行验证为准：

| 文档 | 内容 |
|---|---|
| [Agent 总览](agent/01-OVERVIEW.md) | Agent 定位、技术边界和运行组成 |
| [Agent 架构](agent/02-ARCHITECTURE.md) | Web、IM、定时任务、上下文、工具和持久化分层 |
| [Agent Loop](agent/03-AGENT-LOOP.md) | 一次请求从入站到多 Round、工具和出站的执行链路 |
| [上下文工程](agent/04-CONTEXT-ENGINEERING.md) | Snapshot、History、Memory、RAG、压缩和缓存前缀 |
| [工具与 Skill](agent/05-TOOLS-AND-SKILLS.md) | 工具注册、Skill 按需注入、Schema 和权限边界 |
| [RAG 与 Knowledge](agent/06-RAG-AND-KNOWLEDGE.md) | 来源范围、索引、TypeScript lexical worker、召回和引用 |
| [Memory 与 Reflection](agent/07-MEMORY-AND-REFLECTION.md) | 私聊、群聊、群友记忆、反思触发和长期信息维护 |
| [渠道接入](agent/08-CHANNELS.md) | Web、QQ、微信、飞书的消息处理和功能支持矩阵 |
| [消息协议](agent/09-MESSAGE-PROTOCOL.md) | canonical history、stream event、工具消息、附件、引用和出站 parts |
| [可靠性](agent/10-RELIABILITY.md) | 保序、幂等、重试、取消、重启、恢复和失败收束 |
| [LoopScope](agent/11-LOOPSCOPE.md) | Run 观测、脱敏边界、Context Provenance、Prefix Diff 和 cache 排查 |
| [Agent 命令](agent/COMMANDS.md) | 统一斜杠命令和会话控制 |

## 后端与数据

- [后端现状总览](backend/OVERVIEW.md)：服务形态、目录职责、数据库、Redis、Agent 和进程边界。
- [存储规范](backend/STORAGE.md)：本地 / OSS、文件 key、暂存附件、回收站和生命周期。
- [后端开发说明](development/README.md)：开发、测试、依赖和后端工程约定。

## 产品与前端

- [产品总览](product/OVERVIEW.md)：项目、文件、日历、思维面板、咕咕协作和页面状态。
- [MVP](product/MVP.md)：MVP 功能边界和当前状态。
- [Wishlist](product/WISHLIST.md)：尚未纳入当前基线的候选方向。
- [文件预览历史方案](product/_archibe/FILE-PREVIEW.md)：文件预览、抽屉和浮动窗口的历史设计记录。
- [思维面板归档资料](product/_archibe/思维面板/)：笔记、画布、数据模型和历史实现方案；当前行为以代码和 Agent 专题文档为准。
- [前端 JS 转 TS 历史指南](product/_archibe/【已完成】前端-JS转TS迁移指南.md)：前端迁移记录。

## 运维与性能

- [部署与运维](ops/deploy.md)：开发服务、生产服务、Compose、systemd、同步和回滚。
- [性能记录](ops/PERFORMANCE.md)：性能问题、优化结果和验证方式。
- [已知问题](ops/KNOWN-ISSUES.md)：当前已知缺陷、边界和排查入口。

## 安全与合规

安全边界以仓库根目录 [`AGENTS.md`](../AGENTS.md)、后端所有权与脱敏实现，以及 [SEC-2 越权检测与快速封禁 PRD](prds/【已完成】PRD-SEC-2-越权检测与快速封禁.md) 为准。旧的安全审计材料不在当前 `docs/` 目录中，不在导航里保留失效链接。

## PRD 与重构方案

- [PRD 撰写规范](prds/README.md)：PRD 状态、章节结构、唯一实施 TODO 和 Phase 组织规则。
- [PRD 目录](prds/)：按领域维护需求文档；文件名带 `【已完成】` 或 `【已归档】` 的文档分别表示已完成记录和历史设计，不代表仍有待办。
- [重构方案目录](refactor/)：已完成或正在评审的工程重构记录；具体功能现状仍以代码和当前 PRD 为准。

## 报告与开发日志

- [开发日志](devlog/README.md)：按时间记录排查、决策和变更背景。
- [报告目录](reports/)：缓存、上下文、LoopScope、RAG 和外部依赖的调查或测试报告。
- 报告是证据材料，不自动改变产品基线；引用性能数据时应注明测试日期和适用条件。

## 维护规则

- 文档描述现状时，以代码、测试和运行验证为准；如果与旧文档冲突，更新现状文档并把旧内容放入对应归档目录。
- 每个 PRD 只能有一个实施 TODO，Phase 只能在该 TODO 内组织；章节中的状态摘要不得复制另一套任务清单。
- 文档内链接使用相对路径；文件名中的英文部分统一使用大写，扩展名保持小写。
- 新文档按主题放入 `agent/`、`backend/`、`product/`、`ops/`、`refactor/` 或 `reports/`，安全规范优先更新 `AGENTS.md` 与对应 PRD，不要把当前说明继续堆到本文件。
- 审计、压测和调查报告保留原始时间点；只在结论失效或引用无法定位时更新，并记录变更原因。
- 代码改动完成后同步更新受影响的架构文档或 PRD，避免把已撤回方案继续写成当前实现。

变更历史见 [`../CHANGELOG.md`](../CHANGELOG.md)，仓库协作和测试约定见 [`../AGENTS.md`](../AGENTS.md)。
