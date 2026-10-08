# Agent 项目摘要与文件范围

> 状态：✅ 已完成并通过针对性验证
> 创建：2026-10-06
> 最近更新：2026-10-06
> 关联模块：`backend/agent/tools/projects.py`、`backend/agent/tools/files/file_operations.py`、`backend/agent/context/`
> 背景参考：项目 305 文件库检索问题复盘及本轮设计讨论

## 0. 实际状态

| 能力/结果 | 状态 | 说明 |
|---|---|---|
| 项目摘要字段及 Agent 维护 | ✅ 已完成 | 摘要可创建、更新、清空，长度与类型经过验证；普通项目 API 不暴露。 |
| 项目文件概览进入详情工具和既有 snapshot | ✅ 已完成 | 增加存活文件、根层文件和目录计数；原项目选择、排序和数量上限保持不变。 |
| 项目根层、递归及具体目录查询 | ✅ 已完成 | `list_dir` 新增显式范围；无 `scope` 时保留旧行为。 |
| 项目摘要数据可移植 | ✅ 已完成 | 项目导出投影包含 `summary`，兼容旧归档。 |

## 1. 背景与目标

项目文件可能尚未绑定根目录，但仍以 `project_id` 归属项目。原有 `list_dir(space="project", project_id=...)` 将“省略目录”和“项目根层”混为一谈；仅按目录树浏览时，未归档到文件夹的项目文件不易被发现。`get_project` 也没有统一提供文件概览，Agent 因而可能把空目录结果误当成项目没有素材。

本 PRD 为 Agent 提供明确、可组合的项目资料契约：`get_project` 同时返回项目状态摘要和文件计数；`list_dir` 明确区分项目根层、项目递归范围和指定文件夹；已有动态 snapshot 只为原本已选中的项目增加摘要与概览。

项目摘要是给 Agent 维护的近况说明，不展示在普通 UI，不取代状态、阶段、日期或待办。`summary` 最长 200 个字符；项目文件概览只返回计数，不加载项目文件正文或完整文件清单。

## 2. 功能需求

### FR-PROJECT-01：维护项目摘要

Agent 的 `create_project` 和 `update_project` 接受可选 `summary`。摘要经去除首尾空白后保存；空字符串或 `null` 清空；超过 200 个字符或非文本值返回可理解的校验错误，不得部分写入。普通项目 API 不返回此字段，前端不展示或编辑。

### FR-PROJECT-02：读取项目文件概览

`get_project` 返回 `files` 计数对象：项目存活文件总数、根层（`folder_id IS NULL`）文件数、项目存活目录数。项目未绑定文件根目录时仍按 `project_id` 统计散落文件。该对象不包含文件名、路径或正文。

### FR-PROJECT-03：明确项目目录查询范围

`list_dir` 增加 `scope`：

- `project_root`：必须同时指定 `space="project"` 和 `project_id`，列出根层文件及根层目录。
- `project_recursive`：必须同时指定项目空间和项目 ID，列出项目下全部存活文件与目录。
- `folder`：必须提供真实 `folder_id`，只列出该目录的直属文件和子目录；指定目录必须属于当前用户和请求的空间/项目。

项目 ID 与文件夹 ID 属于不同命名空间，不为项目额外创建冗余根目录 ID。无效、已删除或跨用户/跨项目目录返回错误。省略 `scope` 时维持旧查询行为，避免破坏既有调用者。

### FR-PROJECT-04：扩展既有项目 snapshot

snapshot 对项目的筛选、排序、状态分组、数量上限和字段顺序语义保持原样。只对该轮已经入选的项目附加摘要及文件计数。摘要明确标成资料而非操作指令；文件概览说明计数范围，根层文件夹仍与根层文件分开表达。新增字段遵循现有 snapshot 生命周期：首次创建或过期后重建时读取，不改变有效 snapshot 的冻结策略。

### FR-PROJECT-05：归档保留摘要

用户数据导出和导入的项目记录包含 `summary`，旧归档缺失该字段时继续按空值导入。

## 3. 技术方案

项目摘要由 `Project.summary` 保存，数据库长度为 200。项目工具复用既有项目事务和统一字段校验；公开项目响应保持原 allowlist，不新增摘要字段。数据可移植通过项目记录投影 allowlist 增加该字段。

