# Agent 平台设计文档


> **状态**：✅ 完成
> **分类**：技术实现
> **最后更新**：2026-06-17
> **关联文档**：[Agent安全控制](./Agent安全控制.md)（「12-Tavily指南」原引用未在本仓库中，已随导入丢失，故去掉）

---

> 适用场景：文件管理与项目管理系统，通过 API 接入基础模型作为底层
> 更新时间：2026-06-17

---

## 一、行为限制（System Prompt）

### 实现方式

用 MD 文档定义基础行为规范，读取后作为 system prompt 传入 API。

```python
with open("系统行为规范.md", "r") as f:
    system_prompt = f.read()

response = model.chat(
    messages=[
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_input}
    ]
)
```

### 示例：系统行为规范.md

```markdown
# 系统行为规范.md

## 角色定义
你是一个文件管理助手，负责帮助用户管理文件和项目。

## 权限边界
- 只允许操作 /workspace 目录
- 删除文件前必须确认
- 不能执行危险命令（rm -rf /）

## 输出格式
- 使用中文回复
- 代码块必须标注语言
- 操作类任务给出执行结果摘要

## 禁止行为
- 不回答政治敏感问题
- 不生成违禁内容
- 不泄露内部系统信息
```

### 进阶玩法

- **模块化**：拆成多个 MD（权限.md、输出格式.md、角色定义.md）
- **动态加载**：根据用户权限加载不同的规范文档
- **用户级约束**：每个用户有自己的一份行为规范

---

## 二、多租户隔离

### 核心思路

- **存储层隔离**：每个用户独立的目录/数据库表
- **上下文注入**：每个请求动态加载用户记忆到 system prompt
- **对底层模型透明**：模型只看到一个完整上下文，不感知多用户

### 存储结构

```
/memory/
├── user_001/
│   ├── profile.md       # 用户个人资料
│   ├── projects/        # 项目上下文
│   └── preferences.md  # 用户偏好
├── user_002/
│   └── ...
└── user_003/
    └── ...
```

### 请求时注入上下文

```python
def chat(user_id, user_input):
    # 1. 加载用户记忆
    user_memory = load_memory(user_id)

    # 2. 构造完整 system prompt
    system_prompt = f"""
    {base_rules}  # 服务端固定的行为限制

    ## 当前用户上下文
    {user_memory}
    """

    # 3. 发给底层模型
    return model.chat(
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_input}
        ]
    )
```

### 效果示意

```
用户A（记忆：喜欢简洁）
→ 人格：文件管理助手（服务端统一）
→ 感受：话少、高效

用户B（记忆：喜欢详细）
→ 人格：文件管理助手（不变）
→ 感受：同一个助手，但讲得更细
```

**人格限制 + 用户记忆 = 互不干扰，叠加生效**

---

## 三、会话与记忆分离

### 两种记忆

| 类型 | 作用 | 生命周期 |
|------|------|---------|
| 会话历史（Session） | 只管当前对话 | 对话结束丢弃 |
| 用户记忆（Persistent） | 跨会话保留 | 永不丢失 |

### 新对话时

```python
def new_chat(user_id):
    # 加载跨会话的持久记忆
    user_memory = load_persistent_memory(user_id)

    # 构造 system prompt（带记忆）
    system_prompt = f"""
    {base_rules}
    {user_memory}
    """

    # 清空会话历史
    session_history = []

    return system_prompt, session_history
```

### 用户体验

```
用户：新建对话
Agent：（空会话，但记得你）
         ↓
用户：上次项目改完了吗
Agent：记得，你上次做的是电商后台...
         ↓
用户：新对话
Agent：（又是新开始，但记忆还在）
```

---

## 四、上下文压缩

### 问题背景

```
对话越长 → token 越多 → 费用越高 → 超过模型限制

压缩 = 把旧对话摘要，保留关键信息
```

### 压缩策略

| 策略 | 做法 | 适用场景 |
|------|------|---------|
| **摘要压缩** | 旧对话压缩成一段总结 | 保留大意，丢失细节 |
| **截断压缩** | 只保留最近 N 条 | 丢失早期内容 |
| **分层压缩** | 早期→摘要 + 最近保留 | 平衡方案（推荐） |
| **选择压缩** | 只保留关键对话 | 精准保留 |

### 实现示例

