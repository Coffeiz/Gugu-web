# PRD-SHELL-4：用户沙箱授权与定时任务工作区绑定

> 状态：Phase 1、Phase 2、Phase 3、Phase 4（代码部分）已完成；devserver/生产手工验收待执行
> 创建：2026-09-05
> 最近更新：2026-09-06
> 关联模块：`backend/app/services/filesystem_authorization.py`、`backend/app/security/events.py`、`backend/app/core/opsmetrics.py`、`backend/agent/commands/workspace.py`、`backend/agent/tools/shell.py`、`backend/agent/sandbox/`、`backend/app/api/v1/agent.py`、`backend/app/api/v1/scheduled_tasks.py`、`frontend/src/components/common/filesystem/`、`frontend/src/components/common/gugu-chat/`、`frontend/src/views/Schedules/`
> 背景参考：`docs/prds/README.md`、`PRD-SHELL-1-工作区Shell沙盒`、`PRD-SCHEDULE-1-定时任务完整AgentLoop执行`

## 0. 实际状态

| 能力/结果 | 状态 | 说明 |
|---|---|---|
| `/workspace` 默认工作目录 | ✅ 已完成（Phase 2） | Shell 和定时任务均使用 workspace 根目录；未绑定时使用用户独立 Shell 持久目录 |
| `/workspace` 读写 | ✅ 已完成 | 当前沙盒默认允许 workspace 读写 |
| `/personal`、`/project` 只读挂载 | ✅ 已完成 | 默认用于读取用户个人文件和项目文件 |
| Session 完整沙箱授权 | ✅ 已完成（Phase 1） | `filesystem_authorization_grants` 记录当前 Session；`/workspace god` 必须经过统一交互确认 |
| 定时任务 workspace 绑定 | ✅ 已完成（Phase 2） | ScheduledTask 绑定用户 workspace，绑定后覆盖整个 workspace，并在触发前校验归属、启用状态和可用根目录 |
| 定时任务完整沙箱读写授权 | ✅ 已完成（Phase 2） | 任务主体独立授权、确认、撤销和停用失效已接入 |
| 工具统一权限策略 | ✅ 已完成（Phase 3） | Shell、PTY、Docker sandbox、scheduler、文件工具、回收站与脚本入口均复用统一 policy |
| 授权审计、指标与灰度开关 | ✅ 已完成（Phase 4 代码） | 默认关闭；授权生命周期写入脱敏 SecurityEvent，Redis 仅聚合固定枚举指标 |
| 会话/任务权限摘要与公共弹窗 | ✅ 已完成（Phase 4 代码） | GuguChat 会话标题栏和定时任务表单共用独立公共授权组件 |

Phase 1 的 `/workspace god` 和 askuser 授权复用现有 GuguChat 交互卡；Phase 4 的 Shell 权限按钮与定时任务表单都使用独立公共组件 `FilesystemAuthorizationDialog.vue`。GuguChat 只承载入口和状态，不拥有授权事实或确认逻辑。

## 1. 背景与目标

### 1.1 背景

当前用户沙箱包含：

```text
/workspace  当前工作区，可读写
/personal   用户个人文件，默认只读
/project    用户项目文件，默认只读
```

定时任务现在主要保存自然语言指令，触发时创建独立 Agent 执行流程，没有稳定保存 workspace。因此“在某个项目工作区定时运行 py 并让 Agent 处理结果”无法被可靠表达。

同时，用户没有显性的方式授予当前 Session 或某个定时任务完整用户沙箱的读写权限。

### 1.2 目标

- 提供显性的完整用户沙箱授权入口；
- 支持 `/workspace god`、`/workspace revoke`、`/workspace status`；
- 支持 Agent 通过 askuser 发起同一授权请求；
- 支持定时任务绑定 workspace；绑定后任务从 workspace 根目录执行并覆盖整个 workspace；
- 支持定时任务开启“完整用户沙箱读写权限”；
- 默认保持 workspace 读写、personal/project 只读；
- 所有相关执行入口使用同一个 filesystem policy；
- 授权只覆盖当前用户自己的沙箱目录，并支持撤销、失效和审计。

### 1.3 明确不做

- 不提供 personal/project 目录级授权；
- 不支持 `/workspace god` 后附加 `all` 或任意路径参数；
- 不授权宿主机、其他用户目录、Docker socket 或 root；
- 不允许模型仅凭文本或工具参数自行提升权限；
- 不因完整权限自动开启网络、system executor 或 destructive 操作；
- 不让定时任务继承创建者 Session 的临时授权；
- 不把通用 Shell 入口无条件变成任意脚本执行器。

