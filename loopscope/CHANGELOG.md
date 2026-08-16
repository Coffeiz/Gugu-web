# Changelog

LoopScope 的用户可见能力、Trace 协议和持久化结构变更记录。

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
- 多 Session 真实 Web Agent 对话。
- 普通 / 详细对话模式。
- Run / Span Monitor，支持 Prompt、LLM draft、Tool、Guard 输入输出查看。
- 独立 Design Tokens 页面与 Gugu `/dev` 入口。
