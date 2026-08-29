# ORM 规范化方案

## 1. 目标

Gugu-web 后端统一使用 SQLAlchemy 2.x Async ORM，不引入第二套 ORM。本文用于约束新代码，并以棘轮方式逐步收敛存量代码。

目标不是一次性重写全仓，而是保证新增代码不继续扩大 ORM 使用差异，并优先治理文件、文件夹、回收站和 Agent 工具等高风险领域。

## 2. 分层职责

```text
API 路由层
├── 认证与依赖注入
├── 参数解析和 Schema 校验
├── 调用 Service
├── HTTP 异常映射
├── commit / rollback
└── 返回响应 Schema

Service 领域层
├── 业务规则
├── 资源归属校验
├── ORM 查询与写入
├── 多表事务编排
└── 返回领域结果

Model 层
└── 表结构、字段、关系和基础约束
```

API 层不新增复杂 ORM 查询；Model 层不承载文件移动、项目推进、回收站等业务逻辑。

## 3. 查询规范

### 3.1 归属查询

查询当前用户拥有的单条资源，统一使用 `get_owned()`：

```python
item = await get_owned(db, File, file_id, user_id)
```

不要新增以下模式：

```python
item = await db.get(File, file_id)
if item.user_id != user_id:
    ...
```

`get_owned()` 同时负责防止资源枚举和记录结构化越权告警。

### 3.2 列表查询

列表查询必须显式写出用户范围、软删除范围和业务空间：

```python
stmt = select(File).where(
    File.user_id == user_id,
    File.deleted_at.is_(None),
    File.space == "personal",
)
```

列表查询应放在对应 Service 或查询模块中，API 只接收结果并组装 HTTP 响应。

### 3.3 关联加载

Async ORM 禁止依赖隐式懒加载。需要关联数据时，在查询阶段明确使用 `selectinload()` 或 `joinedload()`：

```python
stmt = select(Project).options(selectinload(Project.files))
```

循环内不得为每条记录再发起单独查询；批量场景应使用 `IN`、聚合查询或预加载。

## 4. 写入和事务

- Service 修改实体后使用 `flush()`，让同一事务中的后续逻辑拿到 ID 和约束结果。
- API 或任务边界统一负责 `commit()` 和 `rollback()`。
- 涉及多个表、数据库和物理存储的操作必须由一个 Service 编排。
- 事务失败后不得继续发布事件、刷新缓存或返回成功响应。
- 已产生副作用的操作不得使用无条件自动重试。

```python
try:
    result = await service.move(...)
    await db.commit()
except Exception:
    await db.rollback()
    raise
```

文件上传、覆盖、移动、复制、回收站和恢复要保持数据库状态、存储对象和缓存状态的一致性。

## 5. 删除和回收站

- 普通删除：设置 `deleted_at`，进入回收站。
- 恢复：清除 `deleted_at`，恢复原有父目录关系。
- 永久删除：同时清理数据库记录和物理存储对象。
- 清空回收站：只允许走确认门。
- 不可逆 Agent 工具：定义 `destructive=True`，并在 handler 中显式接入确认机制。
- 默认文件列表只显示 `deleted_at IS NULL` 的记录。
- 存储统计和配额是否包含回收站文件，必须由统一 Service 查询，页面和上传流程不得各自判断。

## 6. 文件域特殊边界

文件和文件夹业务统一经过以下入口：

```text
FileService
├── 文件/文件夹写语义
├── storage key 和物理对象同步
└── 版本控制

services/files/
├── browser.py    目录和文件查询
├── actions.py    文件操作编排
├── selection.py  批量选择与批量操作
├── upload.py     上传和冲突处理
├── previews.py   缩略图、Office、PDF 和预览
├── trash.py      回收站业务编排
└── response.py   响应投影
```

禁止在 API、Agent 工具和前端页面中重复实现：

- 文件夹归属判断
- 跨项目移动校验
- 父子目录循环检测
- storage key 生成
- 冲突改名
- 回收站路径、恢复和永久删除语义

`get_owned()`、`FileService`、版本控制和确认门是文件域的行为红线。

## 7. Model、Schema 和迁移

ORM Model 不直接作为 API 响应：

```text
SQLAlchemy Model -> Pydantic Schema -> API Response
```

Model 只描述数据库结构、关系和基础约束；领域规则放在 Service；接口字段通过 Pydantic Schema 明确控制。

表结构变更必须使用 Alembic：

