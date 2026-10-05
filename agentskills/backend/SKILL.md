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

## 工具权限与提示词边界

- 工具是否可用、可用范围、用户/会话权限、功能开关、权限回落和确认要求，必须由代码决定：注册表过滤、请求权限快照、dispatch 校验和 destructive confirm gate 是唯一事实来源。
- 除 `backend/agent/prompts/policy.md` 外，禁止把运行时工具权限写入模型提示词。`skills.md`、Skill 正文、工具 description、context builder、动态 reminder、RAG 注入和历史包装都不得注入“当前用户拥有/没有某工具”“当前范围是 workspace/system/personal”“权限不足时回落到某范围”等运行时权限事实。
- `policy.md` 只能描述稳定的行为原则，例如“没有真实工具回执不得声称完成”；不得写入某个用户、会话或平台当前的具体权限状态，也不得替代码决定工具范围。
- 工具不可用时，优先在工具注册/调用前阻断并返回结构化结果；不要依赖模型读取提示词自行判断权限，也不要通过 prompt 让模型自行切换、扩大或回落权限。
- 修改工具、Skill 或上下文组装时，必须检查是否新增了权限语义注入；发现重复权限提示词应删除，而不是继续叠加文案。

### 明确例外：系统范围 Shell 环境说明

- 系统范围 Shell 是管理员与用户双侧明确开启的高信任能力，允许由 `agent.security.shell_policy` 的实时策略结果生成本轮环境与范围说明。此例外仅用于现有 Shell 状态说明，不扩展到其他工具、Skill 或 RAG。
- 说明必须区分默认 `sandbox` 与显式 `scope="system"`，不得把允许使用解释为已经切换环境。system 指应用服务所在环境；容器部署不等于宿主机，且不意味着 root 权限。
- 状态说明每轮按实时策略重新计算，并按固定位置追加到 system prompt；不写入冻结 snapshot、Canonical 历史或持久化历史。这样做首先是为了让模型在稳定、明确的位置理解当前执行环境与权限边界，避免把它放在对话尾部改变上下文位置后影响回答内容或工具选择。工作区授权通常不是每轮变化的设置，所以即使每轮重新校验，未变化时生成的 system 前缀仍保持一致；不得把提示词当作授权凭据，执行器逐调用校验、权限撤销、定时任务隔离与确认门保持有效。

## 本地验证

- 本地编辑后通过 Mutagen session `gugu-web` 同步到 devserver。
- Web 使用 `cd backend && make dev-web`；Worker 使用 `make dev-worker`，启动前确保没有重复 Worker。
- 生产环境 `make install` 后，`make start/stop/restart/status` 管理 `gugu-backend`、`gugu-worker`、`gugu-gateway` 三个 systemd 服务。
- 改动网关适配器时只重启对应平台子进程，不重启整个 gateway。
- 后端修改后在 devserver 运行 `PYTHONPATH=. .venv/bin/pytest`。

## LLM Prompt 缓存策略

### Token 用量与压缩触发口径

- 触发上下文压缩、判断模型上下文占用时，**优先使用同一模型、同一请求最近一次 provider 返回的实际输入量**；缓存读取和缓存写入的输入 token 都属于上下文，须按 provider adapter 归一化后的 `fresh input + cache read + cache write` 计算。不得使用累计多轮用量或仅用未命中缓存的 input 代替当前请求的完整输入。
- 已有有效 provider 用量时，禁止再用 `estimate_tokens()`、字符数或 `ContextBudget.from_messages()` 覆盖、相加或重新判定 90% 触发点。模型切换、压缩改变历史边界后，旧用量不可继续代表新请求；每次成功请求都更新其实际用量。
- 本地 token 算法只在**尚无可用 provider 用量**时兜底，例如首次请求前的安全预检、静默反思、进程重启后的持久化接管，以及 provider 溢出后的受控裁剪。估算结果必须标记为 `estimate`，不得记录或展示成 provider 实际用量；一旦取得实际用量，后续判定立即改用实际值。
- 修改任何预算、反思或压缩路径时，增加回归用例覆盖：实际用量与本地估算冲突时实际值优先、缓存命中输入计入阈值、恰好到达 90% 才触发，以及 provider 用量缺失时兜底生效。真实模型 A/B 用 provider 返回的 usage 验证缓存率，不能以估算命中率代替。

