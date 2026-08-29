# ORM 规范化阶段 0 基线

> 扫描日期：2026-08-15
> 扫描脚本：`backend/scripts/check_orm_boundaries.py`

## 结论

阶段 0 已完成。基线扫描默认只报告、不阻塞开发，也没有对存量代码做格式化或行为改写。阶段 1 接入守卫时，应把本报告作为已知存量清单，守卫只拦截新增违规。

## 扫描范围

| 区域 | 路径 |
| --- | --- |
| API | `backend/app/api/v1/` |
| Agent | `backend/agent/tools/` |
| Service | `backend/app/services/` |

扫描识别 SQLAlchemy 构造器（`select/update/delete/insert`）、`db/session/self.db` 上的 ORM 方法，以及 api/Agent 直接导入文件域 Model 的位置。它是静态候选清单，不替代人工判断：管理员接口、无归属表、存储修复任务和查询 Service 可能是合法例外。

## 当前数量

| 区域 | ORM 构造器 | ORM 方法 | 直接导入 `File/Folder` |
| --- | ---: | ---: | ---: |
| API | 101 | 279 | 13 |
| Agent | 0 | 32 | 0 |
| Service | 128 | 258 | 不作为文件域绕过候选 |

另外，按主键裸 `db.get()`/`self.db.get()` 共 16 处：API 14 处、Agent 1 处、Service 1 处。API 结果包含管理员和认证等已在现有 ownership 守卫中列出的合法豁免候选；具体行号由脚本实时输出，避免报告与代码漂移。

文件域直接从 api/Agent 导入 Model 的候选文件包括：

- API：`config.py`、`files.py`、`folders.py`、`mind.py`、`projects.py`、`search.py`、`trash.py`、`users_admin.py`、`admin_analytics.py`
- Agent：`files.py`、`overview.py`、`projects.py`、`trash.py`

## 现有机制

- `app.core.ownership.get_owned()` 已作为单条归属查询入口。
- `check_ownership.py` 已覆盖 Agent 工具和用户态 API 的裸 `db.get()` 文本守卫。
- `check_confirm_gate.py` 已覆盖 destructive Agent 工具确认门。
- `check_utcnow.py` 已覆盖统一 UTC 时钟出口。
- 文件域已有 `app.services.files` 与 `app.services.storage.file_service`，但 API、Agent 和旧存储 helper 仍存在存量直接查询，需要按阶段迁移。

## 阶段 1 输入

阶段 1 不应直接把当前 811 个 ORM 候选变成失败项。建议先将以下新增模式纳入守卫：

1. 用户态 API、Agent 工具新增裸 `db.get()`，要求使用 `get_owned()` 或行尾写明结构化豁免理由。
2. 文件域 API、Agent 新增 `File/Folder` 业务写入，要求经过 `FileService` 或对应 `services/files/*` 入口。
3. 新增多表写入必须能在 Service 或 API 边界找到明确的 `commit/rollback` 事务责任。

每个已迁移边界都要补行为测试、减少基线数量，并在对应阶段提交中记录减少的文件和规则范围。

## 运行方式

```bash
cd backend
PYTHONPATH=. .venv/bin/python scripts/check_orm_boundaries.py
PYTHONPATH=. .venv/bin/python scripts/check_orm_boundaries.py --json
```
