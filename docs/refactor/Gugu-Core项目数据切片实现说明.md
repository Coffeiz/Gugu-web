# Core 项目数据切片：首批实现

> 实现分支基于 `dev` 的 `11757f15`，保留原仓库既有历史。

本次依据 [Core 与桌面端职责划分方案](Gugu-Core与桌面端职责划分方案.md) 抽取项目列表、创建与改名的数据链路。交付的是可独立安装的 Python Core 包和实验性命令行宿主，供后续桌面接入验证；尚未完成 P1 桌面安装制品与原生沙箱验收，也不把完整 P2 标为完成。

## 1. 已落地边界

| 位置 | 职责 |
| --- | --- |
| `backend/gugu_core/domain/` | 项目字段与阶段规则、预设色板、脱离 ORM 的项目快照 |
| `backend/gugu_core/application/projects.py` | 项目数据端口、列表/创建/更新用例，以及 Web 与本地共用的更新编排 |
| `backend/gugu_core/data/` | 共享项目列、跨库 UTC 类型、SQL repository、SQLite 运行时生命周期 |
| `backend/gugu_core/__main__.py` | 实验性本地命令行宿主；显式传入数据库路径 |
| `backend/app/core/projects.py` | Web 兼容入口，转发到 Core 用例与规则 |
| `backend/app/services/projects.py` | Web 列表复用 Core 查询，继续编排文件、回收站等跨领域行为 |
| `backend/app/models/` | Web 的用户外键、项目关联关系与其他领域模型 |

首批包保留在现有后端目录中，避免同时改变服务装配与仓库布局。`pyproject.toml` 仅打包 `gugu_core`，独立安装只要求 Python 3.12+、SQLAlchemy 异步支持和 aiosqlite，不加载 Web 配置、账号体系、Redis 或 Agent。领域和 Application 不导入 SQL 库，所有 Core 模块不反向导入 `app` / `agent`；回归测试保护此依赖方向。

Web 的 API 路径、响应结构、幂等、撤销、事件发布、项目文件目录操作保持原有编排。现有 Web 单条读取仍通过 `get_owned()`；共享 SQL 查询与更新继续带有所有者条件，版本比较和墓碑检查位于同一条 UPDATE。共享 repository 不自行提交 Web 事务。

项目业务列由 Core 维护，保留 `contact_name` 等既有数据库列名。Web 映射继续声明 `users.id` 外键和关系；本地映射不创建用户表。本次不执行 Web 数据库迁移。

## 2. 本地身份、事务与生命周期

- 本地初始化生成并持久化一个随机所有者 UUID，用于数据归属，不创建账号、密码或管理员权限。重开数据库沿用该身份。
- `LocalRuntime.initialize(path)` 只接受新文件；已有文件明确失败，不覆盖。
- `LocalRuntime.open(path)` 只打开已有文件，检查 Core 标记、schema 版本、项目列和本地身份；不兼容时拒绝，不执行自动迁移或补建表。
- SQLite 使用 WAL、连接级外键检查和有限的忙等待；修改项目按版本比较，避免并发写入覆盖。
- `runtime.transaction()` 成功提交，异常回滚；返回值是普通数据快照，不把 ORM 延迟加载或 Session 暴露给调用方。
- 本地库当前 schema 版本为 `1`。将来升级需由宿主完成备份、显式迁移与恢复流程；不能直接把 Web 数据库文件当作本地库打开。

数据库驱动属于 Core 数据后端；数据库操作不经过执行沙箱。本切片没有 Shell、通用文件工具、网络服务或云同步入口，也不会读取或改写用户的 `.env`、`config.override.json`。

## 3. 试用方式

在隔离的 Python 虚拟环境中，从仓库根目录安装：

```bash
python -m pip install ./backend
python -m gugu_core --database ./core-data/projects.db init
python -m gugu_core --database ./core-data/projects.db create "准备计划"
python -m gugu_core --database ./core-data/projects.db list
python -m gugu_core --database ./core-data/projects.db rename 1 "开始实施" --version 1
```

命令输出 UTF-8 JSON；修改成功后版本递增。重复使用旧版本会以非零状态退出，调用方应重新读取后决定如何处理。已有数据库应直接执行列表等命令，不再执行 `init`。

构建独立制品：

```bash
python -m build --wheel backend
```

Web 仍按原有方式启动。两个显式复制后端模块的生产 Dockerfile 已加入 `gugu_core`；开发镜像复制整个后端目录，无需另改装配。回滚时同步回滚 Web 兼容入口及 Core 包；本地实验数据库不参与 Web 回滚。

## 4. 验证与阶段状态

新增测试分别保护文件库重开持久化、事务回滚、并发改名冲突、所有者隔离、阶段与日期增量校验、未知库/未来版本/损坏表拒绝打开、进程异常退出恢复，以及 CLI 行为。Web 桥接测试验证共享映射读写同一行、客户列别名、用户外键与提交边界。PostgreSQL 契约测试使用显式测试连接，在随机临时 schema 中建表并清理。

独立 Core 测试可在没有 Web 依赖的环境运行，`--confcutdir` 用来验证 Core 无需加载 Web 测试基座；完整后端回归仍加载原有基座：

```bash
cd backend
python -m pytest --confcutdir=tests/core tests/core -q
PYTHONPATH=. python -m pytest -q
python scripts/checks/check_ownership.py
python scripts/checks/check_confirm_gate.py
python -m compileall -q app agent gugu_core
```

PostgreSQL 用例默认不连接服务；显式设置 `GUGU_CORE_TEST_POSTGRES_URL` 指向隔离测试库后执行 `tests/core/test_postgres_projects.py`。不得指向用户部署数据库。

本轮实际验证结果在 PR 的“验证”中记录。尚未完成的闸门：macOS 实机、桌面 Python/Cython 打包、IPC、桌面壳、原生 Sandbox Executor、Agent 切片与长期迁移机制。Windows 原生 SQLite 验证与 Python wheel 构建不能替代这些验收。

后续仍按原方案推进：先补齐 P1 桌面可行性，再将此数据切片接入桌面宿主；P3 抽取 Agent；P4 接入端侧 FS 与原生执行沙箱。MXC 继续作为 Sandbox Executor 候选独立验证。Linux/NAS 多用户能力和首版 SaaS 的 FS 兼容路径保留；SaaS 纯数据库与云同步目标留在 P6 收敛。
