# PRD-AGENT-8：可组合上下文与子 Agent 运行时

> 状态：🟡 部分完成。公共片段组装器已接入 Greeting、主会话、定时任务和现有反思链路。Searcher 已接入 Web 和 Desktop 持久化委派。稳定子会话已接入跨父 Run 续聊。普通调度切换和旧路径下线待实施。
> 创建：2026-11-17
> 最近更新：2026-11-22
> 关联模块：`packages/core/src/agent/context/`、`apps/web-host/src/modules/agent/`、`apps/desktop/src/main/agent/`
> 背景参考：[Gugu 2.0 架构说明](../refactor/Gugu-2.0-架构说明.md)、[PRD-AGENT-7 目标任务生命周期与续跑](PRD-AGENT-7-目标任务生命周期与续跑.md)

## 0. 实际状态

| 能力/结果 | 状态 | 说明 |
| --- | --- | --- |
| Web 和 Desktop 会话快照、历史压缩 | ✅ 已完成 | 当前 Node 链路已共用快照与历史基线规则 |
| 公共上下文组装与两端 Greeting | ✅ 已完成 | 已验证选源、分区、预算、问候模板、Web 缓存分支和 Desktop 本地读取 |
| 两端主会话兼容接入 | ✅ 已完成 | 现有 builder 输出经公共分区，旧快照、TTL、基线和 Provider 请求等价通过定向回归 |
| Web 与 Desktop 定时任务 | ✅ 已完成 | 共用任务场景。授权、租约、投递和失败重试通过定向回归 |
| Owner 反思和会话反思 | 🟡 部分完成 | 场景接入和定向回归已完成，Linux 文件写入及 Web 持久区间集成验收有缺口 |
| 稳定子会话 | 🟡 部分完成 | 两端已共用委派执行入口，新执行取消固定轮次及预设计时器。稳定短 ID 已支持跨父 Run 查看和向活动子 Agent 投递。已完成会话可跨父 Run 续聊，执行记录已迁移到统一表，Web 共用普通调度扫描，Desktop 新派单与恢复共用队列扫描。普通 Run 执行和交付接管待完成 |
| 自定义子 Agent | 🔲 待评估 | 已定义配置与委派契约，尚未接入 |

## 1. 背景与目标

Web 和 Desktop 已共用 Core 的 Canonical Context、Runner 与 Provider 投影。Web 主会话使用 Core builder，Desktop 在宿主内提供快照构建和请求格式化。Greeting 共用提示词格式化，但各端准备输入和调用模型的路径不同。反思另有按证据批次提取和复用会话 Provider 投影的路径。

新增场景时，应能声明要用的提示词、Profile、记忆等模块，然后通过同一入口组装并执行。模块负责声明产出的位置，场景负责选择模块、模型及执行方式。用户可以保存自己的子 Agent 指令，从当前端提供的目录选择工具和上下文来源，由主 Agent 委派运行。

本次分阶段交付，先验证 Greeting 与主会话，随后接定时任务和反思，最后开放自定义子 Agent。跨设备调度、嵌套委派、市场和通用工作流引擎留待单独规划。

## 2. 功能需求

### FR-AGENT-01：场景按需选择上下文

场景声明模块、模型策略与执行方式。一个场景可以仅读取 Profile 和长期摘要，另一个可以只使用系统提示词。模块声明片段区域。未选来源零读取，空来源与读取失败有明确的场景语义。

### FR-AGENT-02：沿用会话快照与压缩语义

主会话沿用现有快照 TTL、权限作用域、历史基线和恢复。轻量场景在一次请求内组装，兼容的会话反思可沿用原 Provider 投影。

### FR-AGENT-03：用户配置子 Agent

Web 和 Desktop 用户可以保存、编辑和停用子 Agent，配置提示词和工具。运行时沿用父会话模型和权限。子会话输入由自身历史及显式委派内容组成。

### FR-AGENT-04：单层委派与结果返回

主 Agent 可以派单后继续回复，也可显式等待结果。子会话按普通 Agent 的规则执行、取消和恢复。派单重试返回同一短 ID。工具使用父会话权限和公共 meta tool 策略。

### FR-AGENT-05：主 Agent 自动发现可委派的子 Agent

主 Agent 在系统上下文中收到当前可委派的子 Agent 目录。目录为空时省略该段。目录随新 Run 更新，模型用条目的稳定 ID 发起委派。委派时按当前授权核验所选定义。

### FR-AGENT-06：子 Agent 上下文回收与结果保留

子 Agent 自己的压缩成功持久化后，运行时回收该子 Run 已被新基线覆盖的消息。父 Agent 持久化消费 `agent_wait` 结果后，final 和等待回执才进入父会话的保留与清理流程。

### FR-AGENT-07：主动交付子 Run 的终态

子 Run 提交终态后，父 Run 无需调用 `agent_wait` 即可接收结果。父 Run 正在执行时，在下一次模型调用前接收结果。父 Run 正在等待时，同一交付记录完成等待回执。父 Run 已正常结束且委派允许后台汇报时，由调度器在原会话创建新的主 Run。已取消的父 Run 不触发后续汇报。

## 3. 技术方案

### 3.1 片段 IR 与组装契约

模块在读取前声明稳定 ID、版本及各输出的区域和内容类型。输出可以是文本或现有 Canonical 内容块，由 Core 编译到现有请求结构。一个模块可声明多个输出。生命周期不同且可独立查询的来源可拆成模块，例如长期摘要与近期记忆。

接口草案如下。实际类型复用现有 Core 端口和内容定义。

```ts
const profile = defineContextModule({
  id: 'user.profile',
  version: 1,
  outputs: {
    profile: { region: 'snapshot', kind: 'data' },
  },
  load: ({ scope, ports, signal }) => ports.profile.read(scope, signal),
})

const greeting = defineScene({
  id: 'greeting',
  modules: [greetingInstructions, profile, recentMemory, localTime],
  snapshot: 'request',
  execution: 'completion',
})

await runScene(greeting, { scope, input, signal })
```

| 区域 | 内容 | 现有编译目标 |
| --- | --- | --- |
| `system` | 应用可信指令、场景允许的用户配置指令 | `systemPrompt` |
| `snapshot` | 可复用的上下文数据，如 Profile、长期记忆摘要 | 快照正文或 `fixedPrefix` |
| `turn` | 任务输入、当前时间、临时资料 | 当前输入或现有动态上下文位置 |