**当前策略（2026-08-24，Shell 例外按 v1.4.0）**：system prompt 通常只包含静态内容（persona/skills/policy），动态内容（beh/memory/projects/time）通过带 `[system-reminder]` 的 `role=system` 消息注入 conversation。Shell 环境状态是例外：每轮按实时策略重算，追加在 system prompt 固定位置；环境未变时保持该段与前缀稳定，环境变化时更新该段。它不进入 snapshot 或持久历史，且不代替执行器逐调用授权校验。内部上下文与真实 user message 分离；原生 Anthropic adapter 在 wire 边界把消息级 system reminder 转成允许的 user message，MiniMax/百炼按已验证能力保留 system role。

**为什么把动态内容移到 conversation**：测试验证 behavior block（相处姿态）在不同 call 间变化（Query 430 chars → Companion 705 chars），导致 system prefix 断裂，缓存命中率从 99%+ 降到 0.4%。移到 conversation 后，静态 system 完全不变；再用 role=system 表达其语义，避免模型把动态上下文误当成用户发言。

**实现位置**：`backend/agent/runner.py` 组装段 + `backend/agent/context/builder.py` 的 `build_split()`。

2026-10-04 方案校正：Web、IM、定时任务的本轮 Shell 状态都按 v1.4.0 方案重新计算，并追加到 system prompt 的固定位置。权限提示会影响模型输出和工具选择，不能因缓存布局重构而改变其上下文位置；工作区授权通常不频繁变动，未变时重复计算仍产生相同前缀。状态不写入 snapshot、Canonical 历史或动态尾部，执行器仍逐调用判权。此前“Shell 状态统一使用 `extra_reminder`”的记录作废；普通 `extra_reminder` 的其他用途不受影响。

2026-10-03：反思快照复用 Area 的不可变 ProviderConversation，包含冻结 `request_prefix`，排除 dynamic tail；压缩与反思不得把已投影的 wire 消息转成裸列表再走 canonical renderer。持久历史重建不承诺命中率。缓存探针的资格估算与指纹必须基于完整前缀，不得使用 trace 展示裁剪后的内容。合成 MiniMax-M3 三组 A/B 见 `docs/reports/OPT-Cache-Strategy-2026-10-03.md`。

owner 闲置反思触发的会话压缩，应先在捕获主请求快照的同一进程内执行；worker 仅在短 TTL 协调标记过期后作为进程退出时的接管路径。压缩复用快照前缀必须逐条验证模型身份、持久化行边界和消息序列，不能精确对齐时安全回退到数据库重建路径。完整快照不得写入 Redis/数据库/日志；该路径改善前缀一致性，但不承诺特定 provider 的缓存命中率。

反思前的 90% 判定遵循上述统一口径：同进程主请求快照携带的最近一轮 provider `context_input` 优先；没有有效实际用量时才估算。压缩前缀允许纯文本字符串与单个 text block 等价，工具块和其他结构必须严格对齐；对齐成功后发送原始主请求前缀。2026-09-26 的合成 MiniMax-M3 A/B 见 `docs/reports/OPT-Cache-Strategy-2026-09-26.md`。

**修改缓存策略前必须**：
1. 用 `backend/scripts/diagnostics/test_cache_strategy_compare.py` 做对比测试
2. 记录到 `docs/reports/OPT-Cache-Strategy-*.md`
3. 更新 devlog 和本节
4. 在 LoopScope 验证 cache_ratio 提升

## PR 前本地 CI + 手动触发 GitHub CI

提交 PR 前必须在本地完成以下检查，确保不引入回归：

```bash
cd backend
PYTHONPATH=. .venv/bin/pytest -q                    # 单元测试
python scripts/checks/check_ownership.py             # 归属校验
python scripts/checks/check_confirm_gate.py          # 确认门校验
python -m compileall -q app agent                    # 语法检查
```

本地通过后再提交 PR。**GitHub CI 不随 PR 自动运行**（省 Actions usage）：PR 决定合并前，
人工对 `runtime-integration.yml` 和 `docker-release.yml` 各手动触发一次（Actions 页
Run workflow 选 PR 分支，或 `gh workflow run <name> --ref <分支>`），全绿后才合并，
详见 `docs/ops/release.md` §1。