```python
# 配置参数
MAX_MESSAGES = 30        # 超过此值触发压缩
COMPRESS_RATIO = 0.3     # 保留 30% 早期对话
SUMMARY_PROMPT = "请用100字概括以下对话的核心内容："

def compress_history(messages: list) -> list:
    """对话上下文压缩"""
    
    if len(messages) <= MAX_MESSAGES:
        return messages
    
    # 计算保留数量
    keep_count = int(len(messages) * COMPRESS_RATIO)
    
    # 保留最近的消息
    recent = messages[-keep_count:]
    
    # 早期消息摘要
    early = messages[:-keep_count]
    summary = summarize_conversation(early, SUMMARY_PROMPT)
    
    # 返回压缩后的上下文
    return [
        {"role": "system", "content": f"[早期对话摘要]\n{summary}"}
    ] + recent


def summarize_conversation(messages: list, prompt: str) -> str:
    """使用 AI 生成对话摘要"""
    
    # 构造摘要请求
    content = "\n".join([
        f"{msg['role']}: {msg['content']}"
        for msg in messages
    ])
    
    response = model.chat([
        {"role": "user", "content": f"{prompt}\n\n{content}"}
    ])
    
    return response.content
```

### 分层压缩策略（推荐）

```
┌─────────────────────────────────────────────────────────────┐
│                    对话历史                                  │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  消息1 ─┐                                                   │
│  消息2 ─┼──→ 摘要 → "用户讨论了A功能，B方案"               │
│  消息3 ─┘                                                   │
│  ...                                                        │
│                                                             │
│  消息20 ─┐                                                  │
│  消息21 ─┼──→ 摘要 → "确定了C方案，开始开发D模块"          │
│  消息22 ─┘                                                  │
│  ...                                                        │
│                                                             │
│  消息N-5 ─┐                                                 │
│  消息N-4 ─┼──→ 保留（最近一轮对话）                        │
│  ...      │                                                  │
│  消息N   ─┘                                                  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
                           ↓
              ┌─────────────────────────────────┐
              │      压缩后的上下文              │
              ├─────────────────────────────────┤
              │ [摘要1] 用户讨论了A功能，B方案    │
              │ [摘要2] 确定了C方案，开始开发D模块│
              │ --- 最近一轮对话 ---             │
              │ 消息N-5                          │
              │ 消息N-4                          │
              │ ...                              │
              │ 消息N                            │
              └─────────────────────────────────┘
```

### 思维链路精简

```python
def compress_thinking(thinking_chain: str) -> str:
    """将思维链路精简为结论"""
    
    prompt = """你有一段AI思考过程：
    
    {chain}
    
    请精简为：
    1. 关键发现（1-2句）
    2. 最终结论（1句）
    
    格式：
    ## 发现
    xxx
    ## 结论
    xxx
    """
    
    return model.chat([{"role": "user", "content": prompt}])
```

### 工具调用记录压缩

```python
# 多次搜索 → 合并结果
SEARCH_RESULTS = """
搜索1: xxx → 找到3条相关内容
搜索2: xxx → 找到5条相关内容
搜索3: xxx → 无相关结果
"""

# 压缩为
COMPRESSED = """
搜索关键词：xxx, yyy, zzz
结果：找到8条相关内容（详见xxx文件）
"""
```

### 自动压缩时机

```python
class CompressTrigger:
    """压缩触发时机"""
    
    @staticmethod
    def should_compress(messages: list) -> tuple[bool, str]:
        """判断是否需要压缩"""
        
        # 1. 数量超限
        if len(messages) > MAX_MESSAGES:
            return True, "消息数量超限"
        
        # 2. Token 超限（估算）
        total_tokens = estimate_tokens(messages)
        if total_tokens > MAX_TOKENS * 0.8:
            return True, "Token 接近上限"
        
        # 3. 模型限制
        if total_tokens > MODEL_CONTEXT_LIMIT * 0.9:
            return True, "接近模型上下文限制"
        
        return False, ""
    
    @staticmethod
    def estimate_tokens(messages: list) -> int:
        """估算 token 数量"""
        # 粗略估算：中文约 2 字符 = 1 token
        total_chars = sum(len(m["content"]) for m in messages)
        return int(total_chars / 2)
```

### 用户感知处理