应用指令与用户配置指令保留来源，按固定顺序编译。Profile、记忆、检索结果和委派材料保留数据身份。工具与资源授权由运行时执行。区域仅描述编排位置。持久化策略沿用现有上下文契约，临时输入和派生数据按场景明确是否可进入历史。

1. 解析场景与已选模块，检查重复 ID、未知来源、作用域和输出描述。
2. 确定快照命中情况。按计划加载所需来源，未选择的来源不发起读取。存在快照命中时跳过已覆盖的来源。
3. 按区域和声明顺序编译结果。并行读取的完成顺序不影响输出。可选数据按场景预算裁剪，任务指令和当前输入保留。区分缺少可选数据与读取失败。
4. 将结果映射到 `PrepareContextInput`、单次完成端口或现有反思投影入口。AgentLoop 继续由 `ContextPort`、`MessageArea` 和 Provider 适配层执行。本轮工具产生的后续消息照常进入现有运行区。

场景 A 只选 Profile 和长期摘要，由调用者传入任务文本。场景 B 只选系统提示词，业务来源和历史读取次数为零。模块的位置由自身声明，场景无需为同一个模块重复填写位置。

### 3.2 模块清单

每个 ID 对应稳定的输出描述。文件名见 §3.6。共享读取可以在同一授权和读取时点下去重，选中某个输出仍须避免触发无关业务查询。时区、语言、渠道、运行身份属于可信组装参数。只有实际入模的内容才生成片段。

| 模块 ID | 区域 | 数据或指令及现有入口 |
| --- | --- | --- |
| `main.instructions` | system | 现有基础规则、渠道指令、语言和风格偏好。复用 `buildAgentStaticPrompt` 与 Desktop 现有指令模板 |
| `subagent.catalog` | system | 主 Agent 的委派说明与精简目录。条目仅包含稳定 ID、显示名和用途说明 |
| `greeting.instructions` | system | 现有问候模板和语言要求。来源为 `greeting.ts` |
| `reflection.owner.instructions` | system | Owner 提取指令与输出约定。复用现有反思提示词读取器 |
| `task.instructions` | system 或 turn | 按各端现有任务契约使用任务指令。若现有位置不同，由模块预声明两个输出，并由场景变体只选择适用输出 |
| `subagent.instructions` | system | 应用约束及用户保存的指令，按此顺序渲染 |
| `user.profile`、`memory.summary`、`memory.daily` | snapshot | 画像、滚动摘要和每日记忆。复用现有 owner 限定读取，按场景独立选择。Greeting 的时间相关摘要和近七天日记在每次请求计算 |
| `memory.pattern`、`memory.stance`、`memory.lens` | snapshot | 现有记忆渲染所用的行为模式、立场和观察视角，仅在对应现有调用链已使用时渲染 |
| `overview.projects`、`overview.calendar`、`overview.notes`、`overview.files`、`overview.knowledge` | snapshot | 现有项目、日历、便签、文件和知识概览。Greeting 项目沿用现有近期筛选和话题格式 |
| `channel.source`、`channel.memory` | snapshot | 渠道提示、连接状态和获授权的 IM 记忆。群聊沿用自己的作用域及格式化 |
| `clock.now`、`greeting.last-seen`、`greeting.recent-stance` | turn | 当前用户时间、最近会话间隔和近期状态提示。保持现有的缺失与过期处理 |
| `input.current`、`input.attachments`、`history.session`、`retrieval.rag` | 现有请求槽位 | 当前输入、附件引用、基线后历史及召回结果。经现有历史、引用与 RAG 端口处理 |
| `reflection.owner.evidence`、`reflection.owner.memory-state` | turn | 归属已校验的证据批次及当前 Profile、Pattern、Summary 等提取状态。保留实际端口各字段边界 |
| `reflection.session.projection`、`reflection.session.input` | Provider 投影及原有尾部 | 兼容投影整体复用，反思任务输入和证据尾部按当前调用形状追加 |
| `subagent.input` | turn | 父 Run 显式委派的任务、已授权材料引用及结果约定 |

历史、当前附件、RAG 和反思投影走既有结构化入口，避免把它们渲染成普通正文。主 Agent 和子 Agent 使用同一套 meta tool 默认注入策略。meta tools 不参与上下文 IR 的选源、分区和片段预算，也不写入会话上下文快照。构造模型请求时，AgentLoop 按现有流程从可信工具注册表解析其 Schema，结合场景选用的业务工具、当前权限和宿主能力生成工具列表。

### 3.3 场景组装清单与顺序

下表按现有渲染语义列出模块。主会话和定时任务由兼容适配器保留各端实际请求顺序，等价验证后再提取片段。每个场景内部的逻辑顺序由定义固定，快照格式和 Provider 消息布局以对应的兼容入口为准。

| 目标场景文件 | 组装内容及顺序约束 | 模型与快照 |
| --- | --- | --- |
| `scenes/greeting/definition.ts` | 指令模板的原上下文槽位依次放时间、最近会话、近期状态、项目、摘要、日记、Profile，语言要求保持原末尾。模块按现有端口支持情况选择 | 原模型选择，单次完成，请求级组装 |
| `scenes/main/definition.ts` | `main.instructions` → `subagent.catalog` → 原快照中的记忆、渠道及业务概览 → 基线后的会话历史 → 现有时间提醒、立场变化、RAG、当前消息与附件槽位。Web 沿用 Core builder，Desktop 沿用 SQLite overview。群聊仅按当前策略选择群作用域来源 | AgentLoop，会话 TTL 与历史压缩 |
| `scenes/task/definition.ts` | 现有系统指令及任务指令 → 现有 owner 或 IM 作用域快照 → 本次触发输入和已授权引用。仅加载任务原有的概览、历史与检索能力 | 沿用任务模型、运行、快照及投递策略 |
| `scenes/reflection/owner.ts` | `reflection.owner.instructions` → 现有模型请求里的日期和记忆状态 → 已验证证据批次。沿用现有请求格式和拆批逻辑 | 现有模型绑定，单次完成，请求级组装 |
| `scenes/reflection/session.ts` | `reflection.session.projection` → `reflection.session.input`。直接使用既有投影适配器 | 现有反思分支，兼容投影复用 |
| `subagent/resolve-definition.ts` | `subagent.instructions` → 所选且授权的来源 → `subagent.input`。子 Run 内后续工具结果继续由现有运行区维护 | 继承父会话模型，历史保存在独立子会话 |

