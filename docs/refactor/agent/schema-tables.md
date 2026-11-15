# Agent SQLite 三表迁移草案

本文件仅为 SQL 审查材料，未注册到初始化或升级器，不能用于声称桌面 Agent 可运行。字段、可空性及索引对照 `backend/app/models/__init__.py` 中 ConversationSession、ConversationMessage、ConversationPendingQueue；现有 Core 刷新、会话查询和 pending queue 使用相同列名。ORM 的 Python 侧默认值并非数据库默认值，仅实际声明的 server_default 放入 SQL。调用方必须填写其余非空字段。

- UUID 按 Python SQLite Uuid 表示为 32 位小写十六进制，边界转换有连字符的标准 UUID；现有 Core 队列代码采用此表示。布尔使用 0/1，整数的 JavaScript 读取必须保护安全整数范围。
- JSON 列保存 JSON 文本、保留 SQL NULL 与 JSON `null` 的区别；应用负责序列化和验证。UTC 时间使用 `YYYY-MM-DD HH:MM:SS.ffffff` 文本，由应用规范化，不能经 JS Date 截断微秒。SQL 不引入比 Python 更严格的 JSON 或枚举约束。
- 原 ORM 外键指向 users、workspaces 和 conversation_batches；草案不创建或伪造这些表。现有 Core SQLite 并无完整的这些依赖，必须先由统一 schema 决定对应结构和身份映射，才能安装；SQLite 必须启用 foreign_keys。实际业务还需其他表，三表不是完整 Agent 数据层。
- 开启外键时，仅创建三表仍无法插入依赖缺失的行；不能通过关闭外键绕过。历史会话可能存在 `source` 为 SQL NULL 的记录，导入前应核对并保留其现有列表语义；草案中的 AUTOINCREMENT 也需与正式 ID 策略单独核对。
- 历史时间必须验证并统一编码后再依赖文本排序；SQLite 的浮点日期函数不足以表达相邻微秒。列表文件授权到期边界及交互分页窗口仍需正式双库验证。
- 执行前须校验 schema 版本、owner、预期已有表结构和依赖；任何已存在的三表或名称冲突均拒绝，不使用 IF NOT EXISTS，不覆盖旧数据。升级器需先通过 SQLite 在线备份 API 在独立路径创建一致性备份，校验备份能打开、完整性和 owner/version，再以 BEGIN IMMEDIATE 在同一事务创建表、索引及更新版本，提交后执行 foreign_key_check 和完整性验证；失败回滚并保留备份。不能用复制主数据库文件替代 WAL 一致性备份。空库初始化应在同一原子初始化流程纳入相同 DDL；v5 的确切升级版本和整合次序由统一 schema 决定。
- 当前测试只演示临时库里的 DDL、冲突回滚和 SQLite 备份快照；并未实现或验收生产升级器、跨版本数据转换、崩溃恢复或备份校验流程。禁止直接对用户数据运行草案。
