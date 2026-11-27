# 数据库基础层实施计划

目标架构见 [Monorepo 架构](monorepo.md#数据库目标架构)。现行入口见 [Database README](../../packages/database/README.md)。本页的复选框记录实施状态。

## 交付顺序

### 1. 统一实例装配

- [x] 盘点 Core 的 PostgreSQL、借用连接和 SQLite Kysely 入口。Web Core 池随 Kysely 关闭，借用连接由外层事务管理。SQLite 先执行文件配置与升级校验，再交给 Kysely。
- [x] 在 Database 提供两种引擎的 Kysely 工厂。Web Host 注入 PostgreSQL 实例，Desktop Core Host 通过同一基础层装配本地 SQLite 实例。
- [x] 沿用 Kysely 查询与事务 API。保留 SQLite 的 `BEGIN IMMEDIATE`、PostgreSQL 的 UTC 与微秒时间解析，以及现有 JSON 和约束错误映射。后续有实际跨引擎差异时再补适配。
- [x] 完成宿主生命周期验收。Web Host 在隔离 PostgreSQL 上执行正式迁移后，通过正常入口启动、读写偏好并关闭连接池。Desktop 的独立 Node Core 在临时 SQLite 上通过顶栏搜索、IM 会话历史与关闭测试。

### 2. 用一个逻辑迁移支持两端

- [x] 盘点 PostgreSQL 现有清单、SQLite 基线与已有文件增量步骤。记录各自的版本、结构校验、并发锁和失败恢复行为。
- [x] 定义共同逻辑迁移清单。每项包含稳定 ID、执行顺序和目标引擎。普通列、表、索引及可移植回填共用同一个 Kysely 执行主体。SQLite 重建表、PG 特殊约束等差异放在同项的引擎专属步骤。
- [x] 压平未上线阶段的迁移历史。两端从各自的 `0000_baseline` 启动，再执行共同清单。压平前的开发库在检查和应用时会被拒绝并保留原数据。
- [x] 统一 `check` / `apply` 的结果和退出语义，保留每个数据库各自的部署配置。提供一条开发验收命令，在隔离环境分别执行 PostgreSQL 和 SQLite 的检查及迁移。
- [x] 用下一项真实共享结构变更验证一份迁移跑两端。覆盖空库、旧库升级、重复执行、事务失败后的回滚和重试，以及引擎专属步骤只在指定引擎执行。

首条逻辑迁移是 `0049_conversation_role_sequence`。Web 通过现有迁移命令应用，Desktop 新库、已有库的迁移命令和 Core Host 打开文件路径均接入。验收命令见 [Database README](../../packages/database/README.md)。

### 3. 把 IM 仓储归回领域

- [x] 清点旧 `@gugu/database/im-inbox` 的 Web、Core 与共享契约测试调用方。Desktop 仍通过 Core IPC 消费收件。
- [x] 把 PostgreSQL 入站仓储移到 Web Host IM Gateway，把 SQLite 收件和投递恢复移到 Core IM。Database 管理表类型、索引与约束。SQLite 仓储使用 Kysely，PostgreSQL 保留同一连接上的参数化锁与租约 SQL。
- [x] 保留 PostgreSQL 租约、Telegram 收件与游标的原子事务，以及 SQLite 附件事务和原 Run 的恢复顺序。
- [x] 移除旧包入口并迁移共用测试。隔离 PostgreSQL 和临时 SQLite 验证重复事件、租约竞争和过期、回滚，以及重启沿用原 Run。Desktop IM 调度回归也通过。

### 4. 在 Core 验证完整事务边界

- [x] 会话消息页由 Core 共用正序投影和边界游标，Web 与 Desktop 保留各自的数据库排序和游标协议。两端正常消息入口已验收。
- [x] 两端使用 Core 的同一份 Kysely 准入回执仓储，并由共享迁移 `0050_agent_chat_receipts` 管理表。回执在消息、Run 和必要调度状态的事务内写入。验收覆盖重放返回原消息与 Run、同键不同请求冲突、失败回滚和 SQLite 重开后恢复。
- [x] 更新 Database 与 Core Agent 的入口说明，验证 Web Host PostgreSQL 准入和历史读取，以及 Desktop 独立 Core Host 的历史分页。

## 表结构约定

领域定义字段与生命周期的意义。Database 维护类型化表定义和强制约束。统一 ID、时间、JSON、可空性和序号在代码中的表示。物理列类型、加锁方式和索引可按引擎选择。owner、唯一标识、序号和并发控制字段保持显式，版本化消息载荷和引擎外的扩展数据可用 JSON。

每个部署独立应用自己的数据库迁移。跨两库的同一版本验收在隔离环境执行，两端分别记录迁移结果。发布前用上一已发布版本的库验证升级，检查消息归属、幂等键、Run 和待处理任务均可读取恢复。