### 3.4 快照、压缩与恢复

- Web 的 PostgreSQL 和 Desktop 的 SQLite 共用 `ensureSessionSnapshot`。主会话保留默认 30 分钟空闲 TTL、命中续期、现有作用域校验和快照重建语义。业务版本仍在重建时吸收。压缩成功持久化后按现有逻辑推进历史基线序号和哈希，TTL 重建继承基线。
- 本次请求策略在运行内固定稳定片段。Greeting 的结果缓存、互斥和失败语义由现有问候流程负责。结果缓存与会话快照有各自的生命周期。
- 会话反思将已有 Provider 投影整体接入，继续校验模型、owner、会话和访问范围。Owner 反思保留证据批次、窗口拆分和写回版本校验。
- 主会话先适配现有 builder 输出，再逐步提取共享模块。现有读取器继续消费旧会话快照。需要改变持久化格式时，先定义版本校验与迁移行为。
- 可恢复运行绑定场景 ID、配置修订号、选定来源、模型身份和权限范围。恢复时复核当前授权，再从 checkpoint 续接。提示词配置变化只应用于新运行，旧运行使用已绑定版本。凭据或授权失效按现有恢复机制返回明确状态。

### 3.5 自定义子 Agent 与委派

子 Agent 是绑定到父会话的普通 Agent 会话。跨端共用现有 Runner、上下文组装、调度、存储、恢复与权限。预设仅定义提示词和业务工具选择，运行时从父会话取得模型、工作区和权限。

```ts
type SubagentPreset = {
  id: string
  name: string
  description: string
  instructions: string
  toolIds: string[]
}
```

每个子会话默认只加载自身历史和显式输入，沿用普通会话的快照与压缩规则。程序调用与父 Agent 委派使用同一个普通 Agent 执行入口。

### 3.5.1 父 Agent 绑定、委派和权限

子会话绑定到创建它的主会话。运行时从可信上下文核验 owner、父会话和当前工具授权。`subagent.catalog` 与派单使用同一可用定义目录，首期只允许主 Agent 向其直接子会话派单。

- `agent_message({ action: "start", … })` 从可信父 Run 身份解析定义，固定修订号，创建独立子 Run。用父 Run ID 和委派工具调用 ID 保证重试幂等。记录归属父会话的稳定子会话、输入引用、执行预算和独立运行状态。默认无固定轮次上限。
- 有效工具范围取场景所选工具与公共常驻工具的并集，再与父 Run 可委派范围及 Host 当前授权取交集。模型可见 Schema 和实际执行都经现有工具注册表检查。上下文、附件及产物引用额外做 owner 和资源范围校验。父 Run 仅传显式选择的材料。
- 首期一层委派。派单立即返回，父 Agent 可继续回复或委派其他子 Agent。父 Agent 显式等待时，持久化等待并释放执行槽。子 Agent 复用父会话的读写授权、自动模式和确认门。父执行取消时取消它发起且仍在运行的任务，保留子会话。恢复不得重复创建已登记的执行。
- 运行时按 §3.5.4 交付子 Run 的 final 消息及获授权的产物引用。写操作需在确认展示与恢复链路接通后开放，结果未知的副作用沿用现有防重放规则。

### 3.5.2 内置预设与常驻工具

子 Run 的全部用户确认统一从父 Session 展示和提交，覆盖 Shell、写工具、宿主文件访问及权限申请。共享确认卡显示发起者。父会话与父 Run 来自持久派单映射；实际确认意图与回执始终绑定子 Session、子 Run、轮次和工具调用。恢复时复核目标、有效期和当前授权，批准只能消费一次。父取消时停止未完成的确认，父子并发交互不能覆盖对方。凭据仍从专用入口提交。

子 Agent 默认跟随父会话当前的工作区绑定，父子在同一份文件和路径上协作，子 Run 保留独立 Session、租约与回执。显式委派进一步限制目标范围，读写权限由父 Agent 所用的统一策略判定。子 Run 复用父 Agent 的宿主权限门和当前普通或自动模式。宿主评估父会话有效授权、目标范围、子工具准入和沙箱约束。自动模式按同一规则判定哪些确认可省略。需要确认时在父 Session 展示卡片，回执绑定实际执行的子 Run 和本次操作。独立工作区作为显式选项，临时目录可用于中间文件。

每个内置子 Agent 放在 `subagent/[agentname]/`，目录中存放提示词、场景定义和该预设的组装模块。程序直接调用与主 Agent 委派都解析同一个定义。程序调用使用可信 scope，委派从父 Run 派生 scope，两者执行相同的授权规则。

首个实验预设为 `searcher`，配置文件搜索、网络搜索和抓取网页。运行时通过公共 meta tool 策略提供 Shell。Searcher 读取明确的研究问题、搜索范围与交付要求，在授权范围内多轮搜集证据。运行中发布简短阶段状态，收尾提交带文件引用或网页链接的报告和未解决问题。父 Agent 收到 Searcher 的最终回复和可选报告引用。预算耗尽时可交付标明范围的部分报告。

**Shell 是所有 AgentLoop 场景的常驻 meta tool。** 主 Agent、内置子 Agent 和自定义子 Agent 的运行时均默认注入 Shell。Shell 由公共 meta tool 策略统一提供，预设和用户配置仅选择业务工具。仍由 Host 当前授权、父 Run 可委派范围、沙箱能力和现有确认策略共同决定本次是否向模型暴露 Shell Schema 以及是否允许执行。权限或沙箱不足时清楚反馈原因。单次完成场景沿用现有无工具执行方式。

Workflow 和 File Management 可作为后续预设。跨项目与文件边界的写入由完整业务用例处理。写工具和并行委派分别验收授权、隔离、确认和预算。

Skill 的 `related_tools` 和 `get_tool_schema` 可用于按需发现工具 Schema。Schema 由可信注册表提供，仍受运行允许范围限制。自动注入和生产接线应先核实现状，再作为独立增量验证实际 Provider 请求与恢复行为。

### 3.5.3 主 Agent 的子 Agent 目录

`subagent.catalog` 是主场景显式选择的 `system` 模块，固定放在 `main.instructions` 之后。Web 和 Desktop 从各自 Host 注入的可信目录端口读取，只列已绑定当前父 Agent、在当前 owner 和 Run 作用域内获授权且已启用的定义。空目录省略该片段。条目按稳定 ID 排序，限制数量与字段长度。Core 用固定说明包裹结构化条目，用户填写的名称和用途按数据转义，仅用于匹配任务。子 Agent 完整提示词、工具 Schema、凭据和私人上下文只在对应子 Run 按授权加载。

