# Agent 架构方案

## 定位

咕咕不是助理，是伙伴。

助理等待指令、完成任务、不留印象。伙伴记得你说过的事，注意到你的状态，在你需要之前就知道你需要什么。这个区别决定了整个 Agent 的设计方向：记忆不是功能，是核心；主动性不是增强，是基本要求。

技术上，重构现有 `app/api/v1/agent.py` 的单文件实现，支持：
- 用户记忆系统（咕咕自主观察、积累、提炼对用户的认知）
- 多平台接入（Web SSE、QQ Bot、OpenClaw 等即时通讯）
- MCP（Model Context Protocol）
- Skills 插件化
- Prompt 文件化管理
- 路由 / Profile 机制
- 事件总线

---

## 目录结构

```
backend/
├── app/                        # FastAPI 应用层
│   └── api/v1/agent.py         # 薄层：接收请求 → 调 agent.router → 返回响应
└── agent/                      # 独立 agent 包，不依赖 FastAPI
    ├── core.py
    ├── router.py
    ├── models.py
    ├── context/
    │   ├── builder.py
    │   └── loaders.py
    ├── memory/
    │   ├── manager.py
    │   ├── reflection.py
    │   ├── compressor.py
    │   └── storage.py
    ├── skills/
    │   ├── base.py
    │   ├── projects.py
    │   ├── calendar.py
    │   └── files.py
    ├── profiles/
    │   ├── base.py
    │   └── default.py
    ├── mcp/
    │   ├── client.py
    │   └── registry.py
    ├── adapters/
    │   ├── base.py
    │   ├── web.py
    │   └── qqbot.py
    ├── events/
    │   ├── bus.py
    │   └── types.py
    └── prompts/
        ├── persona.md      # 咕咕自我认知，全局共享，始终最先加载
        ├── default.md      # Web 对话 context 模板
        ├── qqbot.md        # QQ Bot profile
        └── mini.md         # 精简 profile
```

---

## 模块说明

### `core.py`
LLM 主循环。负责：
- 调用 LLM（Anthropic / OpenAI 双路统一）
- 工具调用执行与结果回填
- SSE streaming 输出
- 对话结束后 emit 事件，触发 Reflection
- 不感知平台来源、不感知 prompt 如何构建

### `router.py`
请求路由。负责：
- 根据请求来源和用户设置选择对应 Profile
- 将 `AgentRequest` 分发给正确的 Profile + Core 组合
- 未来支持按用户权限路由到不同能力集

### `models.py`
统一数据结构。定义 `AgentRequest` / `AgentResponse`，各 adapter 负责将平台格式转换为此结构。

```python
class AgentRequest:
    message: str
    user_id: UUID
    session_id: Optional[int]
    source: str  # "web" | "qqbot" | "openclaw"
```

---

### `context/`

#### `loaders.py`
文件读取层。负责：
- 从用户 `.agent/` 目录读取 prefs、facts（从 facts.json 导出）、memory
- 判断 daily / weekly / monthly 文件有效期，过滤过期文件
- 返回结构化内容块，不负责拼接

#### `builder.py`
Context 组装层。负责：
- 调用 loaders 获取各层记忆内容
- 加载对应 Profile 的 prompt 模板
- 按注入顺序拼装最终发送给 LLM 的 context
- 控制总长度，避免超出 token 限制

```python
system_prompt = await builder.build(user_id, profile="default")
```

注入顺序：
```
persona.md（含 {name}）
    ↓
summary → memory → weekly → daily → facts → preferences
    ↓
projects / calendar（实时工具数据）
```

`persona.md` 最先，定义咕咕是谁；记忆层按时间远近排列，近期信息靠后离 LLM 工作记忆更近；`projects / calendar` 最后，确保实时数据始终准确。

`persona.md` 独立于 profile，所有 profile（default / qqbot / mini）共享同一份人格，只有 context 模板不同。

---

### `memory/`

Session 和 Memory 严格分离：
- **Session**：最近聊天记录（最近 N 条消息），短期工作记忆
- **Memory**：长期认知，经过 Reflection 提炼后写入，不直接从 session 构建

```
Conversation → Reflection → MemoryManager → Storage
```

#### `reflection.py`
对话 → 结构化记忆条目的转化层。负责：
- 对话结束或消息数达阈值时，调用 LLM 判断本次对话是否有值得记住的内容
- 输出结构化条目，包含类型、内容、importance