1. 新建 migration。
2. 提供可执行的升级路径，必要时提供降级路径。
3. 为查询和唯一性约束补索引或数据库约束。
4. 使用旧数据验证迁移结果。
5. 不在应用启动时偷偷修改表结构。

时间字段统一使用 `app.core.tz.now_utc()`，数据库保存带时区的 UTC 时间，展示和日期归属由用户时区转换。

## 8. ORM 棘轮

### 阶段 0：建立基线

- 统计 API、Agent 工具和 Service 中的直接 ORM 查询。
- 记录现有绕过 `get_owned()`、直接 `db.get()` 和 API 复杂查询。
- 不阻塞当前开发，不进行大范围格式化。

### 阶段 1：禁止新增高风险模式

静态守卫优先拦截新增的：

- 用户资源裸 `db.get()`。
- 绕过 `get_owned()` 的归属查询。
- API 路由中的复杂写操作。
- destructive 操作绕过确认门。
- 文件域绕过 `FileService`。

### 阶段 2：优先收口文件域

顺序建议为：

1. 文件和文件夹归属查询。
2. 移动、复制、删除和回收站。
3. 上传确认、覆盖和冲突处理。
4. 预览和批量操作。

每迁移一个边界就补测试并加入守卫范围。

### 阶段 3：收口其他领域

按项目、思维面板、日历和 Agent 工具逐域迁移。每个领域独立提交，避免把 ORM 规范化和用户行为改动混在一起。

### 阶段 4：清理兼容入口

当调用方全部迁移并完成端到端验收后，再删除旧的直接查询 helper，扩大静态守卫覆盖范围。

## 9. 实施计划

### 9.1 建立基线

先扫描 `backend/app/api/v1/`、`backend/agent/tools/` 和现有 Service，记录以下存量问题：

- 直接使用 `db.get()` 查询用户资源。
- 绕过 `get_owned()` 的归属判断。
- API 路由中的复杂 ORM 查询和写操作。
- 文件域绕过 `FileService` 的调用。
- 未明确事务边界的多表写入。

第一版检查脚本只报告存量问题，不阻塞开发，也不做大范围格式化。

### 9.2 文件域试点

当前文件浏览系统重构分支作为 ORM 棘轮的第一个试点，按以下顺序收口：

1. 文件和文件夹归属查询。
2. 上传确认、覆盖和冲突处理。
3. 文件/文件夹移动、复制和删除。
4. 回收站恢复、永久删除和清空。
5. Agent 文件工具。

每完成一个边界，都要迁移到对应 Service、补行为测试、减少基线数量，并将已迁移路径加入静态守卫。

### 9.3 禁止新增违规

基线稳定后，将 `check_orm_boundaries.py` 接入开发检查，禁止新增以下模式：

- API 新增用户资源裸查询。
- Agent 工具绕过 Service 和 `get_owned()`。
- 文件操作绕过 `FileService`。
- 新增写操作没有明确事务边界。
- destructive 操作没有确认门。

存量问题仍按领域逐步清理，不因守卫上线而一次性阻塞全仓。

### 9.4 按领域迁移

文件域完成后，按以下顺序迁移其他领域：

```text
文件 / 文件夹
    ↓
项目
    ↓
思维面板
    ↓
日历
    ↓
Agent 工具和后台任务
```

每个领域独立提交、独立测试，不和 UI 重构、拖拽动画或用户行为调整混在一起。

当前实施时需要额外遵守以下拆分规则：

- 领域功能开发和 ORM 边界迁移必须使用不同提交，不能因为共用同一个领域文件就合并成一个功能提交。
- Agent 工具文件不是 ORM 边界；工具只负责参数解析、确认门、调用 Service 和结果整形。
- `app/services/<domain>.py` 或对应 Service 目录负责该领域的 ORM 查询、写入、归属校验和多表事务编排。
- `app/core/` 只保留可复用的领域原子逻辑，不作为 API 或 Agent 的平行查询入口。

### 9.5 当前收口顺序

主要领域已经完成 Service 化，但 Agent 工具仍有残余 Model、SQLAlchemy 查询和事务操作。后续按以下顺序收口：

1. 思维画布 Agent 工具：移除 `mind_canvas.py` 中的 Model、SQLAlchemy、`get_owned()` 和数据库操作，全部转调 `services/mind_canvas.py`。
2. 思维、群上下文、历史对话和搜索：清理工具层残余查询与 Model 依赖，保持现有 Service 行为不变。
3. 日历、项目和定时任务：清理引用校验、`refresh()` 以及残余事务操作。
4. 文件和回收站：清点工具层残余 `refresh()`、归属查询和事务协调，确认不绕过 `FileService`。
5. 全部领域完成后，再扩大 Agent ORM 禁止规则，并删除不再使用的兼容 helper。

