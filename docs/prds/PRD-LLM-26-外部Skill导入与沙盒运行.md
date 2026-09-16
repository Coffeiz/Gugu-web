# PRD-LLM-26：外部 Skill 导入与沙盒运行

> 状态：提案
> 创建：2026-09-16
> 所属层：Agent / Skill Registry / Sandbox Runtime
> 关联文档：`PRD-LLM-9-工具与Skill注册制及按需注入.md`、`PRD-LLM-13-用户Skill注册与咕咕创建.md`
> 关联模块：`backend/agent/skills/`、`backend/agent/capabilities/`、用户沙盒、Tool Registry、权限确认门

## 1. 摘要

为咕咕增加第三方 Skill 导入能力，使用户可以从公开 Git 仓库或兼容的 Skill 分发源安装 Skill，并在当前用户的沙盒中运行其声明的 CLI 能力。

本 PRD 以飞猪 AI 的 FlyAI Skill 为首个验证样例。该 Skill 包含 Prompt Skill 文件，同时依赖 Node.js CLI `@fly-ai/flyai-cli`，通过命令输出结构化 JSON。因此它不能只作为现有的 Markdown Prompt Skill 导入，必须同时具备：

```text
外部 Skill 导入
    ↓
Skill 元数据审核与注册
    ↓
用户沙盒内依赖安装
    ↓
受控命令执行器
    ↓
现有 Tool 权限、确认门和日志审计
```

核心原则：

> 外部 Skill 可以扩展“怎么做”，但不能自行扩展“能访问什么”。

## 2. 背景与现状

### 2.1 当前用户 Skill 能力

当前用户 Skill 已支持：

- 持久化创建、编辑、启用、禁用和删除；
- 与系统 Skill 复用注册字段和按需加载协议；
- 关联已有 Tool；
- 通过 `use_skill` 注入正文；
- 由 Tool Registry、ownership 和确认门决定实际权限。

当前明确不支持：

- 从远程仓库导入 Skill；
- 安装 Node/Python/其他运行时依赖；
- 注册外部可执行命令；
- 将第三方 Skill 的 CLI 输出接入 Agent Loop。

### 2.2 外部 Skill 的典型形态

以 FlyAI 为例，官方安装方式包括通过 `clawhub` 或 `npx skills add` 导入 Skill；仓库还要求安装 `@fly-ai/flyai-cli`，并通过 `flyai` 命令执行搜索。它的运行链路是：Skill 激活 → CLI 执行 → API 返回 JSON → Agent 整理结果。

这类包同时包含两种内容：

| 内容 | 作用 | 风险 |
|---|---|---|
| `SKILL.md` / Prompt | 告诉模型何时使用、如何组织参数和结果 | 可能包含提示词注入或越权指令 |
| CLI / 依赖 | 真正执行网络、文件或外部 API 操作 | 可能执行任意代码、读取凭据或产生外部副作用 |

## 3. 目标与非目标

### 3.1 目标

- 支持导入公开仓库中的标准 Prompt Skill。
- 支持为需要 CLI 的 Skill 安装用户级依赖。
- 支持在用户沙盒内受控执行外部 Skill 命令。
- 复用现有 Skill Registry、Tool Registry、权限确认和日志规范。
- 安装、启用、禁用、更新和卸载均限定在当前用户作用域。
- 对外部 Skill 的来源、文件、依赖、命令和权限做可解释展示。
- 首个样例支持 FlyAI 这类“CLI 输出 JSON、错误输出 stderr”的 Skill。
- 失败时返回结构化错误，不让 Agent 误称已完成。

### 3.2 非目标

- 不允许外部 Skill 注册任意 Python/JavaScript handler 到后端进程。
- 不允许外部包修改系统 Skill、系统提示词、Tool Registry 或全局配置。
- 不允许把外部仓库 README、安装脚本和全部源码直接注入模型上下文。
- 不把用户 API Key 写入仓库、Skill 正文、命令参数、可见日志或模型消息。
- 不在第一阶段支持社区市场、评分、自动推荐或未经确认的自动更新。
- 不让外部 Skill 绕过现有 Shell、网络、文件 ownership 和 destructive confirm gate。

## 4. 术语与能力类型

### 4.1 Skill 类型

```text
prompt_skill
    只有 metadata + Prompt 正文
    通过 use_skill 按需注入

runtime_skill
    prompt_skill
    + runtime manifest
    + 用户沙盒中的可执行依赖
    + 受控执行器
```