项目文件概览在 `project_context` 服务中按已选项目批量聚合 `File` 和 `Folder`，只计算未删除记录。Agent 工具详情与 snapshot 共用同一投影；snapshot 的项目选择和排序逻辑不变。`list_dir` 通过显式 scope 表达项目根层/递归/目录浏览，底层搜索与计数共用过滤条件，保证 `shown` 和 `total` 口径一致。

```text
backend/app/models/__init__.py                                      【修改】项目摘要字段
backend/alembic/versions/20261006000001_add_filesync_reconcile_runs.py 【条件】现有工作区中的父迁移，保持 Alembic 迁移链连续
backend/alembic/versions/20261006000002_add_project_agent_summary.py 【新增】摘要列迁移
backend/app/core/projects.py                                        【修改】摘要校验和事务字段
backend/app/services/project_context.py                             【新增】项目资料聚合与投影
backend/app/services/files/browser.py                               【修改】根层文件过滤
backend/agent/tools/projects.py                                     【修改】摘要维护及项目详情
backend/agent/tools/files/file_operations.py                        【修改】目录查询范围与校验
backend/agent/tools/files/file_tools.py                             【修改】工具 schema 和说明
backend/agent/context/loaders.py                                    【修改】既有入选项目的批量计数
backend/agent/context/builder.py                                    【修改】既有 snapshot 增补资料
backend/app/services/data_portability/projection.py                 【修改】摘要归档投影
backend/tests/test_project_agent_context.py                         【新增】项目摘要、范围与 snapshot 行为测试
```

文件归属与访问校验仍由现有文件查询服务和 `get_user_folder` 负责。父迁移仅为承接工作区已有 Alembic 链而纳入提交，其文件同步功能实现不属于本 PRD。此变更不修改项目 UI/API 响应、不调整 snapshot 选项、不引入合成 folder ID、不加载文件内容，也不改变文件树数据模型。

## 4. 验证与上线

验收覆盖摘要创建/更新/清空/超长拒绝、项目无根目录时的文件计数、根层与递归及指定目录查询、未知或不属于当前项目的目录拒绝、无 `scope` 的旧行为、snapshot 对原项目集合的增量扩展、公开项目响应隐藏摘要，以及归档投影保留摘要。

上线由 Alembic 扩展 `projects.summary` 可空列；回滚时保留摘要数据，不主动删除列或用户摘要。相关实施结果见唯一 TODO `PROJECT1-001` 至 `PROJECT1-004`。

## 5. 风险与待确认问题

| 风险 | 影响 | 对策 |
|---|---|---|
| 项目摘要包含过时或类似指令的内容 | Agent 可能把项目资料误当成当前操作 | snapshot 明确标记为资料，不是操作指令；更新由 Agent 工具显式写入。 |
| 项目文件量随项目增长 | 每轮上下文聚合开销增长 | 仅对已按既有规则选中的项目批量计数，不读取文件正文或明细。 |
| 旧调用者依赖省略 `scope` 的隐含语义 | 切换查询结果可能造成工具行为回归 | 保留旧行为；新调用使用显式 `scope`。 |
| 当前工作区存在未提交的文件同步迁移 | 本功能迁移链与工作区已有迁移存在父子依赖 | 提交前核对迁移图并保留既有未提交文件；只提交能构成有效 Alembic 链的必要迁移。 |

待确认问题：无。

## 6. 唯一实施 TODO

- [x] `PROJECT1-001` 增加项目摘要模型、迁移、校验及 Agent 创建/更新工具；验收：`summary` 可写、可清空、长度和类型错误被拒绝，公开项目响应不暴露字段。
- [x] `PROJECT1-002` 扩展项目详情及文件目录工具契约；验收：根层、递归和具体目录行为明确，项目边界错误可见，无 `scope` 兼容旧行为。
- [x] `PROJECT1-003` 在既有 snapshot 与数据移植中附加项目资料；验收：项目选择/排序规则不变，计数和摘要随 snapshot 提供，导出投影包含摘要。
- [x] `PROJECT1-004` 完成针对性测试、迁移链和代码差异复查并提交；验收：46 项针对性测试及静态检查通过，提交只含本 PRD 范围及迁移链必需文件。