每个主 Run 开始时解析一次目录，将结果和指纹绑定到该 Run 的请求前缀。会话快照命中时仍读取新 Run 的目录。恢复旧 Run 时使用已绑定的目录重建相同前缀，委派执行前重新校验定义状态和当前权限。目录发生变化时，新 Run 的系统前缀会相应变化，会话快照 TTL 和历史压缩基线继续独立维护。

### 3.5.4 子 Agent 通信工具 Schema

具备委派权限且至少有一个可委派绑定的父 Agent，在新 Run 启动时由 AgentLoop 自动获得四个常驻通信工具。首期子 Run 沿用一层委派限制。工具 Schema 集合在同一 Run 内保持稳定，恢复时沿用该 Run 已绑定的集合。绑定移除或子 Agent 停用后，`agent_message(start)` 按当前绑定和授权拒绝新派单。父 Agent 仍可在现有父子关系及当前权限范围内等待、查看或取消已创建的子 Run。目录由上下文 IR 组装，通信工具由运行时注入。

下列类型描述模型可见的请求与回执，Web 和 Desktop 使用同一套校验。所有请求对象禁止额外字段。联合类型的分支互斥，Provider Schema 适配和 Core 校验均须保留字段依赖。

#### 请求

```ts
type ChildId = string // ^[0-9a-f]{8}$

type AgentMessageInput =
  | {
      action: 'start'
      agentId: string
      task: string
      resourceRefs?: string[]
      allowBackgroundReport?: boolean
    }
  | {
      action: 'send'
      childId: ChildId
      message: string
    }

  | { action: 'send'; target: 'parent'; message: string }

type AgentWaitInput = { childId: ChildId } | Record<string, never>
type AgentCancelInput = { childId: ChildId }

type AgentInspectInput =
  | Record<string, never>
  | { childId: ChildId; round?: number }
```

`agentId` 使用目录中的稳定 ID，例如 `builtin:searcher`。`task` 和 `message` 去除首尾空白后须非空，资料引用由可信 Host 解析与授权。`allowBackgroundReport` 默认为 `false`，只控制父 Run 正常结束后的新汇报 Run。运行时须把该选项与委派一同持久化，重试沿用原委派的选项。试验工具和加密派单已经保存该选项，实际汇报调度待接线。`round` 是从 1 开始的安全整数，指定轮次时必须提供 `childId`。

运行时为子会话生成 UUID v4，取前 8 位作为 `childId`。`(ownerId, parentSessionId, childId)` 唯一，碰撞时重新生成 UUID。每次执行生成独立内部 Run ID，用于租约、重启恢复与交付去重。四个通信工具只接受稳定短 ID，从可信执行上下文解析父会话归属。创建与发送按内部发送方执行身份和工具调用 ID 去重，重试返回原回执。

#### 通用状态与三个控制工具

```ts
type ActiveStatus = 'queued' | 'running' | 'cancelling'
type TerminalStatus = 'completed' | 'partial' | 'failed' | 'cancelled'
type RunStatus = ActiveStatus | TerminalStatus

type RunSummary = {
  childId: ChildId
  agentId: string
  status: RunStatus
  updatedAt: string
}

type FinalDelivery = {
  finalMessage: string
  reportRef?: string
  limitations?: string[]
}

type RunOutcome =
  | ({ status: 'completed' | 'partial' } & FinalDelivery)
  | {
      status: 'failed' | 'cancelled'
      reasonCode: string
      partialResult?: FinalDelivery
    }

type AgentMessageOutput =
  | { action: 'start'; run: RunSummary }
  | { action: 'send'; childId: ChildId; messageId: string }
  | { action: 'send'; childId: ChildId; started: true }

type AgentWaitOutput = { childId: ChildId } & (RunOutcome | { status: TerminalStatus; alreadyDelivered: true })
type AgentCancelOutput = { childId: ChildId; status: RunStatus }
```

| 工具 | 返回时机与状态 |
| --- | --- |
| `agent_message` | `start` 在子 Run 和父子关联提交后立即返回。 `send` 在消息持久化入队后立即返回，子 Agent 在下一轮开始前接收。子会话空闲时原子登记新执行，继续使用自身历史与压缩基线 |
| `agent_wait` | 登记时固定对应执行。有终态立即返回持久结果，否则挂起并在终态到达后续跑原父 Run。重试和重启沿用原绑定 |
| `agent_cancel` | 请求持久化后返回当前状态，子 Run 实际退出后进入 `cancelled`。重复取消幂等。空闲时返回最近任务终态，保留子会话 |

`finalMessage` 就是子 Agent 正常结束时的最终回复。运行时随终态保存并自动交付，即使子 Agent 没有调用任何工具也生效。失败或取消仅在已有持久化部分结果时附上 `partialResult`。`reportRef` 指向经授权的报告或产物。日期时间字段使用 ISO 8601，耗时字段使用毫秒。

#### 查看 Run 和轮次

```ts
type TaskActivity =
  | { kind: 'queued' }
  | { kind: 'model_running'; round: number; elapsedMs: number }
  | {
      kind: 'tool_running'
      round: number
      tools: Array<{ name: string; elapsedMs: number }>
    }
  | { kind: 'waiting_for_input'; round: number }
  | { kind: 'retry_wait'; round: number }

type StepStatus = 'running' | 'completed' | 'failed' | 'cancelled'

type RoundDetail = {
  number: number
  status: StepStatus
  modelCall?: {
    status: StepStatus
    elapsedMs: number
    usage?: {
      inputTokens: number
      outputTokens: number
      cacheReadTokens?: number
    }
    reasonCode?: string
  }
  toolCalls: Array<{
    name: string
    status: StepStatus
    elapsedMs: number
    artifactRefs?: string[]
    reasonCode?: string
  }>
  reasonCode?: string
}

type InspectResult =
  | { status: 'completed' | 'partial'; reportRef?: string }
  | {
      status: 'failed' | 'cancelled'
      reasonCode: string
      reportRef?: string
    }

type AgentInspectOutput =
  | { view: 'list'; runs: RunSummary[] }
  | {
      view: 'run'
      run: RunSummary
      activity?: TaskActivity
      progress?: { text: string; updatedAt: string }
      model: { id: string; selection: 'inherited' | 'preset' }
      context: { moduleIds: string[]; inputRefCount: number }
      tools: string[]
      budget: { roundsUsed: number; maxRounds: number | null }
      result?: InspectResult
    }
  | { view: 'round'; run: RunSummary; round: RoundDetail }
```