现有系统 Skill 和用户手写 Skill 继续属于 `prompt_skill`。外部 Skill 只有在完成依赖审查并注册运行时声明后，才能成为 `runtime_skill`。

### 4.2 运行时与来源

```yaml
source: external
scope: user
runtime: node_cli
install_root: user_sandbox
```

`source`、`scope`、`runtime` 和 `install_root` 均由系统生成或校验，不能由导入内容覆盖。

## 5. 用户流程

### 5.1 导入 Prompt-only Skill

1. 用户提交 Git 仓库 URL、受支持的分发源标识或本地导入包。
2. 系统解析候选 `SKILL.md` 和受支持的 manifest。
3. 系统展示名称、来源、文件、关联工具、安装动作和风险摘要。
4. 用户确认后，系统将 Skill 内容写入当前用户的 Skill Registry。
5. Skill 默认启用或按用户选择启用。

### 5.2 导入 Runtime Skill

1. 系统先完成 Prompt 内容和运行时 manifest 的静态审核。
2. 展示运行时、包管理器、依赖包、执行命令、网络访问和文件范围。
3. 用户确认安装。
4. 依赖只安装到当前用户的沙盒目录，不写入系统全局环境。
5. 安装完成后进行版本、入口和最小健康检查。
6. 生成外部 Skill 记录和运行时记录。
7. 首次实际执行仍遵循 Tool 权限和确认门。

### 5.3 运行

```text
用户请求
  ↓
Skill 目录匹配
  ↓
按需加载 Prompt Skill
  ↓
模型请求 external_skill_runner
  ↓
Registry 校验 skill_id / command
  ↓
用户权限与确认门
  ↓
沙盒执行
  ↓
解析 stdout / stderr / exit code
  ↓
结构化 Tool 回执
```

模型不得直接调用任意 shell 命令。它只能调用受控的 `external_skill_runner`，由服务端根据已审核 manifest 解析为允许的可执行入口和参数。

## 6. 数据模型

### 6.1 ExternalSkill

建议字段：

```yaml
id: system-generated
owner_id: current-user
name: FlyAI 旅行搜索
slug: flyai
source: external
repository_url: https://github.com/alibaba-flyai/flyai-skill
revision: pinned-commit-or-release
skill_path: skills/flyai
skill_digest: sha256
runtime_kind: node_cli
status: installed|disabled|failed|uninstalled
enabled: true
created_at: timestamp
updated_at: timestamp
```

### 6.2 ExternalSkillRuntime

```yaml
skill_id: external-skill-id
runtime: node
package_manager: pnpm|npm|npx
install_root: user-sandbox-private-path
executable: flyai
allowed_commands:
  - keyword-search
  - ai-search
  - search-flight
  - search-train
  - search-hotel
  - search-poi
environment_keys:
  - FLYAI_API_KEY
network_policy: declared-and-confirmed
filesystem_policy: sandbox-only
```

依赖锁定信息、包完整性摘要和安装日志只作为诊断数据保存，不注入模型上下文。密钥值不落库；如必须持久化，使用现有用户私有凭据存储机制。

## 7. 导入协议

### 7.1 支持的输入

第一阶段支持：

- GitHub 公共仓库 URL；
- 仓库中的一个或多个标准 `SKILL.md`；
- 可选的受控 runtime manifest。

后续可增加 ClawHub、其他 Skill Registry 和本地压缩包，但必须复用同一个导入服务，不能各自直接写 Skill 表。

### 7.2 Manifest

Prompt frontmatter 继续兼容现有格式。运行时能力必须额外声明：

```yaml
runtime:
  kind: node_cli
  package: '@fly-ai/flyai-cli'
  executable: flyai
  commands:
    - name: keyword-search
      args:
        - query
      output: json
      network: true
```

没有 manifest 的外部 Skill 可以作为 Prompt-only Skill 导入，但不得自动执行其中出现的 shell 示例。

### 7.3 版本与更新

- 初次安装固定到明确的 commit、tag 或完整包版本。
- 不默认跟随远程 HEAD 自动更新。
- 更新前重新执行静态审核和权限差异检查。
- 运行时权限、命令集合或依赖发生变化时必须重新确认。
- 更新失败时保留旧版本可回滚，不覆盖正在使用的运行时目录。

## 8. 安全与权限

