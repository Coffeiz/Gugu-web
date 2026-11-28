# Node WebUI 反馈提交与管理读取迁移

## 范围

将用户反馈提交与管理员反馈分页读取接入 Node WebUI Host，持久化沿用 `feedbacks` PostgreSQL 表。

## 行为与边界

- 用户提交经过认证，分类仅接受 `bug`、`suggestion`、`other`，正文去除首尾空格并拒绝空值；用户名快照优先使用显示名。
- 管理员列表沿用 `page`、`page_size`、`category` 参数和 `total/items` 响应，查询必须经过 Admin Host guard 与管理员认证。
- Python 的反馈邮件通知依赖 SMTP；Node WebUI 当前没有 SMTP sender，因此经 Node 提交时不会发送邮件。本次只迁移存储与读取，邮件通知这一副作用仍待迁移，不能视为行为完全等价。

## 验证

- devserver：`gugu-webui` TypeScript typecheck 通过。
- devserver：反馈 Host 路由与隔离 PostgreSQL 测试 5/5 通过，0 跳过；PG 用例在随机 schema 建表并清理。
- devserver：Python `tests/platform/email/test_feedback_email.py` 2/2 通过，保护 Python 侧现有邮件开关行为；它不验证 Node 邮件发送。
- 本地仅执行 `git diff --check`，没有在本机运行测试。