`agent_inspect({})` 列出当前父会话的子 Agent。提供 `childId` 时返回当前或最近一次执行的状态，追加 `round` 时同时返回整个 Run 的状态和指定轮次的模型及工具记录。尚未开始或不存在的轮次返回 `ROUND_NOT_FOUND`。

`activity` 和轮次状态从持久化 checkpoint 及运行时事件读取。子 Agent 未主动发布文字进度时仍能查看运行活动。`progress` 仅在有已保存的文字进度时返回。上下文摘要包含实际组装的模块 ID 和输入引用数量，工具名来自已解析的有效工具集合。轮次详情仅披露状态、耗时、已记录的用量、授权产物引用和脱敏错误码。完整 final 通过主动投递或 `agent_wait` 交付。

#### 错误回执

四个工具共用 `{ error: { code, message } }`。首期工具错误码包括 `INVALID_INPUT`、`AGENT_UNAVAILABLE`、`RUN_NOT_FOUND`、`ROUND_NOT_FOUND`。不存在或无权访问的子会话均返回 `RUN_NOT_FOUND`。子 Run 自身执行失败通过终态回执的 `reasonCode` 表达。

### 3.5.5 子 Run 消息回收与结果保留

父会话和子会话均持有持久收件箱。父子消息加密保存，按内部发送执行身份和工具调用 ID 幂等。每次子执行的 final 复用交付规则，按内部执行身份去重。正文在下一次安全的模型调用边界进入接收方上下文，checkpoint 提交时确认消费。

`agent_wait({ childId })` 等指定子终态，`agent_wait({})` 等普通消息、子终态或当前 Run 用户追加输入。两者均挂起并续跑原 Run。Web 通过 PostgreSQL dispatch 和 Redis 通知，Desktop 通过 SQLite 和本机 Worker 调度。后台汇报仅在父 Run 正常结束且明确允许时创建，新派单与原终态认领须同事务按子 Run ID 去重。

子会话独立维护历史、摘要与压缩基线，单次执行由自己的 checkpoint 恢复。子会话压缩摘要与新基线成功持久化后，才回收覆盖的原始消息。保留新摘要、基线之后的消息、未消费的收件箱内容，以及恢复和重试仍依赖的工具回执与产物引用。压缩失败或事务回滚时保留原消息。清理以已提交基线为准，可安全重试，父会话压缩无需参与这一过程。

子 Run 终结时保存 final 和交付所需的短 ID、终态及回执。主动投递与 `agent_wait` 共用同一交付记录。父 Run 将结果写入可恢复 checkpoint 后，方可确认已消费。已主动交付的结果再次等待时返回状态及 `alreadyDelivered: true`，不再注入全文。仅收到返回值或唤醒事件时仍保留交付数据。确认消费后，final 和等待回执按父会话的既有保留策略清理。未消费或父 Run 恢复仍依赖的交付记录继续保留。报告等独立产物沿用各自的保留策略。

### 3.6 目标文件与责任边界

以下路径相对于仓库根目录。新增文件为实施目标，迁移版本号随对应数据库序列分配。

```text
.
├── packages/
│   ├── core/
│   │   ├── src/agent/
│   │   │   ├── context/
│   │   │   │   ├── fragments.ts                 【新增】片段契约、区域及输出声明
│   │   │   │   ├── fragment-plan.ts             【新增】选源、分区与预算，供后续快照接线使用
│   │   │   │   ├── modules/
│   │   │   │   │   ├── subagent-catalog.ts      【新增】可委派目录读取与 system 片段渲染
│   │   │   │   │   ├── memory.ts                【新增】Profile、摘要、日记及其他实际使用的记忆输出
│   │   │   │   │   ├── overview.ts              【新增】项目、日历、便签、文件和知识输出
│   │   │   │   │   ├── channel.ts               【新增】渠道和 IM 记忆输出
│   │   │   │   │   └── turn.ts                  【新增】时间和现有历史、附件、检索槽位适配
│   │   │   │   ├── builder.ts                   【修改】沿用旧格式并接入片段计划
│   │   │   │   ├── prepare.ts                   【修改】快照命中与片段加载接线
│   │   │   │   └── assemble.ts                  【不改】既有 Canonical Context 组装入口
│   │   │   ├── scenes/
│   │   │   │   ├── run-scene.ts                 【新增】场景解析及执行分发
│   │   │   │   ├── main/definition.ts           【新增】主会话与渠道变体
│   │   │   │   ├── greeting/definition.ts       【新增】指令、问候专属模块与顺序
│   │   │   │   ├── reflection/owner.ts          【新增】反思指令、记忆状态及证据模块
│   │   │   │   ├── reflection/session.ts        【新增】会话投影与反思输入适配
│   │   │   │   └── task/definition.ts           【新增】触发输入及任务场景定义
│   │   │   ├── subagent/
│   │   │   │   ├── searcher/
│   │   │   │   │   ├── prompt.md               【新增】研究策略、引用与长程报告
│   │   │   │   │   ├── definition.ts           【新增】预设定义、搜索工具和预算
│   │   │   │   │   └── context.ts              【新增】研究问题、授权范围和交付要求
│   │   │   │   ├── contracts.ts                 【新增】配置、目录、委派输入与结果契约
│   │   │   │   ├── resolve-definition.ts        【新增】场景定义、指令与任务输入
│   │   │   │   ├── delegate.ts                  【新增】幂等委派及父子生命周期
│   │   │   │   └── inspect.ts                   【新增】Run 与轮次状态投影
│   │   │   ├── memory/
│   │   │   │   ├── context.ts                  【修改】复用独立的问候记忆格式化
│   │   │   │   └── sqlite.ts                   【修改】增加按目标读取的 SQLite 端口
│   │   │   ├── memory/reflection.ts           【修改】反思分支接入场景并保留原生投影
│   │   │   ├── greeting.ts                      【修改】保留问候缓存及互斥，接入新场景
│   │   │   ├── tools/subagent.ts               【新增】四个通信工具的 Schema 与接线
│   │   │   ├── tools/meta.ts                  【修改】Shell 常驻 meta tool 策略
│   │   │   ├── tools/registry.ts                【修改】接入有效工具范围
│   │   │   └── run/history-compaction.ts        【不改】历史压缩基线规则
│   │   ├── src/runtime/desktop-greeting.ts     【修改】Desktop worker 的问候场景与来源接线
│   │   └── tests/
│   │       ├── agent/context/fragment-plan.test.ts    【新增】来源读取与路由契约
│   │       ├── agent/context/session-snapshot.test.ts 【修改】兼容及命中时跳过来源的回归
│   │       ├── agent/subagent/delegate.test.ts  【新增】隔离、幂等和生命周期
│   │       ├── runtime/desktop-greeting.test.ts 【新增】临时 SQLite 与旧文件读取回归
│   │       └── suites.json                     【修改】登记新增回归
│   └── database/src/
│       ├── postgres/migrations/                 【新增】子 Agent 定义与父子运行关系迁移
│       └── sqlite/migrations/                   【新增】对应 SQLite 迁移
└── apps/
    ├── web-host/src/modules/
    │   ├── agent/chat/greeting.ts               【修改】问候来源和模型端口
    │   ├── agent/context/assemble.ts            【修改】主会话场景装配
    │   ├── agent/memory/reflection/model.ts    【修改】Owner 反思场景装配
    │   ├── im/gateway/memory/jobs.ts            【修改】会话反思场景装配
    │   ├── scheduled-tasks/run/context.ts       【修改】定时任务场景装配
    │   └── agent/subagent/routes.ts             【新增】配置和目录 HTTP 接口
    ├── web-host/tests/agent/context/greeting.test.ts 【修改】验证选源及缓存命中
    ├── desktop/src/main/agent/
    │   ├── runtime.ts                           【修改】宿主场景与可信端口接线
    │   └── subagent-ipc.ts                      【新增】配置和目录 IPC 处理
    └── ui/src/shared/components/common/profile/
        ├── ProfileModal.vue                     【修改】接入子 Agent 配置入口
        └── subagents/SubagentSettingsPane.vue   【新增】两端共享编辑界面
```

