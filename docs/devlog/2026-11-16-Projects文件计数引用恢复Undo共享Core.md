# Projects 文件计数、引用、恢复与 Undo 共享 Core

开始时已核对：上一切片 Projects/Clients 的 6 项新增回归和文档均在当前工作区，尚未提交；本轮没有重写这些测试。未修改 Python 参考后端、组合根、Agent 工具/RAG/MCP 或桌面页面。

## Python 语义核对与实际调用链

| 能力 | Python 行为与来源 | 当前 Core 与 Host 调用链 |
| --- | --- | --- |
| 项目卡片文件计数 | `app/db/project_file_counts.py` 读取投影，不扫描 files；投影只计 `space=project`、根目录直属、存活文件。列表含 owner 的归档/删除项目，缺投影行按 0，跨 owner 隐藏。PG 触发器负责更新投影，非 PG 不假装能重建 | 生产项目 list/get/counts 及更新/恢复回执 → Host `projects/persistence/projects.ts` → Core `read-store.ts`。Host 重复计数 SQL 已删除，借用 Host 现有 PG 池，不导入具体驱动、不接管池生命周期。SQLite 仍需 Host 提供真实路径索引/计数来源，不能因共享读取器存在就宣称正式投影已接通 |
| 文件引用 | `app/services/files/browser.py`：先查同 owner 的存活来源和有界、同 scope 的祖先链；解码后逐段验证中间目录，允许 `..` 但不能越过 scope 根；不把不存在的 `目录/..` 折叠成合法路径；文件优先于同名目录，保留输入顺序、重复项与原始路径 | 现有文件 `resolve-paths` 路由 → Host `file-reads-postgres.ts` 的 owner/scope 绑定查询 → Core `files/relative-references.ts`。Core 端口只以目录段和文件名定位，HTTP 的旧 file ID/DTO 仅在 Host 兼容。补齐 Python 对非法百分号/UTF-8 的解码语义，未引入网络访问 |
| 文件逻辑恢复路径 | `storage/trash.py`、`storage/keys.py`：按当前项目名称、开始日期/创建日期和有界归属目录重建路径；缺 Project/MindMap 元数据保留空名，坏目录链退回根；Workspace 缺失/删除必须拒绝；保留冲突 `(n)` 名称、扩展名与回收站目录规则 | Core `projects/file-paths.ts` 统一纯路径和关系解析；Host 项目存储与单文件 `file-restore-postgres.ts` 均复用。真实路径检查、权限、symlink/junction 检查及文件移动留在 Host |
| 项目删除与恢复 | `api/v1/projects.py`、`services/projects.py`：删除同 owner 项目及关联资源，停用提醒；恢复只选与项目墓碑精确同批的资源，项目超过 30 天拒绝，文件/目录/活动递增版本，恢复后启用关联提醒；缺物理源仍可恢复预期元数据 | 生产原 Host 入口 → 公开 Core `project-trash.ts`。Core 持有归属请求、保留期、同批选择参数、快照、版本、事务顺序、逆序补偿及提交后事件；Host 提供旧 PG 数据适配和物理存储端口。原 application 文件仅保留必要的公开重导出，使禁止修改的组合根继续接入同一用例 |
| 项目 Undo/redo | `undo/domains.py`：写入前检查全部 owner/版本；redo 使用上次 undo 版本；项目删除的恢复顺序为 project/folder/file/event/task，重做按 file/folder/event/project/task；保留任务关联和启用状态。`undo/service.py` 维护认领、操作终态与幂等 | Core 状态机 → Host 薄 PG 桥 → Core `projects/undo.ts` 的版本/快照/顺序/文件调度 → Host 物理端口。已有旧 Undo ref 只兼容历史记录，不新建文件 ID 模型。正文 Undo 继续复用已存在的 Core `undo/file-adapter.ts` 和 Host artifact 存储 |
| 中断后的文件移动恢复 | 旧 Python 没有同款 Node journal，不能把它计为 Python 等价项 | Host 保留 PG journal、进程间锁和操作状态读取；Core `recoverProjectFileMoves` 根据持久终态正向完成或逆序补偿。源/目标同时存在或同时缺失时拒绝并保留日志，不猜测提交结果；Host 原子不覆盖移动及目录恢复限制保持不变 |

Core 新业务模块不依赖 Node fs、Fastify 或具体数据库驱动。旧项目/文件/任务 ID 仅存在于已有数据库与 Undo 快照的兼容边界；物理端口始终按逻辑路径定位，不为桌面添加旧 File 对象表。

已有 Node 行为中，项目摘要 Undo 和事务失败后的物理补偿比 Python 旧实现更完整，本轮保留原有回归与行为。Python 对普通物理搬迁异常的宽容也保持；不安全路径仍明确中止，是既有安全边界，不能以兼容为由吞掉。

## 本轮新增回归与证据

