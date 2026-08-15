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

### 9.5 清理旧入口

一个领域满足以下条件后，才删除旧 helper 并扩大守卫范围：

- Service 已覆盖主要读写边界。
- API 不再直接编排业务 ORM。
- 关键测试和 devserver 端到端验收通过。
- 静态守卫已覆盖迁移后的路径。

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
- 阶段 3 项目域已完成首个边界：项目列表、详情计数、创建落库和项目删除时文件软删已迁移到 `services/projects.py`；日历事件及活动提醒的查询、创建、删除已迁移到 `services/calendar.py`；思维面板 Agent 的画布创建、节点放置/布局、便签编辑/删除和连接写入已迁移到 `services/mind_canvas.py`，画布查询、搜索和批量事务仍待继续收口。
