# 咕咕 Agent 工程 PRD（完整版）

> **状态**：💡 设计中
> **分类**：技术架构 / 工程设计
> **创建时间**：2026-06-19

---

## 1️⃣ 产品目标（Product Goal）

咕咕是一个：

> 面向个人/小团队的"项目 + 文件 + 行为自动化 Agent 系统"

**核心能力**：

- 管理项目与文件
- 理解用户意图并拆解任务
- 自动执行可控操作
- 形成可复用 workflow
- 提供轻量"伙伴感"

---

## 2️⃣ 总体系统架构

```
                ┌──────────────────────┐
                │   Frontend (Web/App) │
                └──────────▲───────────┘
                           │
                ┌──────────┴───────────┐
                │   Agent Orchestrator │
                │  (L2 + L3 Controller)│
                └───────▲───────▲──────┘
                        │       │
        ┌───────────────┘       └───────────────┐
        │                                       │
┌───────┴────────┐                  ┌───────────┴──────────┐
│ API Execution   │                  │ Memory System        │
│ (L1 Tools)      │                  │ (Short/Long Term)    │
└───────▲─────────┘                  └───────────▲──────────┘
        │                                       │
        └──────────────┬────────────────────────┘
                       │
            ┌──────────┴──────────┐
            │ File System Engine   │
            │ (核心数据层)         │
            └──────────────────────┘
```

---

## 3️⃣ 文件系统架构（重点）

这是你整个产品的"地基"。

---

### 3.1 数据模型（核心）

#### User

```json
{
  "user_id": "u123",
  "plan": "pro",
  "storage_quota": "10GB",
  "agent_memory_quota": "1GB"
}
```

#### Project（项目）

```json
{
  "project_id": "p1",
  "user_id": "u123",
  "name": "咕咕开发",
  "status": "active",
  "color": "#A3B1FF",
  "created_at": 123456
}
```

#### File（文件核心）

```json
{
  "file_id": "f1",
  "user_id": "u123",
  "project_id": "p1",
  "type": "text | image | task | system_note",
  "name": "需求文档.md",
  "content": "...",
  "size": 12432,
  "meta": {
    "tags": ["prd", "agent"],
    "generated_by": "user | agent"
  },
  "created_at": 123456,
  "updated_at": 123456
}
```

#### Task（任务系统）

```json
{
  "task_id": "t1",
  "project_id": "p1",
  "status": "todo | doing | done",
  "title": "设计 agent 架构",
  "deadline": 123456,
  "auto_completed": false
}
```

---

### 3.2 文件层级结构（逻辑）

不是物理文件夹，而是：

```
User
 ├── Projects
 │     ├── Project A
 │     │     ├── Files
 │     │     ├── Tasks
 │     │     └── Logs
 │     └── Project B
 ├── Personal Files
 └── Archive (auto)
```

---

### 3.3 存储策略（关键）

| 类型 | 内容 | 存储 |
|------|------|------|
| 热数据 | 当前项目、最近文件、当前任务 | Redis / DB |
| 冷数据 | 已完成项目、历史文件 | OSS / S3 |

**Archive 规则**：
- 项目完成 30 天自动归档
- 文件压缩（可选）

---

## 4️⃣ Agent 系统设计

### 4.1 L1：API层（工具层）

| 文件 API | 项目 API | 系统 API |
|---------|---------|---------|
| create_file | create_project | create_reminder |
| update_file | move_task | log_event |
| delete_file | update_status | |
| search_file | | |

**原则**：

- ❌ 无智能
- ❌ 无推理
- ✅ 只执行

---

### 4.2 L2：规划层（Agent Brain）

**输入**：
- 用户输入
- 当前文件系统状态
- memory

**输出**：

```json
{
  "goal": "整理项目结构",
  "steps": [
    { "tool": "search_file", "input": "project A" },
    { "tool": "analyze", "input": "structure" },
    { "tool": "update_file", "input": "refactor result" }
  ]
}
```

**L2 能力**：
- 任务拆解
- 工具选择
- 顺序规划
- 失败重试

---

### 4.3 L3：Workflow层（体验核心）

#### Workflow 定义（DSL）

```json
{
  "workflow_id": "wf1",
  "name": "项目完成总结",
  "trigger": "task_completed",
  "steps": [
    "fetch_project_data",
    "generate_summary",
    "save_file",
    "notify_user"
  ]
}
```

#### Workflow 类型

- 自动触发
- 手动执行
- 定时任务

#### 特点

- 可生成
- 可编辑
- 可禁用
- 可复用

---

## 5️⃣ Memory系统（核心差异点）

### 5.1 三层 Memory

| 层级 | 类型 | 示例 |
|------|------|------|
| 🟢 Facts | 事实层 | `{ "user_prefers": "simple UI" }` |
| 🟡 Behavior | 行为层 | 用户常用操作、常见任务链 |
| 🔵 Ephemeral | 临时 | 当前对话上下文、当前任务状态 |

---

### 5.2 Memory处理流程

```
User Input
   ↓
Retrieve Memory
   ↓
Agent Reasoning
   ↓
Update Memory (if needed)
   ↓
Compress old memory
```

---

### 5.3 关键机制：压缩

不是无限增长，而是：

```
long-term memory = summary, not raw data
```

---

## 6️⃣ 文件 + Agent 联动机制

这是核心体验。

#### 示例

**用户说**："帮我整理这个项目"

**Agent 执行**：
1. 读取文件系统
2. 分类文件
3. 调整 task 状态
4. 写入 summary file
5. 更新 memory

#### 本质

```
文件系统 = 真数据
agent = 操作层
memory = 理解层
```

---

## 7️⃣ 多租户架构（必须）

| 层级 | 隔离方式 |
|------|---------|
| DB层 | user_id partition |
| OSS层 | `/user/{user_id}/project/{project_id}/file` |
| Memory层 | 完全 user scoped |
| Agent层 | 无跨用户 context |

---

## 8️⃣ 成本与容量模型（关键）

### 用户可见

- 文件容量（GB）
- 项目数量

### 系统隐藏

| 成本类型 | 内容 |
|---------|------|
| memory token | Token 消耗 |
| tool calls | 工具调用 |
| workflow execution | Workflow 执行 |

### 控制方式

| 控制项 | 机制 |
|--------|------|
| memory budget | 1MB → 10MB → 100MB tiers |
| agent budget | 每日 steps limit |
| workflow execution cap | 执行次数限制 |

### 关键原则

> **用户看到的是"空间"，系统控制的是"行为"**

---

## 9️⃣ 安全边界（非常关键）

### 禁止

- agent 直接执行代码
- 自由 API 拼接
- 无限循环调用工具

### 允许

- API组合
- workflow生成
- memory更新
- 受限规划

---

## 🔟 产品体验目标（最重要）

### 用户感觉

- 咕咕会帮我整理
- 会提醒我
- 会总结
- 有点"懂我"

### 实际

```
全部是 API + workflow + memory 压缩
```

---

## 🚀 最终总结（核心一句）

> **咕咕不是"自由 agent"，而是"可组合能力的受控智能系统"**

---

## 下一步建议

| 序号 | 内容 | 重要性 |
|------|------|--------|
| ① | Workflow DSL升级版（可编排图结构，不只是线性） | P1 |
| ② | agent成本控制系统（防爆token设计） | P1 |
| ③ | 文件系统 + embedding 搜索架构（性能关键） | P1 |

这三个是你进入"可规模化SaaS"的分水岭。

---

*整理时间：2026-06-19*