## 2. 功能需求

### FR-SHELL-001：默认沙箱权限

系统默认提供：

| 目录 | 权限 |
|---|---|
| `/workspace` | 读写 |
| `/personal` | 只读 |
| `/project` | 只读 |

权限检查失败时必须拒绝执行，不能回退到宿主机 system executor。

### FR-SHELL-002：完整用户沙箱权限

完整权限只有一个范围：

```text
/workspace  读写
/personal   读写
/project    读写
```

完整权限只改变当前 Session 或定时任务的挂载和文件操作策略，不改变网络、资源限制、工具注册或危险操作确认门。

### FR-SHELL-003：Session 显性授权

Shell、文件工具或聊天区域展示当前权限摘要，并提供“完整沙箱权限”按钮。

未授权时显示 workspace 可读写、personal/project 只读；已授权时显示完整用户沙箱读写。点击后必须展示范围和确认按钮，用户确认前不能改变后端权限。

授权确认能力由独立公共组件提供，不把授权状态或确认逻辑写死在 `GuguChat.vue` 中。不同入口只负责选择合适的展示载体：

- Session 通过 `/workspace god` 或 Agent 的 `askuser` 请求时，在 GuguChat 消息流中显示授权交互卡片；
- Shell 权限按钮使用同一授权组件打开独立弹窗；
- 定时任务表单中的完整权限按钮使用同一授权组件完成任务级授权。

### FR-SHELL-004：Slash 命令

支持：

```text
/workspace god
/workspace revoke
/workspace status
```

- `/workspace god` 申请当前 Session 完整读写；
- `/workspace revoke` 撤销当前 Session 完整权限；
- `/workspace status` 返回权限、授权主体、有效期和 workspace 状态。

`/workspace god` 是快捷命令名，界面和审计日志统一使用“完整用户沙箱权限”，不能暗示 root 或宿主机权限。

### FR-SHELL-005：统一确认门

命令、权限按钮和 askuser 使用同一确认流程：

```text
允许当前会话读写整个用户沙箱？
包含 /workspace、/personal、/project
不包含宿主机目录
[取消] [确认授权]
```

确认凭证必须绑定当前 user、Session 和一次授权请求。前端不能通过布尔字段直接创建授权。

### FR-SHELL-006：askuser 授权

Agent 因默认只读策略无法完成用户明确要求的写操作时，可以调用 askuser。

- askuser 只能发起请求，不能自行授权；
- 用户拒绝后停止该写操作；
- 用户确认后原工具调用重新经过后端策略校验；
- 授权只对当前 Session 生效；
- 自定义回复或选项序号不能绕过确认。

### FR-SHELL-007：定时任务绑定 workspace

创建或编辑定时任务时支持：

```text
工作区：[选择 workspace]
```

- workspace 必须属于当前用户；
- 绑定 workspace 后，任务 Shell、文件工具和脚本入口统一从 workspace 根目录执行，并覆盖 workspace 全部内容；
- workspace 重命名不影响绑定；
- workspace 删除或失去归属时任务进入“工作区不可用”并跳过执行；
- 不保存宿主机绝对路径。

### FR-SHELL-008：定时任务完整权限按钮

定时任务表单增加默认关闭的“允许读写完整用户沙箱”按钮。开启时必须单独确认。

授权后任务每次触发都可以读写用户沙箱；撤销后恢复 workspace 读写、personal/project 只读。不提供目录勾选、`all` 参数或 personal/project 单独开关。

### FR-SHELL-009：授权主体隔离

- Session grant 只对当前 Session 有效；
- ScheduledTask grant 持久化在任务主体上；
- 定时任务不继承创建者 Session grant；
- 一个主体不能使用另一个主体的 grant；
- Session 结束、任务停用或授权撤销后，后续执行必须重新校验。

### FR-SHELL-010：定时脚本边界

后续脚本任务只能运行用户明确指定、且位于其沙箱内的脚本。执行时使用任务的 workspace 根目录和 filesystem policy，并继续受到运行时、超时、资源、网络、输出和进程清理限制。

## 3. 技术方案

### 3.1 统一 filesystem policy

提供唯一权限解析入口（当前实现保留项目现有 service 参数顺序）：

```text
resolve_filesystem_policy(db, user_id, subject_type, subject_id)
```

返回：

```text
subject_type
subject_id
grant_id
workspace_read_write
personal_read_only
project_read_only
workspace_id
cwd
```