Core 持有场景和编译规则。Web 与 Desktop 负责可信身份、数据库、Redis、模型、队列和平台能力。传输和存储接入沿用现有 Host 模式。快照正文继续通过既有格式化器序列化，Provider 请求继续通过现有适配器投影。

LoopScope 记录场景 ID、模块 ID、区域、顺序、耗时、指纹、快照命中原因和父子 Run 关联。普通日志使用字段白名单，片段正文、附件名和凭据遵循既有诊断边界。

## 4. 验证与上线

- 用可观测读取端口验证 A 只查两种来源、B 零业务读取、会话快照命中跳过稳定来源。覆盖空值、真失败、取消和预算裁剪。
- 对 Web、Desktop 使用固定会话、时区、模型和工具集合，比较迁移前后发送给 Provider 的角色、消息顺序、工具 Schema、快照哈希、跨 Run 首轮与后续轮次前缀。历史压缩、快照过期和反思投影分别验证。
- 用真实 Host 验收两端编辑、工具撤权、跨 owner 隔离、重复委派、级联取消、超时和重启续接。分别记录端口测试及真实 Provider、数据库和队列的验证范围。
- 迁移期间按场景保留原接线，发现请求布局或权限回归时回退到原场景路径。子 Agent 入口关闭后停止接受新委派，已有子 Run 仍按既有取消或终结机制处理。数据库迁移采用向前兼容增量。

## 5. 风险与待确认问题

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| 片段拆分改变 Provider 前缀 | 首轮缓存命中回退 | 在迁移前记录请求基线，按端和 Provider 协议核对 |
| 共享来源扩大读取范围 | 群聊或子 Run 读到超出授权的数据 | 模块只接受可信作用域，测试读取与工具执行两条路径 |
| 父 Run 等待时占满执行槽 | 子 Run 无法消费 | 持久化等待后释放槽，终态幂等唤醒 |
| 两端同名来源格式不同 | 用户行为或提示词出现非预期变化 | 首轮按各端兼容渲染，等价后收敛 |

待确认事项为自定义子 Agent 可选的其他只读工具及来源名单、预算上限、子 Run 展示和保留期限，以及后续写工具的确认归属。

## 6. 唯一实施 TODO

### Phase 1：模块契约与 Greeting

- [x] `AGENT8-001` Core 实现片段计划与编译。验收证据见 `packages/core/tests/agent/context/fragment-plan.test.ts`，覆盖位置、顺序、预算、零读取、读取失败和取消。
- [x] `AGENT8-002` Web 与 Desktop 接入 Greeting 场景。Web 用替身验证缓存命中、锁和 Provider 请求，Desktop 用临时 SQLite 验证缺省和指定来源，Core 固定输入对比完整提示词。真实账号与模型调用留待发布验收。

### Phase 2：主会话与其他内置场景

- [x] `AGENT8-003` Core 与两端 Host 接入兼容主会话场景。
  - `packages/core/tests/agent/context/sources.test.ts` 验证迁移前快照及旧正文字段可读，命中跳过稳定来源并续期，到期重建后保持持久化压缩水位和历史过滤。
  - `packages/core/tests/agent/providers/runtime.test.ts` 使用真实 Provider 适配器和合成传输，逐字节比较 Web、Desktop 在 OpenAI Chat Completions 和 Anthropic 下的新旧请求体，覆盖冷启动、下一 Run 的快照命中、首轮及工具后续轮。未向外部模型发送请求。
  - 隔离 PostgreSQL 的快照和历史读取回归通过。另一个 Web 重启集成用例在其测试 schema 缺少 `agent_interaction_resumes` 时失败，未覆盖该用例的端到端重建。
- [x] `AGENT8-004` 两端定时任务通过 Core 的 `createScheduledTaskContextLoader` 接入任务场景。Core 验证 owner 与群作用域、触发输入和投递结果。Web 隔离 PostgreSQL/Redis 测试验证租约、投递和重复触发。
- [x] `AGENT8-005` 现有反思链路接入 Owner 证据和会话投影场景。Web 保留现有拆批和快照复用策略，Desktop 保留 SQLite 已有批次处理和授权证据入口。
  - 隔离 PostgreSQL 验证跨 owner、群范围、错误锚点和活跃会话的证据筛选，真实 Redis 验证队首拆批及写回版本冲突后的重试。
  - Desktop 临时 SQLite 与本机合成模型验证私聊证据、暂停恢复及生成期间摘要修改。旧摘要版本不提交，批次重新排队。
  - Provider 适配器使用合成传输验证旧版无行计数的原生投影可续接，跨 owner 投影在发请求前被拒绝。
  - Web 的 Linux 原生文件写入集成在当前平台跳过。额外运行的持久反思区间集成停在 `0002_web_domain` 迁移校验，未验收到其端到端发布。