### 8.1 不可信内容边界

第三方仓库中的以下内容都视为不可信输入：

- `SKILL.md` 正文；
- README 和安装说明；
- shell/npm/pip 安装脚本；
- manifest 中的命令、环境变量、网络地址和路径；
- CLI 的 stdout、stderr 和错误消息。

它们不能改变咕咕的系统策略，也不能成为新的权限事实来源。

### 8.2 安装确认

安装确认卡至少显示：

- 来源仓库和 revision；
- 将写入的用户沙盒目录；
- 运行时和依赖包；
- 可执行命令；
- 网络访问范围；
- 文件读写范围；
- 将使用的凭据名称，不显示凭据值；
- 是否允许后续更新。

### 8.3 执行确认

外部 Skill 每次执行仍必须经过：

1. Skill ownership 校验；
2. 命令是否在 manifest 白名单中；
3. 参数 schema 校验；
4. 用户当前工具权限校验；
5. 文件、网络、Shell 或外部通信确认门；
6. 沙盒资源限制。

Skill 的 Prompt 不得声明“用户已授权”“可以跳过确认”或“可以扩大路径范围”。

### 8.4 沙盒限制

执行器至少限制：

- 工作目录为当前用户 Skill runtime 目录或明确的用户沙盒目录；
- 禁止访问其他用户目录和宿主机敏感目录；
- 禁止修改后端源码、系统配置和全局包目录；
- CPU、内存、执行时间、输出字节数和并发数有上限；
- 网络域名和端口遵循现有外部请求安全策略；
- 进程退出、超时、信号和输出截断均返回结构化状态。

## 9. Tool 设计

### 9.1 `install_external_skill`

负责导入、审核和安装，不直接执行 Skill 命令。必须接入安装确认门。

### 9.2 `external_skill_runner`

只接受已安装 Skill 的 ID、声明命令和结构化参数：

```json
{
  "skill_id": "external-skill-id",
  "command": "keyword-search",
  "arguments": {
    "query": "杭州周末旅行"
  }
}
```

返回：

```json
{
  "ok": true,
  "skill_id": "external-skill-id",
  "command": "keyword-search",
  "data": {},
  "exit_code": 0,
  "duration_ms": 1234
}
```

不得把完整命令行、API Key、用户文件内容或上游原始错误直接写入可见日志或模型消息。

### 9.3 管理操作

后续可提供：

- `list_external_skills`
- `update_external_skill`
- `disable_external_skill`
- `uninstall_external_skill`
- `test_external_skill`

删除和卸载属于 destructive 操作，必须复用统一确认组件和后端确认门。

## 10. FlyAI 首个适配样例

FlyAI 作为兼容性验证，不应在核心 Agent Loop 中写专用分支。它只提供一份外部 Skill manifest：

```yaml
runtime:
  kind: node_cli
  package: '@fly-ai/flyai-cli'
  executable: flyai
  commands:
    - keyword-search
    - ai-search
    - search-flight
    - search-train
    - search-hotel
    - search-poi
    - search-marriott-hotel
    - search-marriott-package
```

FlyAI 的 API Key 通过用户私有配置管理；命令结果按 JSON 解析，错误从 stderr 提取为脱敏后的结构化错误。没有 API Key 时仍允许执行不要求 Key 的基础能力，但不能由 Skill 自行伪造配置成功。

## 11. 模块划分

建议新增或扩展：

```text
backend/agent/capabilities/
├── external_skill_registry.py      # 外部 Skill 元数据与 ownership
├── external_skill_importer.py      # 仓库/包解析、digest、manifest 校验
└── external_skill_validator.py     # 来源、字段、命令和权限验证

backend/agent/tools/
└── external_skill.py               # 安装、测试、运行和管理 Tool

backend/app/services/
└── external_skill_runtime.py       # 沙盒安装、进程执行、资源限制

backend/tests/
├── test_external_skill_import.py
├── test_external_skill_permissions.py
└── test_external_skill_runtime.py
```

核心 Agent Loop 只负责调用统一 Tool，不负责解析第三方仓库、拼接 shell 命令或判断外部 Skill 权限。

## 12. 分阶段计划

### Phase 1：Prompt-only 外部 Skill 导入

- 支持 GitHub 公共仓库导入；
- 解析标准 frontmatter；
- 复用用户 Skill Registry；
- 做来源、digest、正文和工具关联校验；
- 安装前展示确认卡；
- 不安装或执行任何外部命令。