Phase 1 解析会校验 Session 用户归属、grant 撤销/过期并输出挂载权限；Phase 2 同一入口也校验定时任务主体、任务级 grant 和 workspace。策略查询异常时 Shell fail closed。

### 3.2 授权记录

新增：

```text
filesystem_authorization_grants
- id
- user_id
- subject_type: session | scheduled_task
- subject_id
- scope: user_sandbox
- permission: read_write
- granted_by: user | askuser
- granted_at
- expires_at: nullable
- revoked_at: nullable
- created_at
- updated_at
```

当前只支持一个 scope 和一个完整权限级别，避免形成多套目录授权系统。撤销不物理删除记录。

Session grant 在 Session 结束或主动撤销时失效；ScheduledTask grant 在任务停用或主动撤销时失效。

### 3.3 ScheduledTask 字段

增加：

```text
workspace_id: nullable
filesystem_authorization_grant_id: nullable
```

`workspace_id` 显式为 null 表示解除绑定；历史 `cwd` 数据在迁移中丢弃，绑定任务统一从 workspace 根目录执行。权限撤销使用独立显式操作。

### 3.4 执行器挂载

默认：

```text
/workspace  read-write
/personal   read-only
/project    read-only
```

完整授权：

```text
/workspace  read-write
/personal   read-write
/project    read-write
```

Shell、文件工具和脚本执行器都从同一个 policy 生成挂载、workspace 根目录和路径检查参数。完整授权不改变 Docker 非 root、只读 rootfs、网络 profile、资源限制、destructive 确认和 ownership 校验。

### 3.5 定时任务执行

```text
触发任务
  -> 读取任务 workspace、grant
  -> 校验 user/workspace/grant
  -> 创建带 workspace 默认 cwd 的 Agent Session
  -> 解析 filesystem policy
  -> 执行 Agent 或明确授权的脚本
  -> 记录结构化结果并投递
```

任务不依赖创建时的聊天 Session，也不能从当前活跃聊天 Session 推断权限。

### 3.6 相关文件与目录树

以下文件树只描述本 PRD 的实施范围，优先复用现有模块：

```text
Gugu-web/
├─ backend/
│  ├─ agent/
│  │  ├─ commands/
│  │  │  ├─ workspace.py              【修改】Slash 命令与授权交互
│  │  │  └─ help.py                   【修改】命令帮助与菜单
│  │  ├─ im/
│  │  │  └─ loop.py                   【修改】授权交互编排
│  │  ├─ interactions/qq.py            【修改】QQ 确认适配
│  │  ├─ sandbox/
│  │  │  ├─ protocol.py                【修改】执行策略契约
│  │  │  ├─ client.py                  【修改】传递主体和 policy
│  │  │  ├─ docker.py                  【修改】按 policy 挂载
│  │  │  └─ local_executor.py          【修改】复用策略
│  │  ├─ tools/
│  │  │  ├─ meta.py                   【修改】askuser 授权请求
│  │  │  ├─ shell.py                   【修改】权限校验
│  │  │  ├─ filesystem_policy.py       【新增】Agent 主体策略适配
│  │  │  ├─ files.py                   【修改】文件写操作策略检查
│  │  │  ├─ trash.py                   【修改】回收站写操作策略检查
│  │  │  ├─ scheduled_tasks.py         【修改】任务 Schema
│  │  │  └─ base.py                    【修改】统一 dispatch 边界
│  │  └─ skills/scheduled-tasks.md     【修改】任务绑定和授权规则
│  ├─ app/
│  │  ├─ models/__init__.py            【修改】授权与任务字段
│  │  ├─ services/
│  │  │  └─ filesystem_authorization.py 【新增】授权事实源和 policy
│  │  ├─ scheduled_tasks.py             【修改】触发加载 workspace/grant
│  │  └─ api/v1/
│  │     ├─ scheduled_tasks.py          【修改】任务绑定和授权 API
│  │     └─ terminals.py                【修改】PTY 授权挂载
│  ├─ alembic/versions/
│  │  └─ <timestamp>_add_filesystem_authorization.py 【新增】数据库迁移
│  └─ tests/
│     ├─ test_commands.py                 【修改】Session 授权命令与 askuser
│     ├─ test_scheduled_task_workspace.py 【新增】workspace/任务授权
│     ├─ test_shell_workspaces.py          【修改】默认/完整挂载
│     ├─ test_docker_runtime.py            【修改】沙盒边界
│     └─ test_phase3_filesystem_policy.py  【新增】文件策略与脚本边界
├─ frontend/src/
│  ├─ components/common/filesystem/
│  │  └─ FilesystemAuthorizationDialog.vue 【新增】授权弹窗
│  ├─ composables/
│  │  └─ useFilesystemAuthorization.ts    【新增】授权状态与流程
│  ├─ views/Schedules/
│  │  ├─ index.vue                         【修改】权限和绑定状态
│  │  └─ components/ScheduleFormModal.vue  【修改】workspace/授权入口
│  ├─ services/api.ts                       【修改】授权和任务 API
│  └─ i18n/sections/
│     ├─ common.ts                          【修改】通用授权文案
│     └─ schedules.ts                       【修改】定时任务文案
   └─ docs/
   ├─ agent/05-TOOLS-AND-SKILLS.md          【修改】能力/授权边界
   ├─ devlog/2026-09-05-用户沙箱授权Phase2.md 【新增】验证记录
   └─ prds/PRD-SHELL-4-用户沙箱授权与定时任务工作区绑定.md 【修改】需求事实源
```