```python
async def chat_with_compress(user_id: str, user_input: str):
    """带压缩的对话"""
    
    messages = load_session(user_id)
    messages.append({"role": "user", "content": user_input})
    
    # 检查是否需要压缩
    should_compress, reason = CompressTrigger.should_compress(messages)
    
    if should_compress:
        # 先告知用户
        original_count = len(messages)
        messages = compress_history(messages)
        compressed_count = len(messages)
        
        # 可以选择是否告知用户压缩
        # notify = f"[上下文已压缩：{original_count}条 → {compressed_count}条]"
    
    # 发送请求
    response = model.chat(messages)
    messages.append({"role": "assistant", "content": response.content})
    
    # 保存
    save_session(user_id, messages)
    
    return response
```

### 压缩配置

```json
{
  "compress_settings": {
    "enabled": true,
    "max_messages": 30,
    "max_tokens": 30000,
    "compress_ratio": 0.3,
    "notify_user": false,
    "preserve_system_prompt": true
  }
}
```

### 不同场景配置

| 场景 | max_messages | compress_ratio | 说明 |
|------|-------------|----------------|------|
| 日常聊天 | 50 | 0.2 | 保留更多历史 |
| 项目讨论 | 30 | 0.3 | 平衡方案 |
| 长文档分析 | 20 | 0.4 | 需要更多空间 |
| 简单问答 | 100 | 0.5 | 基本不压缩 |

---

## 五、控制命令协议

### 内置命令

| 命令 | 功能 |
|------|------|
| `/newchat` | 新开对话，清空历史，**保留记忆** |
| `/reset` | 重置一切，**包括记忆** |
| `/forget <内容>` | 删除某条记忆 |
| `/remember <内容>` | 强制记住某事 |
| `/memory` | 查看当前记忆 |
| `/clear` | 只清空当前会话历史 |

### 实现示例

```python
def handle_message(user_input, user_id):
    if user_input.startswith("/"):
        return handle_command(user_input, user_id)
    return normal_chat(user_input, user_id)

def handle_command(cmd, user_id):
    if cmd == "/newchat":
        session[user_id] = []
        return "新对话开始，你的记忆保留。"

    elif cmd == "/reset":
        clear_memory(user_id)
        session[user_id] = []
        return "已清空所有记忆和会话。"

    elif cmd.startswith("/remember "):
        content = cmd[10:]
        save_memory(user_id, content)
        return f"已记住：{content}"

    elif cmd == "/memory":
        return load_memory(user_id)

    elif cmd.startswith("/forget "):
        content = cmd[8:]
        delete_memory(user_id, content)
        return f"已删除：{content}"

    elif cmd == "/clear":
        session[user_id] = []
        return "会话已清空。"
```

---

## 六、文件目录结构

### 整体结构

```
/用户ID/
├── .agent/                  # Agent专用（用户不可见）
│   ├── memory/              # 记忆文件
│   ├── sessions/            # 会话历史
│   └── config.json          # Agent配置
│
└── storage/                 # 用户可访问
    ├── projects/            # 项目文件
    │   └── 项目名/
    │       ├── 想法/        # 想法相关
    │       │   ├── 导图/    # 思维导图
    │       │   └── 其他/
    │       └── 阶段名/
    │           └── 文件
    └── 个人文件/
```

### 目录说明

| 目录 | 可见性 | 用途 |
|------|--------|------|
| `.agent/` | 用户不可见 | Agent 专用数据存储 |
| `.agent/memory/` | Agent 读写 | 用户记忆和上下文 |
| `.agent/sessions/` | Agent 读写 | 会话历史记录 |
| `.agent/config.json` | Agent 读写 | 用户个性化配置 |
| `storage/` | 用户可见 | 公开文件存储区 |

### 详细结构

```
/用户ID/
│
├── .agent/                          # ═══ Agent 专区 ═══
│   │                                 # 用户无法直接访问
│   ├── memory/                       # 记忆存储
│   │   ├── user_profile.md          # 用户基本信息
│   │   ├── preferences.md           # 用户偏好设置
│   │   └── projects/                # 项目上下文
│   │       └── 项目名.md            # 各项目上下文
│   │
│   ├── sessions/                     # 会话历史
│   │   ├── session_20240616_001.json
│   │   ├── session_20240615_001.json
│   │   └── ...
│   │
│   └── config.json                   # Agent 配置
│       {
│           "ai_model": "deepseek-v3",
│           "personality": "helpful",
│           "language": "zh-CN",
│           "reminders": []
│       }
│
└── storage/                          # ═══ 用户可见区 ═══
    │                                   # 用户可以直接浏览和操作
    ├── projects/                      # 项目文件夹
    │   └── 电商后台重构/
    │       ├── 想法/                  # 想法记录
    │       │   ├── 导图/              # 思维导图文件
    │       │   │   ├── 用户模块.mm
    │       │   │   └── 订单流程.mm
    │       │   └── 2024-06-15_优化思路.md
    │       │
    │       ├── 需求阶段/
    │       │   ├── PRD文档.pdf
    │       │   └── 竞品分析.xlsx
    │       │
    │       ├── 开发阶段/
    │       │   ├── 代码/
    │       │   └── 文档/
    │       │
    │       └── 测试阶段/
    │           └── 测试报告.md
    │
    └── 个人文件/                      # 个人资料
        ├── 简历.pdf
        └── 工作总结.docx
```

