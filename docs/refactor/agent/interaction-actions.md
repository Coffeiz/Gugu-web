# 交互动作表草案

DDL 和只读校验已移动至 `../../../packages/database/src/sqlite/interaction-actions.ts` 并接入 SQLite 编号基线；本文件保留设计说明；合同测试已归入 `packages/core/tests/agent/interactions/` 并登记常规测试，不代表桌面交互闭环。对照 Python `InteractionAction` 定义全部字段、可空性、提示外键和索引；action 本身不存 owner，归属通过可信 `interaction_prompts` 的 owner/session 与外键传递。调用方必须先完成提示表的正式 schema 和 owner 校验，读取或更新动作时必须通过提示归属验证，不能只凭 action id 查询。

`token_hash` 只保存调用方生成 token 的 SHA-256 摘要；此表不保存明文 token，DDL 没有限定摘要的字符或长度，以免额外拒绝 Python SQLite 原本可写入的历史数据。未增加 status 枚举、option 唯一、JSON 类型等 Python 未定义约束。JSON 文本必须保留 JSON null 与 SQL NULL 的区别；UTC 时间由受信调用方以微秒规范化写入。候选 DDL 要求显式写入全部非空列；Python ORM 客户端有默认值，旧 PG 初始 migration 还有服务器默认值，若正式迁移要求兼容省略字段的裸 SQL 写入，应同步补默认并测试，不可声称当前 DDL 已涵盖该差异。尤其不要使用 SQLite CURRENT_TIMESTAMP 假称支持微秒。

初始 PG Alembic 建立 prompt_id、token_hash、status 三个索引；当前 Python ORM 还对 expires_at 声明索引。草案按 ORM 增加第四个；现有 PG 实际索引须以数据库迁移状态核实，不能假设已有。只读校验比较表/索引完整定义并检查动作外键；不能替代提示表 owner、外键和历史数据的独立校验。

正式升级在 prompt 表之后追加，空库初始化同样建立；保留在线备份、完整性与 owner 校验，单个 BEGIN IMMEDIATE 事务完成建表/索引/版本更新并检查结构/FK，冲突或错误回滚并保留可恢复备份。需覆盖所有旧版本、损坏结构、WAL/并发锁和失败恢复；本目录临时合同不是正式升级验收。

建表本身不实现 token 生成、轮换、消费、并发控制、凭据保护或交互恢复，更不代表桌面 Agent 交互闭环。