每个领域都按“实现、回归测试、静态守卫、独立提交、审查”顺序完成，不能把画布功能开发、UI 改动或设计令牌重构混入 ORM 收口提交。

### 9.6 清理旧入口

一个领域满足以下条件后，才删除旧 helper 并扩大守卫范围：

- Service 已覆盖主要读写边界。
- API 不再直接编排业务 ORM。
- 关键测试和 devserver 端到端验收通过。
- 静态守卫已覆盖迁移后的路径。

清理旧入口前还必须满足：

- Agent 工具不再导入该领域的 SQLAlchemy 或 Model。
- Agent 工具不再直接调用 `db.execute()`、`db.get()`、`db.add()`、`db.delete()`、`db.refresh()`、`db.commit()` 或 `db.rollback()`。
- Service 是该领域唯一的 ORM 业务入口，保留的 `app.core` 函数只能是领域原语。

## 10. 测试要求

重点覆盖：

- 用户越权访问和资源枚举防护。
- 软删除、恢复和永久删除。
- 跨项目移动、文件夹循环和父目录失效。
- 上传覆盖、冲突和确认阶段落点校验。
- 事务失败回滚。
- 版本冲突和重复请求。
- 关联加载和批量查询不产生明显 N+1。

完成 ORM 相关功能或准备提交时，按 `AGENTS.md` 的验证策略执行对应的 typecheck、测试和 devserver 验收。

## 11. 当前原则

> Model 管数据结构，Service 管业务规则，API 管 HTTP 边界；权限、事务、目录和删除语义只能有一个入口。

棘轮的目标不是让旧代码立即完美，而是保证每次改动都不会让 ORM 边界变得更松散。

## 12. 实施状态

- 阶段 0 已完成：基线见 `docs/refactor/ORM规范化阶段0基线.md`，扫描器为 `backend/scripts/check_orm_boundaries.py`，默认只报告存量。
- 阶段 1 已完成首个守卫接入：CI 使用 `--diff-base` 只检查新增的高风险 ORM 行，不因历史存量阻塞当前开发。
- 阶段 1 当前拦截范围：API、Agent 新增 `select/update/delete/insert`、数据库写入/裸 `get`，以及 API/Agent 直接导入 `File/Folder`；Service 是规范要求承接 ORM 的边界，不由这条棘轮拦截。
- 现有 `check_ownership.py`、`check_confirm_gate.py` 和 `check_utcnow.py` 继续作为独立守卫；它们不替代后续文件域 Service 迁移。
- 阶段 2 已完成文件域试点：文件夹列表/下载、回收站列表/内容/恢复/永久删除、FileService 写操作，以及 Agent 文件工具的浏览、创建、移动、复制、删除和回收站操作均已收口到 `services/files/` 或 `FileService`，并补充跨用户回归测试。
- 阶段 3 已完成主要领域的 Service 化：项目列表、详情计数、创建落库和项目删除时文件软删已迁移到 `services/projects.py`；日历事件及活动提醒的查询、创建、删除已迁移到 `services/calendar.py`；思维面板的主要画布查询、节点写入、连接写入、引用节点和批量事务已迁移到 `services/mind_canvas.py`；客户、独立定时任务、历史对话、总览、时间流思维查询、群上下文和搜索用量已分别建立对应 Service。这里的“主要领域已迁移”不等于 Agent 工具已经完全没有 ORM，残余清理按 9.5 执行。
- 阶段 4 已完成已迁移 Agent 工具的兼容入口清点，并删除画布 Agent 的 `_canvas_item` 旧包装；画布 API、时间流便签 API 的查询/写入入口已统一复用领域 Service，完整调用方清单见 `docs/refactor/ORM规范化调用方清单.md`。
- 当前仍不能宣称全仓阶段 4 完成：身份、对话清理、账户删除和文件诊断等后台 Service 的显式事务边界需要分别核对。画布功能开发与 ORM 收口必须保持独立提交。

## 13. 实施 TODO

以下 TODO 是当前分支的实际收口清单。每项完成后都要单独提交、运行对应测试，并在本节更新状态。

### P0：画布 Agent 工具边界

