> 迁移期 Python 兼容包（冻结）：供 Web/NAS 和 Golden 测试使用。目标 Node Core 在顶层 `gugu-core/`，此处不承接新的业务功能。

# gugu-core

咕咕跨宿主共享领域与数据运行时，采用独立 Python 包和 `src/gugu_core/` 布局。当前包含项目与联系人用例、所有者上下文、SQLite/PostgreSQL 连接工厂和跨域事务；Agent 等领域按后续切片迁入。

## 安装与边界

从仓库根目录安装：

```bash
python -m pip install -e ./compat/core-python
# PostgreSQL 宿主增加可选驱动
python -m pip install -e './compat/core-python[postgres]'
```

Core 不导入 `backend/app`、FastAPI、Redis 或任何桌面/SaaS 宿主。领域与 Application 不导入 SQL 库。Web/NAS 暂留 `backend/`，前端暂留 `frontend/`；后续桌面宿主为 `gugu-desktop`，云服务宿主为 `gugu-saas`，SaaS 可独立放在私有仓库，不参与 Core 安装或构建。

宿主负责登录、租户/订阅、策略和身份解析，并把经过校验的 UUID 传给 `DataContext`。不能直接把请求体提供的 owner_id 当作可信身份。Core 不创建隐式管理员；本地运行时只保存一个稳定所有者 UUID，没有登录账号。

## 统一数据事务

```python
from pathlib import Path
from gugu_core.data.runtime import LocalRuntime

runtime = await LocalRuntime.initialize(Path('core-data/local.db'))
try:
    async with runtime.unit_of_work() as data:
        project = await data.projects.create({'name': '准备计划'})
        client = await data.clients.create({'name': '小北'})
finally:
    await runtime.close()
```

多个数据域共享一次提交；抛出异常或取消会一起回滚。结果是普通数据快照。项目修改使用版本比较；联系人沿用既有资料更新语义，不新增虚假的版本保证。已存在的库用 `LocalRuntime.open()`，不重复初始化。首批 `runtime.transaction()` 项目用例入口保留兼容。

PostgreSQL 使用相同的数据门面和业务规则：

```python
from gugu_core.application.context import DataContext
from gugu_core.data.config import DataRuntimeConfig
from gugu_core.data.unit_of_work import SqlDataRuntime

# database_url 来自宿主安全配置，不记录到日志。
runtime = SqlDataRuntime.connect(DataRuntimeConfig.postgres(database_url))
try:
    async with runtime.transaction(DataContext(owner_uuid)) as data:
        projects = await data.projects.list()
finally:
    await runtime.close()
```

连接工厂不自动建表或迁移。Web 使用 `DataModels` 注入带用户外键的映射，`bind_services(session, context)` 借用现有请求事务，Core 不抢占提交权；撤销、事件和文件操作仍由宿主编排。运行时拥有自己创建的连接池，关闭后拒绝继续使用。

## 本地库与升级

本地 schema 当前为版本 `2`：项目、联系人和运行时元数据。初始化只接受新文件；打开检查标记、版本、业务表与身份，遇到不兼容库明确拒绝。SQLite 启用 WAL、连接级外键和有限忙等待。

版本 `1` 库必须由宿主停止相关运行时后显式升级：

```bash
python -m gugu_core --database ./core-data/local.db migrate
```

迁移先持有写锁，生成带 UTC 时间戳的一致性备份，再事务性创建联系人表并推进版本。迁移失败回滚 DDL 与版本，保留旧项目、身份和备份。只支持已知版本的增量升级，不修复未知表结构，也不修改用户运行配置。数据库文件和备份属于数据后端内部存储，不是用户 FS/工作区能力。

## 验证

回归测试暂按仓库约定放在 `backend/tests/core/`，Web 桥接放在 `backend/tests/projects/`。独立安装 Core 后，可从 backend 运行：

```bash
python -m pytest --confcutdir=tests/core tests/core -q
```

PostgreSQL 契约只在显式提供 `GUGU_CORE_TEST_POSTGRES_URL` 时连接隔离测试库，并使用随机临时 schema。不要指向用户部署数据库。构建独立 wheel：

```bash
python -m build --wheel gugu-core
```