```python
[
  { "type": "fact", "key": "current_project", "value": "咕咕", "confidence": 0.9 },
  { "type": "memory", "content": "用户偏好简洁回复", "importance": 4 },
  { "type": "daily", "content": "用户提到下周要买车", "importance": 2 }
]
```

Reflection 输出条目类型：
- `fact`：客观事实，更新 facts.json（用户在做什么项目、用什么技术栈）
- `preference`：观察到的偏好，累积进 prefs.md（喜欢简洁回复、不喜欢被追问）
- `state`：当前状态，进入 daily（今天压力大、在赶截止日）
- `memory`：值得长期记住的事，进入 daily 并标记升级候选

Importance 1~5 分级：
- 1~2：临时信息（今天吃拉面），压缩时直接丢弃
- 3：普通信息，进入 weekly 时保留
- 4：重要信息，优先进入 monthly
- 5：核心信息，考虑升级进 memory.md

#### `compressor.py`
时间层压缩，职责单一：
- `compress_daily()`：将过期 daily（>14天）压缩进对应 weekly，LLM 摘要，丢弃 importance≤2 的条目
- `compress_weekly()`：将过期 weekly（>6周）提炼进 memory.md，LLM 摘要，importance≥4 的条目优先保留

两条压缩路径，终点均为 memory.md，不设 monthly 层。

#### `manager.py`
记忆管理对外接口。负责：
- 协调 Reflection、Compressor、Storage 的调用顺序
- 对外暴露统一的 `save()`、`load()` 接口
- 每次 agent 被调用时顺带触发压缩检查

#### `storage.py`
读写层，负责实际 I/O：
- 读写 `facts.json`（结构化事实，key-value + confidence + source）
- 读写 `daily/` / `weekly/` / `memory.md` / `preferences.md`
- 读写 `summary.md`（当前状态快照）
- 导出 `facts.json` 为自然语言文本供 prompt 注入
- 未来可替换为数据库，manager 不感知底层存储方式

---

### `skills/`

#### `base.py`
Skill 基类，定义 tools 列表声明和统一执行入口，core 通过此接口调用。

#### `projects.py` / `calendar.py` / `files.py`
各功能领域工具实现，自注册到 skill registry，Profile 按需组合。

---

### `profiles/`

#### `base.py`
Profile 基类，定义技能集、prompt 模板路径、能力开关：

```python
class BaseProfile:
    skills: list[BaseSkill] = []
    prompt_file: str = "default.md"
    memory_enabled: bool = True
    mcp_enabled: bool = False
```

#### `default.py`
默认 Profile：projects + calendar skills，memory 和 events 开启。

不同场景可扩展：
- `qqbot.py`：memory_enabled=False，skills 精简
- `mini.py`：skills=[]，纯对话

---

### `mcp/`

#### `client.py`
MCP 协议客户端，支持 stdio / SSE / HTTP 连接外部 MCP server。

#### `registry.py`
动态加载 MCP server 的 tools，注册为 skill，core 视其与 native skills 完全相同。

---

### `adapters/`

#### `base.py`
Adapter 接口：`receive()` 将平台消息转为 `AgentRequest`，`send()` 将响应转为平台格式。

#### `web.py`
Web SSE adapter，对应现有接口。

#### `qqbot.py`
QQ Bot webhook adapter，接收事件，通过 QQ Bot API 回复。

---

### `events/`

全局基础设施，agent 内部所有跨模块通信通过 EventBus 解耦。

#### `types.py`
所有事件类型定义，使用类而非字符串，避免打错字、支持 IDE 跳转：

```python
class Event:
    pass

class ProjectCreated(Event):
    project_id: int

class MemorySaved(Event):
    user_id: UUID
    importance: int

class DailyCompressed(Event):
    user_id: UUID
    date: str

class SessionEnded(Event):
    session_id: int
    user_id: UUID
```

#### `bus.py`
简单异步事件总线，足够现阶段使用：

```python
class EventBus:
    def subscribe(self, event_type: type[Event], handler):
        ...

    async def emit(self, event: Event):
        ...
```

注册示例：
```python
bus.subscribe(MemorySaved, analytics_handler)
bus.subscribe(MemorySaved, achievement_handler)
bus.subscribe(ProjectCreated, notification_handler)
```

触发示例：
```python
await bus.emit(MemorySaved(user_id=..., importance=5))
```