### 文件命名规范

| 类型 | 命名规则 | 示例 |
|------|---------|------|
| 会话记录 | `session_YYYYMMDD_序号.json` | `session_20240616_001.json` |
| 思维导图 | `文件名.mm` | `用户模块.mm` |
| 想法记录 | `YYYY-MM-DD_标签.md` | `2024-06-15_优化思路.md` |
| 项目文件夹 | 中文命名 | `电商后台重构/` |

---

## 七、Agent 配置文件

### config.json 结构

```json
{
  "user_id": "u12345",
  
  "ai_settings": {
    "model": "deepseek-v3",
    "temperature": 0.7,
    "max_tokens": 2000
  },
  
  "personality": {
    "style": "helpful",
    "language": "zh-CN",
    "response_length": "medium"
  },
  
  "preferences": {
    "notifications": true,
    "daily_summary": true,
    "reminder_time": "09:00"
  },
  
  "workspace": {
    "default_project": "默认项目",
    "theme": "light"
  },
  
  "created_at": "2024-06-01T00:00:00Z",
  "updated_at": "2024-06-16T10:00:00Z"
}
```

### memory/user_profile.md 示例

```markdown
# 用户资料

## 基本信息
- 姓名：张三
- 职业：产品经理
- 公司：XX科技

## 工作习惯
- 喜欢简洁的回复
- 每周五做周报
- 常用功能：项目管理、想法记录

## 项目背景
- 当前项目：电商后台重构
- 项目周期：2024.05 - 2024.08
- 团队规模：5人
```

---

## 八、架构总览

```
┌─────────────────────────────────────────────────────────────┐
│                      用户请求                                │
│                     /newchat "帮我看看项目"                 │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                    控制命令解析                              │
│              → /newchat → 清空会话，保留记忆                 │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                  上下文组装（每次请求）                       │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ System Prompt（服务端固定）                          │    │
│  │ ├── Agent 人格定义                                   │    │
│  │ ├── 权限边界                                        │    │
│  │ └── 输出格式规范                                    │    │
│  │                                                    │    │
│  │ + 用户上下文（动态注入）                             │    │
│  │ ├── .agent/memory/user_profile.md                  │    │
│  │ ├── .agent/config.json                             │    │
│  │ └── 当前项目信息                                     │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                     底层模型 API                             │
│                    （统一，不感知多用户）                     │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                      响应返回                                │
│                   "记得，你的电商项目..."                     │
└─────────────────────────────────────────────────────────────┘
```

### 文件存储架构

```
┌─────────────────────────────────────────────────────────────┐
│                      用户数据                               │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  .agent/ (Agent 专区)                                       │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  memory/         → 用户记忆、上下文                  │   │
│  │  sessions/       → 会话历史                          │   │
│  │  config.json     → 个性化配置                        │   │
│  └─────────────────────────────────────────────────────┘   │
│                         ↓                                    │
│                    Agent 读写                                │
│                         ↓                                    │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                   底层模型                            │   │
│  └─────────────────────────────────────────────────────┘   │
│                         ↓                                    │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                   响应输出                           │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  storage/ (用户可见)                                        │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  projects/       → 项目文件                          │   │
│  │  个人文件/       → 个人资料                          │   │
│  └─────────────────────────────────────────────────────┘   │
│                         ↓                                    │
│                    用户直接访问                               │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## 九、关键原则

1. **人格限制** = 服务端统一配置，模型始终遵守
2. **用户记忆** = 运行时动态注入，模型正常读取使用
3. **会话隔离** = 新对话不带历史，但保留跨会话记忆
4. **用户掌控** = 控制命令让用户管理自己的记忆
5. **目录隔离** = `.agent/` 对用户不可见，保护 Agent 数据
6. **可见性分离** = `storage/` 对用户开放，便于直接管理

---

*文档更新时间：2026-06-16*
