# PRD-ARCH-6 Phase 0：恢复基线清单

## 1. 清单状态

- 状态：已完成。
- 恢复原点：`8bad5dcd7883d1d7a63d7362482108ce54d6ad02`。
- 恢复分支：`codex/restore-fastapi-python`。
- 盘点方式：只读检查 Git 提交图、FastAPI 路由、Python worker、TS RAG、Makefile 和 Compose；未执行回退、强推、远端 fetch 或运行配置覆盖。
- 运行配置、数据库、用户文件、凭据和现有 RAG 索引不纳入 Git 恢复范围。

## 2. 原点确认

```text
commit: 8bad5dcd7883d1d7a63d7362482108ce54d6ad02
parent: 881d69798ce9cd98d8a97b9a0f72fe2ae334b588
date:   2026-08-26 23:07:31 +0800
subject: 修正 RAG worker 的 pnpm 构建依赖
```

该提交位于 TypeScript API/Agent 迁移提交之前，同时已经包含 RAG worker 的 pnpm 构建依赖修复，因此作为恢复原点可以保留 pnpm 与 TS RAG 基础。

## 3. FastAPI API 基线

`backend/app/main.py` 在原点已注册以下 API 领域：

```text
auth / admin_auth / users_admin
projects / files / folders / trash
events / notifications / notifications_admin
clients / workspaces
agent / agent_admin / agent_perception
mind / search / preferences
terminals / scheduled_tasks / tasks
feedback / track / audit_log / system_logs
qq_connect / feishu_connect / wechat_connect / user_bots
sandbox_admin / services_admin / ops_admin / folder_doctor_admin
```

恢复目标是让这些路由全部继续由 FastAPI 提供。后续补丁中如果出现 TS API 同名路由，只能作为 parity 参考，不得改变 FastAPI owner。

## 4. Python Agent 与后台基线

保留以下生产边界：

- `backend/agent/`：Agent loop、provider、context、RAG adapter、工具、Skill、交互、权限和平台 gateway。
- `backend/worker.py`：IM 入队消费、QQ/微信/飞书处理、定时任务、后台反思、连接池和 shutdown drain。
- `backend/app/`：FastAPI 请求、认证、业务事务、文件/画布/笔记/终端 API 和事件发布。
- `backend/agent/loopscope_trace/`：Run/round/tool/RAG trace 的 best-effort 写入。

TS Agent runtime、TS command host、TS context bridge 和 TS tool registry 不属于原点后的恢复目标。

## 5. TypeScript RAG 基线

保留白名单：

```text
backend/agent/rag/ts_sidecar.py
backend/agent/rag/index_cache.py
backend/agent/rag/persistent_store.py
backend/agent/rag/adapters/**
backend/ts/workers/rag/**
backend/tests/test_rag_*.py
backend/scripts/*rag*
.github/workflows/rag-sidecar-release.yml
```

生产链路：

```text
Python RAG adapter
    -> Python ts_sidecar client
    -> 常驻 TypeScript RAG worker
    -> Jieba / BM25 / score / filter / dedupe / budget
    -> RecallResult + diagnostics
    -> Python 权限复核、正文回填、上下文注入
```

TS RAG 不拥有 API、Agent session、工具权限、Skill、业务数据库写入或实时事件入口。

## 6. Makefile、Compose 与服务基线

保留目标类型：

```text
make install / update / makeupdate
make start / stop / restart / status / logs / foreground
make migrate / storage-migrate / backup
make test / deps / deps-dev
make rag-ts-build
make sandbox-acl-plan / sandbox-acl-apply / sandbox-acl-prepare
```

恢复后的默认进程图：

```text
FastAPI
Python Agent/IM worker
TypeScript RAG worker
PostgreSQL / Redis / sandboxd（按配置启用）
```

应排除的服务和目标：

```text
gugu-ts-api.service
gugu-ts-agent-runtime.service
gugu-ts-agent-worker.service
TS API/Agent 专属 build、start、owner switch 和生产 Compose service
```

Makefile 允许继续使用 Node/pnpm 构建固定 RAG 制品，但不得因 `make install` 或 `make start` 隐式启动 TS API/TS Agent。

## 7. 实时事件基线

原点已经存在 Python `backend/app/core/events.py` 的 Redis pub/sub → SSE 事件能力，以及 Python 业务写入侧的事件发布。恢复阶段保留：

- canonical event envelope、资源类型、操作类型、版本和幂等字段；
- Redis event bus 和 Python publisher；
- Vue stores 的实时刷新、游标、重连和去重语义；
- LoopScope 对 Agent 运行事件的记录。

后续迁移补丁不得保留 TS API SSE 作为生产入口。Phase 4 只需恢复 FastAPI SSE/WS owner，并校验前端 API base、事件游标和重连行为。

## 8. Phase 0 验收

- [x] 已从安全原点创建独立恢复分支。
- [x] 已确认原点位于 TS API/Agent 迁移前，并包含 pnpm/RAG 构建基础。
- [x] 已完成 95 个后续提交的保留、排除和拆分应用分类。
- [x] 已盘点 FastAPI 路由、Python Agent/Worker、TS RAG 和实时事件边界。
- [x] 已定义 Makefile/Compose 保留和排除规则。
- [x] 未修改远端历史，未执行 force push，未覆盖运行配置、数据库或用户数据。

下一步进入 Phase 1：恢复 FastAPI API owner，不先应用 TS API/Agent 迁移提交。