职责边界：

- 授权 service 是 grant 和 policy 的唯一事实源；已接入 Shell、PTY、Docker sandbox、scheduler、文件工具和脚本入口；
- `agent/tools/filesystem_policy.py` 只适配当前 dispatch 主体，不保存第二份权限事实；`files.py`、`trash.py` 和 `web_download` 共用它；
- sandbox 只把 policy 转换为执行参数，不自行授予权限；
- scheduler 负责任务生命周期，不复制路径权限判断；
- `FilesystemAuthorizationDialog.vue` 是独立的公共授权组件，负责授权范围展示和确认交互，不绑定具体业务页面；
- GuguChat、Shell 面板和定时任务表单只负责承载适配，不复制授权状态、确认流程或 grant 创建逻辑；
- `/workspace god`/askuser 的 Session 授权在 GuguChat 交互流中呈现，Shell 权限按钮使用独立公共弹窗，定时任务授权在任务表单上下文中呈现；
- 前端只展示和发起确认，不能直接决定授权；
- `backend/config.override.json`、`backend/.env`、用户存储目录、运行时密钥和 Docker daemon 配置【不改】；
- `run_script` 是显式脚本入口，不接受任意 Shell command；脚本必须是沙箱挂载内的相对路径，拒绝软链接、硬链接、路径穿越和解释器 eval；
- 生成的 API 类型必须通过生成流程更新，不手工维护第二份 Schema。

## 4. 验证与上线

### 4.1 自动化验证

后端至少覆盖授权、任务绑定、Shell、Docker 和定时任务执行测试；前端覆盖授权弹窗、Slash 交互、任务表单和状态同步。测试必须验证行为和权限边界，不能用源码字符串计数代替行为测试。

### 4.2 手工验收

使用合成用户和合成目录验证：

- 默认权限下 workspace 可写，personal/project 不可写；
- `/workspace god` 必须经过确认按钮；
- 取消不改变权限，确认后三个目录可写；
- `/workspace revoke` 后权限恢复默认；
- askuser 的拒绝和确认路径正确；
- 定时任务使用保存的 workspace 根目录，不使用当前聊天 Session；
- 任务完整权限必须单独确认；
- workspace 删除或失去归属后任务不改写其他目录；
- 完整权限不会开启网络、system executor 或绕过 destructive 确认；
- 越界、软链接逃逸、跨用户和宿主机路径均被拒绝。

### 4.3 灰度、观测与回滚

完整权限入口通过后端 feature flag 灰度启用，默认关闭时保持现有只读边界。Admin「Shell 沙盒」页面提供该 feature flag 的总开关；关闭时前端不展示授权入口，后端同时忽略已有 grant 并拒绝新授权。代码运行环境另有独立总开关，关闭后保留基础 Shell，但拒绝 Python、Node 等运行时。审计只记录 user/session/task/grant ID、来源、结果和时间，不记录聊天正文、脚本正文、文件内容、敏感文件名或凭据。

迁移必须支持安全回滚或等价向前修复。旧任务字段为空时保持旧行为；权限策略异常时拒绝执行，不回退 system executor。回滚应用代码时保留授权记录和任务字段。

## 5. 风险与待确认问题

### 5.1 风险