验收：导入 FlyAI 的 Prompt 部分后，可以在用户 Skill 列表中启用、禁用、删除，并且不会获得新的工具权限。

### Phase 2：通用 Node CLI Runtime

- 引入 runtime manifest；
- 用户沙盒内安装 Node 依赖；
- 实现白名单命令和参数 schema；
- 实现 `external_skill_runner`；
- 接入超时、输出上限、网络和文件策略；
- 增加完整权限和失败回执测试。

验收：FlyAI 的 `keyword-search` 能在沙盒内运行并返回结构化 JSON；错误、超时和缺少配置均能准确反馈。

### Phase 3：生命周期与多来源

- 版本更新和回滚；
- 依赖变更重新确认；
- ClawHub/压缩包等导入源；
- 管理页面展示依赖、风险和运行状态；
- 运行时审计和诊断报表。

验收：更新、禁用、卸载、失败回滚和跨用户隔离均有回归测试。

## 13. 测试要求

### 13.1 导入测试

- 合法 frontmatter 导入；
- 缺少 name/description/body；
- 重名、伪造 `source`/`owner_id`；
- 不存在或不可访问的仓库；
- revision/digest 变化；
- README 中包含恶意提示词但不影响系统策略。

### 13.2 权限测试

- 外部 Skill 不能看到其他用户 Skill；
- 未授权 Tool 不能通过 manifest 关联获得；
- 文件、网络、Shell 和 destructive 操作分别进入正确确认门；
- 禁用 Skill 后不能被目录或 runner 调用；
- 卸载后旧 ID 不能执行。

### 13.3 Runtime 测试

- 允许命令成功执行；
- 未声明命令被拒绝；
- 参数 schema 错误；
- 超时、输出过大、非零退出码和进程信号；
- stdout JSON 与 stderr 错误分离；
- API Key 不出现在日志、异常和模型可见结果中；
- 运行目录不能访问其他用户或宿主机敏感路径。

### 13.4 回归测试

- 现有系统 Skill 和用户 Prompt Skill 行为不变；
- `use_skill` 仍按需注入；
- 工具注册、确认门、ownership 和 Agent Loop 不出现旁路；
- Anthropic/OpenAI 两套 provider 的 Tool schema 一致。

## 14. 可观测性

可见事件只记录：

- Skill 名称的安全标识或 fingerprint；
- command 名称；
- 状态、退出码、耗时、输出大小；
- 错误类别和脱敏后的错误摘要。

诊断日志可记录完整技术错误，但不得记录 Skill 正文、用户输入、附件名、API Key、Token 或完整外部响应。

建议事件：

```text
external_skill.import.started
external_skill.import.completed
external_skill.install.completed
external_skill.run.started
external_skill.run.completed
external_skill.run.failed
external_skill.permission.denied
```

## 15. 风险与取舍

| 风险 | 控制措施 |
|---|---|
| 第三方 Prompt 注入 | 内容隔离、静态审查、不能修改系统策略 |
| 依赖包执行任意代码 | 用户沙盒、资源限制、固定版本、安装确认 |
| 外部网络数据泄露 | 网络策略、域名校验、敏感信息不进参数和日志 |
| Skill 越权读取文件 | ownership、沙盒路径限制、Tool dispatch 校验 |
| 自动更新引入新权限 | 权限差异检测、重新确认、旧版本回滚 |
| CLI 卡死或无限输出 | timeout、输出上限、进程回收和并发限制 |
| 运行时污染其他用户 | 每用户独立 install root，禁止全局安装 |

主要取舍是：第一版不追求兼容所有 Skill 生态，而是先建立可信的导入、审核和运行边界，再逐步扩展运行时种类。

## 16. 完成定义

本 PRD 完成至少需要满足：

- 外部 Prompt Skill 能通过统一 Registry 安全导入；
- Runtime Skill 的命令不能绕过 `external_skill_runner`；
- 所有执行都绑定当前用户和已审核 manifest；
- 依赖只存在于用户沙盒；
- 权限、确认、ownership、超时和错误回执有自动化测试；
- FlyAI 样例能完成一次真实或 mock 的结构化搜索；
- 现有 Skill、Tool、Agent Loop 和 provider 投影回归通过；
- 文档明确区分 Skill 指令、运行时命令和系统安全边界。