数据流：
```
Agent Core
    ↓ emit
EventBus
    ↓
MemoryListener / AnalyticsListener / AchievementListener / NotificationListener
```

未来成就系统、行为分析、正反馈系统均挂载为 Listener，Core 不耦合任何业务逻辑。

---

### `prompts/`
Prompt 模板（`.md`），支持占位符，热更新无需重启。

- `persona.md`：咕咕的自我认知，所有 profile 共享，通过独立接口管理（`GET/PUT /admin/agent/persona`），Admin 面板中单独展示并标注「谨慎修改」
- `default.md` / `qqbot.md` / `mini.md`：各 profile 的 context 模板，通过 `GET/PUT /admin/agent/prompts/{profile}` 管理

---

## 用户个性化文件系统

每个文件回答一个独立问题，视角清晰不重叠：

| 文件 | 回答的问题 | 由谁写 |
|------|-----------|--------|
| `agent/prompts/persona.md` | 咕咕是谁？ | 开发者定义，谨慎修改 |
| `identity.json` | 用户是谁（叫什么）？ | 用户首次登录填写 |
| `facts.json` | 咕咕知道用户哪些客观事实？ | 咕咕观察写入 |
| `preferences.md` | 用户喜欢什么、习惯什么？ | 咕咕观察写入 |
| `memory.md` | 咕咕长期理解到了什么？ | Reflection 提炼写入 |
| `summary.md` | 用户现在在做什么？ | Compressor 生成 |

```
uploads/
└── {user_id}/
    ├── 个人文件/
    ├── trash/
    └── .agent/
        ├── identity.json   # 用户是谁：{ "nickname": "Jonas" }
        ├── summary.md      # 现在在做什么：当前项目、近期关注
        ├── facts.json      # 客观事实：{ "current_project": "咕咕" }
        ├── facts.md        # facts.json 的自然语言导出（只读）
        ├── preferences.md  # 用户喜好：喜欢结构化回答、直接结论
        ├── memory.md       # 长期理解：用户倾向从长期维护角度思考问题
        ├── daily/
        │   └── 2026-06-22.md
        └── weekly/
            └── 2026-W25.md
```

### summary.md

Agent 启动时优先读取的当前状态快照，格式为轻量自然语言，由 Reflection / Compressor 在适当时机更新。目的是让咕咕在每次对话开始时不需要遍历所有记忆文件，就能立刻知道用户是谁、在做什么、最近关注什么。

```markdown
用户昵称：Jonas

当前主要项目：咕咕 App

最近关注：
- Agent 架构重构
- 项目看板优化
- 文件系统缩略图

当前阶段：MVP 开发中
```

与其他文件的区别：
- `memory.md`：提炼自过去，记录「咕咕对这个人长期的认知」
- `facts.json`：结构化的客观事实，可精确查询和更新
- `summary.md`：描述「此刻」，是对当前状态的一句话快照，随时间滚动更新

更新时机：每次 Reflection 产生 importance ≥ 4 的条目时触发重新生成，由 MemoryManager 协调调用。不绑定 weekly 压缩 —— 用户切换主项目、进入新阶段等重要变化当天即反映，不等到下周。

---

### 信息来源的严格区分

用户主动提供的信息只有一处：**第一次对话时咕咕询问的昵称**，由咕咕通过 `save_identity` 工具写入 `identity.json`。不设 Onboarding 页面，不让用户填表。

其余所有信息 —— 习惯、偏好、状态、工作模式 —— 全部由咕咕通过对话观察积累，不向用户提问，不让用户填表。这是伙伴和助理的核心区别。

```json
// identity.json —— 唯一的用户输入
{ "nickname": "Jonas" }
```

### facts 更新策略

facts 不由 LLM 直接写文本，而是维护结构化 JSON，由 Reflection 通过工具调用写入：

```json
{
  "current_project":   { "value": "咕咕 App", "confidence": 0.9,  "source": "observed" },
  "tech_stack_backend": { "value": "FastAPI",  "confidence": 0.95, "source": "observed" },
  "deadline_pressure":  { "value": "高",       "confidence": 0.7,  "source": "inferred" }
}
```

- `source: observed`：用户明确说过的（「我在做咕咕」）
- `source: inferred`：咕咕从行为推断的（深夜高频操作 → 截止压力大）
- 发现新事实 → 新增 key
- 已有事实变化 → 更新 value + confidence，不追加，避免脏数据
- 导出为自然语言注入 prompt，由 storage.py 负责转换

