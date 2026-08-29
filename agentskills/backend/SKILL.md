---
name: backend
description: 后端开发约定。Python 规范、FastAPI 层级、Pydantic 命名、安全日志脱敏、外部请求安全。修改后端代码前必须阅读。
---

# 后端开发约定

## 代码风格

- Python 导入按标准库/第三方/本地模块分组；`from` 导入在前，普通 `import` 在后，并保持可读的字母顺序。
- 复杂逻辑保留或补充注释和类型注解；参数化泛型使用 `typing` 模块。
- 已确定类型的变量直接访问属性，少用不必要的 `getattr`、`setattr` 和 `or` 兜底。

## API 与数据模型

- 业务时间统一使用 `app.core.tz.now_utc()`；存储 UTC，展示时按用户时区转换。
- 前后端 API 请求体遵循模型实际声明：`CamelModel` 使用驼峰字段，普通 `BaseModel` 使用下划线字段。
- API、业务服务、Agent、数据库模型和任务按现有目录分层，不跨层复制逻辑。
- API 请求/响应沿用现有 Pydantic 命名规则、归属校验和确认门。

## 安全

- 用户输入、异常和上游响应不得进入可见日志；错误使用 `app.core.redaction.redact()` 脱敏。
- 原始诊断使用受限诊断日志 `diag_log()`/`diag_log_raw()`。
- 跨用户数据查询使用 `app/core/ownership.py` 的 `get_owned()`。
- 外部请求设置超时、重试边界和 URL 安全校验，不盲目重试非幂等操作。

## 本地验证

- 本地编辑后通过 Mutagen session `gugu-web` 同步到 devserver。
- Web 使用 `cd backend && make dev-web`；Worker 使用 `make dev-worker`，启动前确保没有重复 Worker。
- 生产环境 `make install` 后，`make start/stop/restart/status` 管理 `gugu-backend`、`gugu-worker`、`gugu-supervisor` 三个 systemd 服务。
- 改动网关适配器时只重启对应平台子进程，不重启整个 supervisor。
- 后端修改后在 devserver 运行 `PYTHONPATH=. .venv/bin/pytest`。

## LLM Prompt 缓存策略

**当前策略（2026-08-19 新架构）**：system prompt 只包含静态内容（persona/skills/policy），动态内容（beh/memory/projects/time）通过 `[system-reminder]` 注入 `messages[0]`。system prefix 跨 call 完全一致，MiniMax 前缀匹配缓存稳定命中 90%+。

**为什么把动态内容移到 messages**：测试验证 behavior block（相处姿态）在不同 call 间变化（Query 430 chars → Companion 705 chars），导致 system prefix 断裂，缓存命中率从 99%+ 降到 0.4%。移到 messages[0] 后，system 完全不变，缓存恢复到 91.6%。

**实现位置**：`backend/agent/runner.py` 组装段 + `backend/agent/context/builder.py` 的 `build_split()`。

**修改缓存策略前必须**：
1. 用 `backend/scripts/diagnostics/test_cache_strategy_compare.py` 做对比测试
2. 记录到 `docs/reports/OPT-Cache-Strategy-*.md`
3. 更新 devlog 和本节
4. 在 LoopScope 验证 cache_ratio 提升

## PR 前本地 CI（GitHub Actions 已禁用）

提交 PR 前必须在本地完成以下检查，确保不引入回归：

```bash
cd backend
PYTHONPATH=. .venv/bin/pytest -q                    # 单元测试
python scripts/check_ownership.py                    # 归属校验
python scripts/check_confirm_gate.py                 # 确认门校验
python -m compileall -q app agent                    # 语法检查
```

全部通过后再提交 PR。不需要等待 GitHub CI——本地通过即可。