| 风险 | 影响 | 对策 |
|---|---|---|
| 完整权限被误用 | 修改或删除用户文件 | 显性确认；destructive 操作继续确认 |
| grant 主体混淆 | 跨 Session/任务/用户越权 | grant 绑定 user、subject_type、subject_id |
| workspace 与权限混淆 | 访问范围错误 | workspace 覆盖整个 workspace，完整沙箱授权单独控制 personal/project |
| 只改 Shell | 文件工具行为分叉 | 所有入口统一调用 policy |
| workspace 删除 | 任务写入错误目录 | 触发前校验，失效后跳过并通知 |
| 前端伪造授权 | 未授权写入 | 仅后端确认凭证可创建 grant |
| 任务运行时无人确认 | 任务卡住 | 创建/编辑时完成任务级授权 |
| god 名称误解 | 被理解为系统权限 | 界面和日志统一显示“完整用户沙箱权限” |

### 5.2 待确认问题

产品决策已确定：不做目录级授权；使用 `/workspace god`；Session 和定时任务分别授权；定时任务 workspace 绑定与完整权限按钮分开；personal/project 默认只读。

当前没有阻塞实现的产品问题。

## 6. 唯一实施 TODO

### Phase 1：Session 授权与执行边界（已完成）

- [x] `SHELL4-001` 新增 Session 级用户沙箱授权记录和数据库迁移。
- [x] `SHELL4-002` 新增统一 `resolve_filesystem_policy`，校验用户与 grant 状态。
- [x] `SHELL4-003` 接入 Shell、PTY、sandboxd 和 Docker 挂载权限。
- [x] `SHELL4-004` 实现 `/workspace god`、`/workspace revoke`、`/workspace status`。
- [x] `SHELL4-005` 复用统一交互确认门，并支持 askuser 发起固定授权请求。
- [x] `SHELL4-006` 补充授权、撤销、主体隔离和挂载参数回归测试；后续 Phase 2 全量回归为 `2011 passed`。

### Phase 2：定时任务绑定（已完成）

- [x] `SHELL4-007` 增加 ScheduledTask 的 workspace 和任务授权字段；绑定 workspace 后统一覆盖整个 workspace。
- [x] `SHELL4-008` 接入任务创建/编辑 API、前端表单、任务级确认/撤销 API、独立授权组件及授权 composable。
- [x] `SHELL4-009` 让 scheduler 按任务主体解析 workspace/grant 并从 workspace 根目录执行；工作区失效时安全跳过，任务停用时撤销任务级完整授权。

- [x] `SHELL4-015` 移除定时任务独立 cwd 字段、表单和工具参数；迁移历史列后，所有绑定任务统一从 workspace 根目录执行。

Phase 2 验证：后端定时任务工作区/授权、scheduler、Shell policy、命令与投递回归共 `110 passed, 2 warnings`；前端授权 composable 单测、类型检查和生产构建通过。

### Phase 3：文件工具与脚本边界（已完成）

- [x] `SHELL4-010` 让文件工具、回收站和 `web_download` 写操作复用统一 filesystem policy；未授权的 personal/project 仅可读，workspace 子树可写，完整授权解除该位置限制。
- [x] `SHELL4-011` 增加 `run_script` 明确入口，仅允许 python3/node/bash 与沙箱内相对脚本路径，拒绝软链接、硬链接、路径穿越和 Shell 控制字符。

Phase 3 验证：Phase 3 专项、下载写入边界、Shell/Docker、工具 Schema 共 `145 passed, 2 warnings`；受影响的 Shell、PTY、定时任务、文件、回收站回归共 `146 passed, 2 warnings`；Python compileall、`git diff --check` 通过。Schema audit 仍报告已有 note/web 工具描述长度提示，未由本阶段引入。

### Phase 4：观测与灰度

- [x] `SHELL4-012` 增加授权审计事件、指标和灰度开关；开关默认关闭，关闭时后端强制维持只读边界。
- [x] `SHELL4-013` 完成会话/定时任务权限摘要、独立公共授权弹窗与多语言文案；会话和任务共用可注入授权 composable。
- [ ] `SHELL4-014` 完成 devserver/生产迁移、手工验收和回滚演练。

Phase 4 代码验证：后端全量 pytest `2024 passed, 3 warnings`，其中 Phase 3/4 授权、命令、任务和策略回归 `48 passed, 2 warnings`，能力目录回归 `8 passed, 2 warnings`；前端全量 Vitest `446 passed`，授权 composable/UI 回归 `29 passed`，`vue-tsc --noEmit` 通过，Python compileall 和 `git diff --check` 通过。剩余 `SHELL4-014` 只涉及真实部署环境的开关配置、手工验收和回滚演练，本地未修改运行配置。