- [x] 清点 `backend/agent/tools/mind_canvas.py` 中所有 SQLAlchemy、Model、`get_owned()` 和 `db.*` 使用点。
- [x] 将画布查询、节点写入、关系写入、引用节点和批量操作全部迁移到 `backend/app/services/mind_canvas.py`。
- [x] 保留 Agent 工具中的参数解析、确认门、调用 Service 和结果格式化。
- [x] 确认 `backend/app/core/mind_canvas.py` 只保留领域原子逻辑，不新增查询入口。
- [x] 使用现有画布工具回归覆盖节点、引用、关系和批量回滚行为。
- [x] 验收：`mind_canvas.py` 不再导入 SQLAlchemy 或 `app.models`，不再直接调用 `db.execute/get/add/delete/refresh`；`commit/rollback` 事务协调留到 P3 统一处理。
- [x] 提交边界：已拆分为独立提交，只包含画布 ORM 收口和必要守卫，不包含画布功能或 UI 改动。

### P1：扩展 Agent ORM 守卫

- [x] 将 Agent 工具禁止导入 SQLAlchemy、Model、ownership helper 和直接查询/刷新操作写入静态检查规则。
- [x] 移除本轮 Agent 工具中仅用于类型标注的 Model 引用，使用 Service 返回对象和通用类型标注。
- [x] 保留阶段 1 棘轮，确保新增违规无法进入 API 和 Agent 工具。
- [x] 验收：`check_orm_boundaries.py --agent-strict` 和阶段 1 棘轮均通过；事务提交/回滚规则留到 P3。

### P2：清理其他 Agent 工具残余

- [x] 思维工具：迁移便签、节点和关系残余查询与刷新逻辑。
- [x] 群上下文和历史对话：移除消息/会话 Model 及直接查询。
- [x] 搜索用量：移除直接聚合查询，统一使用搜索 Service。
- [x] 日历、项目、定时任务：移除引用校验、Model 依赖和残余刷新操作。
- [x] 文件和回收站：清点 `refresh()`、归属查询和事务协调，确认不绕过 `FileService`；事务提交留到 P3。
- [x] 每个领域单独提交；本轮画布与其他 Agent 工具清理已拆分为独立提交，事务协调继续留到 P3。

### P3：统一事务边界

- [x] 画布 Agent 任务边界由 `SkillRegistry.dispatch` 统一提交/异常回滚；普通画布 Service 默认使用 `flush()`，保留显式 `commit=True` 作为兼容调用口。
- [x] 画布多表批量操作保留单一事务入口，失败时完整回滚，不发布后续事件或缓存更新。
- [x] 补充 Agent 任务事务成功提交、异常回滚，以及画布版本冲突和批量回滚回归测试。
- [x] 将规则推广到日历提醒、客户、独立定时任务和搜索用量 Service，并核对其 Agent/API 调用方。
- [x] 核对身份、对话清理、账户删除、文件诊断等后台 Service 的显式事务：账户删除、会话清理和 QQ 绑定保留独立事务；文件诊断仅在实际搬迁后提交，均有明确调用方语义，不并入 Agent task 事务。

### P4：清理兼容入口

- [x] 建立 `ORM规范化调用方清单.md`，记录画布和已完成 Agent 收口领域的调用方与事务边界。
- [x] 删除画布 Agent 不再需要的 `_canvas_item` 旧查询包装。
- [x] 保留 Agent 严格 ORM 守卫和新增代码棘轮，并用任务事务回归测试锁定边界。
- [x] 客户 API 已改用客户 Service，避免 API 保留第二套客户查询/写入入口。
- [x] 画布 API 第一批基础画布、节点和关系查询/写入入口已复用 `mind_canvas Service`。
- [x] 迁移画布关系创建、节点置顶和引用节点入口到 `mind_canvas Service`。
- [x] 迁移时间流便签入口；API 的列表、创建、乐观锁更新和软删均复用 `app.services.mind`，由 API 负责提交/冲突响应。
- [x] 完成画布 API、Agent、Service 和关键 devserver 流程验收：devserver 后端全量测试 `953 passed`，时间流专项 `45 passed`。

### P5：最终验收

- [x] 运行完整后端测试和领域专项测试：`953 passed`，时间流与画布专项测试通过。
- [x] 运行 ORM 棘轮、ownership、确认门和时钟守卫。
- [x] 复查 ORM 基线数量，当前扫描为 811 项；相对阶段 0 文档的减少来自本轮 Service/API 收口，没有新增高风险边界。
- [x] 更新阶段状态、变更记录和实施文档。
- [x] P0-P4 的代码、测试、边界守卫和 devserver 验收已完成；阶段 4 收口文档保留后台事务语义与环境同步注意事项。
