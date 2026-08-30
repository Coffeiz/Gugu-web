# Gugu-web 开发约定

修改代码前，根据工作领域阅读对应 skill：

| Skill | 路径 | 适用场景 |
|-------|------|---------|
| frontend | `agentskills/frontend/SKILL.md` | Vue/TS 前端开发 |
| backend | `agentskills/backend/SKILL.md` | Python/FastAPI 后端 |
| canvas-mind | `agentskills/canvas-mind/SKILL.md` | 画布/便签/Mind |
| design | `agentskills/design/SKILL.md` | UI 视觉与交互规范 |
| testing | `agentskills/testing/SKILL.md` | 写/改测试 |
| devserver | `agentskills/devserver/SKILL.md` | 部署/同步/运维 |
| local | `agentskills/local/SKILL.md` | 使用本地开发机、代理和 devserver 连接信息 |
| loopscope | `agentskills/loopscope/SKILL.md` | LoopScope trace、Collector、上下文观测与脱敏边界 |

完整设计文档见 `agentskills/design/references/`。历史开发文档见 `docs/development/`。

## Admin 前端拆分约定

- 修改 `frontend/src/views/Admin/**/index.vue` 时，不得只继续堆叠模板、样式或业务逻辑；如果触及已有大入口文件，应顺手把可独立的模块、弹窗、表单区块拆到 `components/`，把状态与异步流程拆到 `composables/`，把请求和纯逻辑拆到对应 service/utils。
- 新增 Admin 功能优先创建独立组件或 composable；`index.vue` 只保留页面布局、模块组合和流程调度。
- 拆分时保持现有 design token、权限边界、数据流和测试覆盖，不为了拆分引入无必要的全局状态或重复 API。

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
- 排查真实故障时看到的真实用户名/昵称，写代码、测试、commit message 或文档时一律换成虚构占位名（如"小北"/"moon_小北"），不得把真实用户名写进 Git 历史。

## 用户运行配置保护

- `backend/config.override.json`、`backend/.env` 及 devserver 上的同名运行配置属于用户数据，默认只读。
- Agent、测试脚本、诊断脚本、Mutagen 同步和部署流程不得擅自创建、清空、重写或用本地副本覆盖这些文件；测试必须使用临时目录或显式 mock 配置路径。
- 用户明确要求修改运行配置时，只修改指定字段，保留其他字段；写入必须使用原子替换并先校验 JSON，禁止把解析失败当成空对象继续写回。
- 任何配置迁移、恢复或重建操作都必须先生成带时间戳的备份，并在完成后校验数据库、LLM 预设和其他配置段仍然存在；不得在日志中输出密码、Token 或 API Key。

## 语言与提交

- 注释、日志、用户文案、文档和 commit message 使用简体中文。
- Changelog 只记录简短用户可感知变化；详细排查过程按 `docs/devlog/README.md` 约定写入 `docs/devlog/` 下的独立记录。

## Git 提交完整性

- **禁止用 `--force` / `--force-with-lease` 覆盖远端分支历史**。远端历史是追查依据，覆盖后难以回溯。
- **禁止未经用户确认直接执行 `git fetch`**。需要检查远端状态时，先说明是否可能涉及历史重写，并询问用户是否允许 force/force-with-lease；未获允许时只采用保留历史的方案。
- GitHub、Git fetch、Git push 和 `gh` 操作使用 `agentskills/local/SKILL.md` 中的当前会话代理配置。
- 本地与远端分叉时，获得确认后再 `git fetch` + `git rev-list --left-right --count` 分析差异。
- 若本地内容是最新的但历史不同步：优先把本地新增改动 **cherry-pick / 重新应用** 到远端分支上，保留远端既有提交历史，而不是重置 + 强制推送。
- 任何历史重写操作前，先创建备份分支（`git branch backup-<desc> <commit>`）。