### prefs.md

记录咕咕对用户沟通偏好的理解，由 Reflection 写入，格式为自然语言段落，不是配置项。

```
用户倾向简短直接的回复，不喜欢被引导式提问。
讨论技术细节时愿意深入，但非技术话题更偏好快速结论。
晚上工作时回复会更简单，通常处于专注状态不想被打断。
```

这不是用户的自我描述，是咕咕通过长期观察形成的判断，会随时间修正。

### 记忆文件保留期

| 文件 | 保留期 |
|------|--------|
| `identity.json` | 永久 |
| `summary.md` | 永久（importance ≥ 4 时滚动更新）|
| `facts.json` | 永久 |
| `preferences.md` | 永久 |
| `memory.md` | 永久 |
| `daily/` | 14 天，过期压缩进 weekly |
| `weekly/` | 6 周，过期提炼进 memory.md |

---

## Roadmap

### Phase 0 — 基础设施（已完成）

- [x] Admin 后台：LLM 配置、系统提示词编辑、行为配置
- [x] `prompts/default.md`：prompt 文件化，admin 可热更新
- [x] 用量统计：token 记录（`AgentUsage` 表）+ admin 统计面板

### Phase 1 — 核心重构

重构现有单文件实现，不改变对外接口，用户无感知。

- [ ] `models.py`：定义 AgentRequest / AgentResponse
- [ ] `skills/`：将现有 tools 迁出，projects / calendar skill 自注册
- [ ] `core.py`：统一 Anthropic / OpenAI 两路 LLM 循环
- [ ] `context/loaders.py` + `context/builder.py`：读取用户文件，组装 prompt
- [ ] `adapters/web.py`：现有 SSE 接口接入，对外行为不变
- [ ] `profiles/default.py`：默认 Profile，技能集 + prompt 模板

#### 昵称收集机制（在 Phase 1 重构前可直接加在现有 agent.py）

Onboarding 页面已移除。用户昵称改为由咕咕在**第一次对话**中主动询问收集：

- **触发条件**：对话前检查 `uploads/{user_id}/.agent/identity.json` 是否存在，不存在则在 system prompt 中注入指令，让咕咕在本轮主动问出昵称
- **询问逻辑**：写在 `persona.md` 中，不用代码控制——"如果不知道用户叫什么，先问昵称"
- **写入方式**：给咕咕一个 `save_identity` 工具，模型拿到昵称后自行调用，后端写入 `identity.json`

```json
// uploads/{user_id}/.agent/identity.json
{ "nickname": "Jonas" }
```

实现清单：
- [ ] `save_identity` 工具加入工具列表，后端执行时写 `identity.json`
- [ ] `_load_system_prompt` 读取 `identity.json` 填充 `{name}` 占位符
- [ ] `persona.md` 写入昵称询问指令

### Phase 2 — 记忆系统

压缩路径：daily（14天）→ weekly（6周）→ memory.md，无 monthly 层。

- [ ] 用户 `.agent/` 目录自动初始化（identity / summary / facts / preferences / memory）
- [ ] `events/bus.py` + `events/types.py`：全局事件总线
- [ ] `memory/storage.py`：facts.json + daily / weekly / memory.md 读写
- [ ] `memory/reflection.py`：对话结束后 LLM 提炼结构化条目（fact / preference / state / memory）
- [ ] `memory/compressor.py`：daily → weekly，weekly → memory.md，importance 过滤
- [ ] `memory/manager.py`：统一接口，协调 Reflection + Compressor + Storage
- [ ] summary.md 生成：Reflection 产生 importance ≥ 4 条目时触发更新

### Phase 3 — 扩展能力

- [ ] `mcp/client.py` + `mcp/registry.py`：MCP 协议支持，动态加载外部工具
- [ ] Profile 能力开关（memory_enabled / mcp_enabled）
- [ ] `router.py`：多 Profile 路由

### Phase 4 — 平台接入与伙伴深化

- [ ] `adapters/qqbot.py`：QQ Bot webhook
- [ ] OpenClaw 即时通讯接入
- [ ] 主动触达：截止日临近提醒、异常沉默感知、情绪状态关注
- [ ] 成就系统 / 正反馈系统（挂载 EventBus Listener）
- [ ] 行为分析 Listener：从操作日志提炼工作节律，写入 facts
