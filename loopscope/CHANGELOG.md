# Changelog

LoopScope 的用户可见能力、Trace 协议和持久化结构变更记录。

## Unreleased

### Added

- Run 列表支持多选导出，并在导出数据中保留按 round 组织的索引。
- LLM round 支持显示 Input 最早变化点、前缀稳定性和变化原因，并可一键定位到对应消息。
- 支持对比同一 Run 的上一 round；round1 支持自动加载并对比时间上一个 Run 的最后一个 LLM round。
- LoopScope 前端补充 TypeScript workspace、Collector 迁移基础设施与存储契约。

### Changed

- Input 面板保持原有手动展开行为，定位和上一轮对比改为独立的显式操作，避免查看长输入时被自动滚动打断。
- Trace 诊断继续沿用结构化 metadata，变化定位不复制用户正文到后端日志。

## 0.2.0 — 2026-08-17

### Added

- Span Code Provenance：记录 Python `file / module / function / qualname / line`。
- Context Provenance：Context Assembly 下可看到 DB loader、Memory、Prompt Markdown、渲染后的业务上下文、稳定缓存前缀和动态后缀。
- Prompt 文件独立内容查看：`persona.md`、`skills.md`、`policy.md`、当前 profile 模板可单独展开。
- Run / LLM Span token usage：input、output、cache read、fresh input、total。
- Context / Tool token impact：记录 source/included/result/prompt growth 的本地 token 估算。
- `/changelog` 页面。
- SQLite 0.1 → 0.2 原地 schema migration，新增 `usage_json`、`code_json`、`token_impact_json`。

### Changed

- Monitor 不再是独立路由；现在是当前 Session 的布局模式，与对话共享 Session 导航和标题区。
- Span 改为紧凑卡片；`Content / Input / Output / Source / Attributes` 可独立展开，不再一次展开全部 JSON。
- Design Tokens 增加 Database / Prompt File / Memory / History / Cache / State Trace semantic tokens。

### Compatibility

- Gugu 侧仍只在 `LOOPSCOPE_ENABLED=true` 时安装观测 hook。
- LoopScope Collector 不可达仍不会影响 AgentLoop 主链路。
- 0.1 SQLite 可直接继续使用，不需要删除 `loopscope.db`。

## 0.1.0 — 2026-08-17

- 独立 `loopscope/frontend` + `loopscope/backend` + SQLite + Docker。
- 0.3：LoopScope 后端迁移为 TypeScript Collector，保留 SQLite 和 HTTP API 兼容性。
- 多 Session 真实 Web Agent 对话。
- 普通 / 详细对话模式。
- Run / Span Monitor，支持 Prompt、LLM draft、Tool、Guard 输入输出查看。
- 独立 Design Tokens 页面与 Gugu `/dev` 入口。
