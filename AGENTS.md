# Gugu-web 开发基础约定

详细规则见 [docs/development/](docs/development/)：

- 前端：[frontend.md](docs/development/frontend.md)
- 后端：[backend.md](docs/development/backend.md)
- 前台设计：[design.md](docs/development/design.md)
- Admin 设计：[design-admin.md](docs/development/design-admin.md)
- 测试：[test.md](docs/development/test.md)

修改前端、后端或视觉交互前，先阅读对应文档；写/改测试前先看测试约定。本文件只保留跨项目的基础规则。

## 调试原则

- 不用 fallback/兜底掩盖真实错误，先定位根因。
- 连续 2–3 轮静态推理仍无法定位时，改用运行时日志、性能 trace 或录屏验证。
- 探针只用于定位问题，验证后必须清理，不要带入提交。

## 安全规范

- 聊天正文、附件名和用户输入不得写入可见日志；使用 `agent/logsafe.py` 的 `fingerprint()`。
- 可见错误必须经过 `app.core.redaction.redact()`；原始异常只能写入 `diag_log()`/`diag_log_raw()`。
- 跨用户数据查询使用 `app/core/ownership.py` 的 `get_owned()`。
- destructive 工具必须声明 `destructive=True` 并接入 `confirm` 确认门。
- 外部请求复用 URL 安全校验，禁止自动跟随未经校验的重定向。
- 不得把 token、密钥或凭据写入 URL、日志、前端响应或 Git。

## 开发与验证流程

- 本地编辑后通过 Mutagen session `gugu-web` 同步到 devserver，不在本地直接启动完整服务。
- 前端 UI 修改优先在 devserver 浏览器验证；类型或接口修改运行 typecheck。
- 完成功能或提交前运行完整前端 typecheck；行为/纯逻辑修改运行测试。
- 后端变更在 devserver 运行 `PYTHONPATH=. .venv/bin/pytest`。
- pytest 测试基座、E2E 该不该接 CI 的判断标准、本地跑 E2E 的方式，见 [test.md](docs/development/test.md)。
- 修改网关适配器时只重启对应平台子进程，不重启整个 supervisor。

## 语言与提交

- 注释、日志、用户文案、文档和 commit message 使用简体中文。
- Changelog 只记录简短用户可感知变化；详细排查过程写入 `docs/devlog.md`。

## Git 提交完整性

- **禁止用 `--force` / `--force-with-lease` 覆盖远端分支历史**。远端历史是追查依据，覆盖后难以回溯。
- 本地与远端分叉时，先 `git fetch` + `git rev-list --left-right --count` 分析差异，再决定处理方式。
- 若本地内容是最新的但历史不同步：优先把本地新增改动 **cherry-pick / 重新应用** 到远端分支上，保留远端既有提交历史，而不是重置 + 强制推送。
- 任何历史重写操作前，先创建备份分支（`git branch backup-<desc> <commit>`）。
