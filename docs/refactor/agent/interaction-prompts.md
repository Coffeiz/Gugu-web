# 交互提示表草案

`../../../packages/core/src/agent/interactions/schema.ts` 导出已接入 SQLite 初始化及升级器的 DDL 与只读结构校验；本文件保留审查说明；隔离合同测试已归入 `packages/core/tests/agent/interactions/` 并登记常规测试，不代表桌面交互可用。字段对照 Python `InteractionRequest` 类型和可空性，以及现有 SQLite 单 owner 约束；不创建 users。写入方必须显式提供所有非空字段；Python ORM 客户端默认值与 PostgreSQL 初始 DDL 服务器默认值不自动迁入，若需要裸 SQL 省略写入兼容，须另行确定并测试。时间由调用方提供 UTC 微秒文本；JSON 以文本保存并保留 JSON scalar、JSON null 与 SQL NULL 区别，`schema_json` 列本身非空。DDL 不强加 JSON 形状、状态枚举或长度检查。

提示 owner 使用与当前 SQLite 会话一致的标准化 32 位十六进制；复合外键与 `conversation_sessions(id,user_id)` 唯一索引配合，保证提示指向同 owner 的会话且删除会话级联。严格限制与 Python/PG 两个独立外键不同：PG 中若存在提示 owner 和会话 owner 不一致的历史行，原深链读取仍按提示 owner 返回 session id，必须单独审计及制定兼容策略；不得静默过滤、修复或声称 PG 已有复合约束。

正式整合由共享 schema 负责人串行进行：独立添加 DDL，不改历史 `SQLITE_AGENT_SCHEMA` 的版本校验；显式保留版本 10 的所有检查，新建和从 1–10 升级统一建表；使用已有在线备份、备份元数据/完整性和外键校验，BEGIN IMMEDIATE 下完成 schema、索引、触发器、目标版本同事务，遇名称冲突或检查失败回滚且保留备份。版本号、桌面制品和握手由整合方统一决定。

结构验证检查列名、类型、主键、NULL、四个索引及列顺序，复合外键每个 from/to、归属同一 FK 和级联，两个 owner 触发器的完整行为及定义，并运行 `foreign_key_check(interaction_prompts)` 和 owner 行核查。还需覆盖触发器/索引/外键缺失、已有冲突表、备份不可用、旧库数据与版本回滚，真实生产升级器的全部历史版本、WAL 和崩溃恢复测试；本目录的隔离草案测试不替代这些验收。

深链查询仅依赖 id、user_id、session_id、schema_json；不过期过滤且只返回 session_id。提示创建、动作 token 生成与一次性消费、凭据加密及恢复均不在本草案中。
