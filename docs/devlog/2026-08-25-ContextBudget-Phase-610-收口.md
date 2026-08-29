# 开发记录 · 2026-08-25 · ContextBudget Phase 6/10 收口

## 2026-08-25 · ContextBudget Phase 6/10 收口

### 完成内容

- 统一 90% 观察线由 provider usage 驱动，core 不再复制预算比例常量。
- 删除 `select_history_window`、历史读取 `token_budget` 兼容参数及其旧裁剪测试，避免 ContextBudget 之外残留第二套历史窗口语义。
- 完成 ContextBudget、压缩 cap、provider overflow retry、baseline 提交、session gate/pending 的专项回归。
- 上下文专项测试通过 64 项；devserver 上下文专项测试通过 67 项。本地全量 1419 项通过、1 项 knowledge 内容换行断言失败，属于本次范围外的工作区改动。

### 验收边界

自动化验收已完成；真实长群 trace 的 cache/输入 token 对比和多 worker 故障恢复仍需在产品环境持续观察。日志只记录脱敏预算分项和生命周期状态，不记录对话正文。