- Core `tests/projects/relative-references.test.ts`：正常/非法编码、父级、根边界、缺失中间目录、文件优先和端口错误传播。使用路径合同，不断言 SQL 或源码写法；业务结果错误会失败，等价实现重构无需改预期。
- Host `tests/projects/project-core-sqlite.test.ts`：Core 用例 → 临时 SQLite 正式项目/Undo 表 → 真实 Host 临时文件端口，覆盖跨 owner 拒绝、提交失败回滚和物理反向补偿、同批恢复、冲突改名不覆盖原文件、文件数重读、旧 Undo 版本冲突及成功 Undo/redo。关联文件使用测试专用路径快照投影，不冒充正式 SQLite 文件索引/schema。
- 两个已有安全测试在 Windows 用目录 junction 表达越界链接，保留不覆盖目标和拒绝符号链接的行为断言。首次失败为夹具创建符号链接所需的系统权限，并非安全断言被放宽。

| 实际运行 | 结果与范围 |
| --- | --- |
| Core 构建 | `node packages/core/scripts/build.mjs` 通过，包含 Sandbox 与 Core 生产源码 |
| 定向 TypeScript | 新引用回归、SQLite/FS 合同、项目计数和 Undo 桥的临时配置检查通过；没有声称全量 Host 类型检查通过 |
| Core 定向 | 3 文件 26/26：新引用合同、既有 `unit/data/project-read-query.test.ts`、上一切片 `unit/data/contract.test.ts`。计数测试明确保留正式 SQLite 缺投影时报错的断言 |
| Host 定向有效子集 | 8 文件 30/30，0 跳过：新 SQLite/FS 合同、项目 Undo、项目存储、路径元数据、项目删除/恢复、Undo journal、文件恢复路由、文件 Undo 预检 |
| 原有 Python pytest | 新隔离源码副本串行 72/72，0 跳过：`projects/{test_project_trash,test_project_read_api,test_undo_phase4}.py`、`agent/test_undo_domains.py`、`storage/files/{test_undo_files,test_file_service}.py` |
| 补充 Python 引用对照 | 隔离副本临时 pytest 12/12，直接调用原 `_relative_path_parts` 和真实内存 SQLite 的 `resolve_relative_file_paths`，核对非法编码、owner、scope、中间目录和同名优先。临时探针及配置在验收后已清理，不进入仓库或提交，不修改参考实现 |
| PostgreSQL | **本轮未实测**：当前环境没有提供隔离连接，未发现可用本机 PG。共享查询迁移和 Host 桥仅完成源码/类型核对，不用 SQLite、mock 或历史报告代替 PG 集成 |

标准 Core 发现配置仍被本轮之前已有的未登记 Skill 测试阻断，故使用测试专用临时配置精确选择上述文件，保持串行和既有超时；新引用用例已增量登记 `tests/suites.json` 和测试元数据，没有改动不属于本轮的用例。Python 的配置路径、数据库和所有测试文件均在隔离临时目录，未读取仓库 `.env` 或 `config.override.json`。本机复用已安装的 Node 26、SQLite 驱动和依赖，未修改 lockfile 或运行依赖声明；验收后已移除本轮新建并核对目标的 11 个依赖查找链接，未删除其目标或原有文件。

额外尝试的 `apps/web-host/tests/files/file-undo.test.ts` 在导入整站 app 时因本机缺少 `@napi-rs/canvas` 未能加载，不计通过。未为它替换实现或引入假依赖；原 Python 文件 Undo、Node artifact/版本预检和本轮项目真实 SQLite/FS Undo 合同分别记录，不冒充完整认证路由验收。

## 剩余依赖与未覆盖路径

- 正式 SQLite 没有旧 `files`、`folders`、`project_file_counts`；本轮没有补造持久文件对象身份或安装一套旧文件库。桌面仍缺授权根、路径索引/枚举及相应 Host 端口的生产装配；因此桌面项目计数、引用和文件恢复尚未接通。共享规则已由 Web 既有消费者接入，完整桌面物理生命周期须在授权路径能力完成后独立验收。
- Web 继续兼容旧 PG 文件/目录记录和旧 Undo ref；退出旧模型前需要数据去向、路径引用和 artifact 迁移方案。相对路径引用在改名/移动后允许失效，不补建隐式永久 ID 来修复它。
- 真实 PG 的计数触发器/并发、事务锁、项目级多资源完整 schema、混合 Python 写入、跨进程 journal/Redis/SSE 和后台任务消费者未实测。测试中的部分旧资源集合是精简夹具，不代表完整 SQLite 多域 schema 已落地。
- 本记录之后，PR #121 的目标覆盖竞态已由[原子防覆盖修复](./2026-11-16-PR121项目移动原子防覆盖.md)处理：常规文件排他硬链接占用目标，目录缺少安全原语时明确拒绝。父目录组件替换等完整 FS 授权、受控写入和生命周期仍不在本轮扩大实现范围内。
- 本轮不运行 Docker、真实 Provider、生产服务或 GitHub CI；未提交、推送或覆盖其他会话文件。上一切片修改及原有未跟踪目录保留。