### Phase 3：自定义子 Agent

- [ ] 稳定子会话切换。迁移 PostgreSQL 和 SQLite 的父子归属、当前执行、收件箱和待交付结果。跨父 Run 通过同一短 ID 继续任务。验证旧短 ID 碰撞、旧加密记录、重复发送、空闲并发唤醒、等待绑定、权限更新、运行中重启和 final 去重。两端通过后移除旧 Run 级寻址及 Searcher 专用执行装配，直接复用普通 Agent 调度。

- [ ] `AGENT8-006` Core 契约、两端 Host 和共享设置界面交付定义管理。验收要求为可保存、编辑和停用，失效目录项可辨认，跨 owner 不可读写，支持显式绑定一个或多个父 Agent，缺省继承主 Agent 模型且可选择已授权预设。
- [ ] `AGENT8-007` Core 与两端调度接入单层委派。验收要求为子 Run 独立持久化、重试幂等、撤权生效、取消传播、超时终结、重启可续接，以及子 Agent 无额外工具调用时仍自动交付 final 消息。通信工具按 §3.5.4 验收，覆盖短 ID 冲突与重启解析、重复派单和追加、按轮查看持久状态、未开始轮次、跨父 Run 隔离及等待后回放同一 final。还须验证常驻工具在同一 Run 内保持稳定，绑定撤销后拒绝新派单，原有子 Run 在授权范围内仍可等待、查看或取消。

- [ ] `AGENT8-008` Core 与两端 Host 将子 Agent 目录作为主场景 system 模块接入。验收覆盖实际 Provider 请求位置、空目录、稳定顺序、单个或多个父 Agent 绑定以及越权与停用项过滤、快照命中时更新、旧 Run 前缀恢复及委派时重新授权。

- [ ] `AGENT8-009` 公共 AgentLoop 工具策略提供常驻 Shell meta tool。验收覆盖主 Agent、内置及自定义子 Agent 在实际 Provider 请求中默认获得授权的 Shell Schema，修改上下文模块列表不影响工具注入，同时验证撤权、无可用沙箱和现有确认规则。
- [ ] `AGENT8-010` 🟡 实验 Searcher 预设支持程序调用与主 Agent 委派。Core 同进程试验已通过程序直调、Canonical Runner 调用四个通信工具、短 ID、按轮查看、追加消息、去重、取消和自动 final 交付。模型与资料使用合成端口。跨端 Host 持久化接线、真实 Provider 与搜索、完整或部分报告及跨进程恢复仍需验收。

- [ ] `AGENT8-011` 🟡 Core 与两端持久化适配器实现 §3.5.5 的回收规则。验收覆盖压缩成功后仅回收已覆盖消息、压缩失败保留原文、回收后可从新基线恢复、父 Run 未持久化消费时可重复领取同一 final，以及消费后按父会话保留策略清理。
  - 交付存储已接入显式试验协调器。SQLite 重开后 `agent_wait` 读取原 final，隔离 PostgreSQL 重连验证短 ID 和终态回放。交付回收接口验证消费事务回滚时保留原 final。
  - Searcher 成功压缩时的新 checkpoint 只携带最新压缩候选，失败时原 checkpoint 保持可读。Web 与 Desktop 生产调度及按覆盖边界物理回收历史和事件正文仍待实现。

- [ ] `AGENT8-012` 将子 Run 终态主动投递给父 Agent。验收覆盖运行中下一轮注入、显式等待共用交付、回滚和恢复幂等、父 Run 已结束时按授权启动新的汇报 Run，以及已取消时不唤醒。
  - Core 已在父 Run 的下一轮模型请求前读入未消费结果，主动投递与显式等待共用交付记录。Web PostgreSQL 和 Desktop SQLite 的父 checkpoint 写入与消费标记在同一事务提交。
  - Core 试验验证未调用 wait 时结果进入下一轮，SQLite 验证事务失败后结果可重领，隔离 PostgreSQL 验证父 checkpoint 提交后交付记录已消费。两端生产 Searcher 调度、持久等待唤醒、父 Run 正常结束后的汇报调度及取消竞态仍待验收。
  - Core 协调器使用与派单同事务写入的持久子会话映射，从已经提交的子 checkpoint 恢复缺失的终态交付。PostgreSQL 和 SQLite 集成测试均使用实际 RunStore 与租约验证子会话可保存 checkpoint。隔离 SQLite 验证数据库重开后并发 wait 共用同一结果，父消费后不再返回全文。Web 和 Desktop 启动时会扫描并补交已提交的子终态。两端生产 worker 尚未接入 Searcher 派单和未完成子 Run 的恢复。
  - 派单事务可加密保存任务、资料引用与模型身份。Core 协调器重启后可由重复派单或 wait 恢复，继续原 checkpoint，租约冲突时保留待交付状态。隔离 SQLite 验证了原 Run ID、模型请求只执行一次以及租约竞争不会误写终态。
  - 父 Run 等待未完成的子任务时，将确切子 ID 与父 checkpoint 一同提交并释放租约。Web dispatch 可在指定子结果就绪后领取原父 Run。Desktop 独占恢复识别这一等待态。生产 Searcher 派单与未完成子 Run 的 worker 续跑、后台汇报调度和两端端到端验收仍待完成。
  - Core 提供按批扫描未完成派单及复用原子 Run 的恢复入口，已取消的父 Run 不会进入扫描结果。该入口仍需两端生产调度器配置各端真实的模型与工具绑定。

