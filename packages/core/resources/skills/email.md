---
name: 邮件
description: 用于向自己、指定邮箱或联系人发送邮件，也适用于含附件的通知和报告。
category: communication
related_tools: list_contacts, send_email
source: builtin
emoji: ✉️
---

# 邮件发送

- 使用当前会话的 `send_email` Schema。填写主题 `subject` 和完整纯文本正文 `body`。普通交流选 `plain`，结构化提醒、周期报告和状态通知选 `template`。只有需要定制排版且 Schema 开放时才用 `html`，同时保留纯文本正文。
- 模板按用途选 `notification`、`reminder`、`report` 或 `security`。按需传 `title`、`preheader`、`sections` 和 `actions`。主题和配色默认跟随用户设置。`test` 用于连通性或样式测试。
- 发给本人时省略 `to` 和 `client_id`。桌面使用已连接邮箱账户，Web 使用当前账号邮箱。指定外部邮箱时传 `to`，发给联系人时先核对客户 ID 再传 `client_id`。候选有歧义时先澄清。
- **桌面附件**使用 `file_refs`，从当前消息「引用文件」取真实引用键。只有文件路径时，请用户将文件引用到当前消息。
- **Web 附件**仅在当前 Schema 开放 `file_ids` 时使用，取当前用户文件库经工具核验的有效 ID。附件字段按端选择，最多 5 项。
- HTML 使用基础邮件标签和受控样式。操作链接用可访问的 HTTP(S) 或 mailto 地址。仅发送任务所需的内容和附件。
- 按工具回执等待确认。回执为 `sent` 时可说明邮件已提交发送，最终送达取决于收件服务器。结果未知时如实说明，避免重发。