- [ ] `AGENT8-013` 交付父子持久收件箱与两种等待。两端验收双向消息跨重启、指定等待不被无关消息唤醒、空参数等待因更新续跑、回滚后可重领、获准汇报只新建一次、取消后不唤醒。
  - 已实现普通收件箱的双向持久化、事务消费与空参数等待，Web dispatch 和 Desktop 启动恢复可判断消息或子终态就绪。生产 Searcher 注册及派单、Desktop 实时 Worker 通知、用户追加输入和后台汇报派单仍待接线。
  - 已移除试验版的内存补充消息队列。SQLite 验证重启后 Searcher 续跑时能把持久补充消息交付给模型并只消费一次。
  - 使用持久子会话的 Searcher 终态与加密交付同事务提交，两端 Store 校验父子映射。启动补扫继续恢复旧记录。
  - 子终态提交后，Web 通过现有 Redis 频道提示 dispatch 扫描，Desktop Runtime 重新检查原父 Run 的活动身份、等待条件与取消状态，再尝试续跑。两端 Searcher 派单接线和完整生产验收仍待完成。
  - Desktop 个人交互会话注册 Searcher 委派工具，子 Run 继承经宿主重新解析的父模型，启动 Worker 分批续跑可恢复派单。合成 Provider 集成验证从 Desktop 生产入口派单、父等待、同一 Run 自动续跑及父取消后无额外模型请求。Web 派单、Desktop 重启端到端验收、授权文件搜索和后台汇报仍待做。
  - Web 生产聊天入口已注册 Searcher，重新校验父模型绑定并用独立持久租约执行子 Run。Host 启动接入派单恢复，普通消息与子终态提交后通过 Redis 提示 dispatch 领取等待中的父 Run。隔离 PostgreSQL、Redis 和合成 Provider 验证 Web HTTP 派单、挂起及原父 Run 恢复消费。跨进程重启、跨 Worker 取消传播、后台汇报与授权文件搜索仍待验收或接入。
  - Web 父取消以 PostgreSQL 状态为准，按持久父子关系经 Redis 通知正在执行的子 Run。合成 Provider 集成验证 HTTP 取消使子模型流关闭、父子终态持久化，父 Run 不发起下一轮。真实多进程部署的断线与恢复组合仍待验收。
  - Web 强制退出集成验证子 Run 在发起模型请求前的 checkpoint 续跑，恢复后原父 Run 只消费一次 final。Web 恢复周期会重试尚未过期的旧租约，Desktop 在独占启动时释放旧子 Run 租约。Provider 无法续接已发出的请求时，将未知终态通过交付记录明确返回给父 Run。
  - 两端内置 Searcher 目录迁移到公共 system 片段，空目录与相同目录顺序的稳定性已验证。
  - Desktop 使用捆绑生产运行时和合成 Provider 验证进程强制退出后的独占接管。持久旧租约被释放，子 Run 使用原 ID 完成，原父 Run 恢复并仅消费一次。测试在模型请求前的安全 checkpoint 模拟中断。
  - Desktop Searcher 可按 resourceRefs 在父 Run 本轮显式委派的文件中搜索、读取摘录。每次读取复核父 Run 引用与宿主文件身份，未委派的键无法读取。Desktop 生产路径已用真实临时文件和合成 Provider 验证授权与拒绝。
  - Web Searcher 可搜索和读取本轮显式委派的文件库文件及工作区文件。授权按父 Run 的用户消息锚点和文件所有者复核。工作区引用使用共享引用键，实际打开时复核目录和文件身份。devserver 的 Linux HTTP 集成使用实际临时文件、隔离 PostgreSQL 和 Redis 及合成 Provider，验证两类授权文件均可搜索和读取，同一用户未委派的文件不出现在搜索结果中且读取被拒绝。
  - 同一 Linux 集成套件通过指定子终态唤醒原父 Run、父取消经 Redis 停止子 Run，以及强制退出后续跑原子 Run 并只消费一次 final 的回归。
  - agent_inspect 可从持久记录查看子 Run 列表、终态与已有轮次，省略未持久化字段及子 final 正文。

- [ ] `AGENT8-014` 将所有子 Run 确认接到父 Session。Web 和 Desktop 验收同一共享确认卡、刷新和重启后恢复、确认或拒绝只续跑原子 Run、并发确认互不覆盖、重复提交只消费一次，以及取消、撤权、过期和换目标后的拒绝。使用 Shell 与至少一个非 Shell 确认门验证通用路由。普通和自动模式分别对照同宿主父 Agent 的允许、确认与拒绝结果，并验证运行中切换模式和撤权。
  - Core 已提供父 Run 到等待中子 Run 的持久化查询和释放租约后的交互恢复入口。Core 使用合成 Shell 与文件读取确认验证回执只进入原子 Run，SQLite 验证错误的父 Run 和取消后的父 Run 无法解析待确认提示。
  - Web 和 Desktop 已接入共享确认卡、父会话刷新通知、子 Run 提交校验和持久回执读取。Web PostgreSQL 集成验证同一父会话显示多个子确认、提交回原子 Run、重复提交返回父会话坐标，以及父取消后旧令牌失效。SQLite 验证投影及事务内撤权拒绝。
  - Core 关停时保留已等待确认的子 Run。回归覆盖关停后从原 checkpoint 恢复并消费一次回执，真实双端进程重启仍需验收。
  - Web 在 devserver Linux 使用真实 Bubblewrap 和隔离 PostgreSQL、Redis 验收父工作区写入。普通模式从父会话读取确认卡，批准前文件不存在，批准后原子 Run 完成写入。自动模式按同一宿主策略直接完成对应写入。
  - Web 和 Desktop 的 Searcher 在 Host 工具策略允许时始终注册 Shell meta tool。范围未获批准或执行环境不可用时返回原因。Desktop 可通过主 Agent 的宿主路径权限门访问明确指定的绝对目录，未绑定共享工作区时亦可用，自动模式和会话级授权按父会话判定，单次确认回执继续归子 Run。
  - Desktop Searcher 在父会话已绑定工作区、派单没有进一步收窄到文件引用且宿主原生隔离可用时，可以使用父工作区的 Shell。读操作只读挂载，获准的写操作可写挂载父工作区。它复用主 Agent 的 Shell 开关、危险命令策略和当前自动模式。确认绑定子 Run，执行前复核父工作区和父子 Run 状态。Web Searcher 已接入父会话的沙盒 Shell，复用父工作区挂载、读写权限和普通或自动模式。Shell 确认要求活跃子 Run 租约和有效父子派单；确认回执绑定子 Run。物理路径目录委派、其他可委派写工具及真实确认端到端验收仍待完成。Web 文件库目录已经支持只读委派，允许搜索有效子目录中的文件，并在读取时重验目录归属。两端显式文件委派通过常驻 Shell 的 `cat -- <引用键>` 读取原文件，并继续复核引用归属。新派单持久化父工作区指纹，子 Run 启动、恢复和工具执行前复核绑定，拒绝继续使用已更换的工作区。
