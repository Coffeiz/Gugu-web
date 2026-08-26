# 用户 Skill 注册与咕咕创建

> 状态：Phase 0-4 已完成
> 创建：2026-08-25
> 最近更新：2026-08-25
> 所属层：Agent / Capability Registry / User Extension
> 关联 PRD：`PRD-LLM-9-工具与Skill注册制及按需注入.md`、`PRD-LLM-10-工具调用守卫升级.md`
> 关联模块：`backend/agent/skills/`、`backend/agent/capabilities/`、`backend/agent/tools/meta.py`、资源区 / 咕咕技能

---

## 0. 摘要

为用户提供可持久化的 Skill 扩展能力。用户可以在个人设置中创建 Skill，也可以让咕咕通过工具创建 Skill。用户 Skill 与系统 Skill 使用同一套注册字段、校验规则、按需加载方式和工具权限检查，但数据来源和可见范围不同。

本阶段只开放 **Prompt Skill**，不开放用户自定义可执行 Tool。Skill 可以说明应当如何使用已有工具，但不能新增工具、提升权限、绕过确认门或直接执行代码。

核心原则：

> 用户可以定义“怎么做”，不能定义“能访问什么”。

---

## 1. 目标与非目标

### 1.1 目标

- 复用系统 Skill 的注册协议，避免出现两套 Skill 格式。
- 支持用户通过 UI 创建、编辑、启用、禁用和删除自己的 Skill。
- 支持咕咕通过 `create_skill` 创建用户 Skill。
- UI 展示当前用户有权使用的工具名称、短简介和权限状态，供 Skill 选择关联工具。
- Skill 首轮只注入简介目录，正文仍通过 `use_skill` 按需加载。
- Skill 正文使用内容指纹判断是否需要重新加载，Skill 更新后当前 session 不继续复用旧正文。
- 用户 Skill 只能在所属用户可用的工具权限范围内执行。
- 为未来的工作区 Skill、团队 Skill 和社区 Skill 保留作用域扩展空间。

### 1.2 非目标

- 本阶段不支持用户编写 Python、JavaScript、Shell 或其他可执行代码。
- 不支持用户注册新的 Tool handler、HTTP endpoint 或系统命令。
- 不允许用户 Skill 覆盖、修改或删除系统 Skill。
- 不允许用户 Skill 自行授予工具权限。
- 不在本阶段实现社区发布、审核、评分、市场和第三方包安装。
- 不改变现有 Tool 的 dispatch、确认门、权限守卫和错误反馈协议。

---

## 2. 现状与设计决策

### 2.1 系统 Skill 现状

系统 Skill 当前来自 `backend/agent/skills/*.md`，通过 frontmatter 注册 metadata，`skills_index()` 提供简介目录，`use_skill` 加载正文。系统 Skill 的工具关联关系由 `related_tools` 声明，实际工具权限仍由 Tool registry 和 dispatch 守卫负责。

### 2.2 用户 Skill 的定位

用户 Skill 是系统 Skill 的持久化来源之一，不是另一种能力类型：

```text
系统文件 Skill ─┐
                 ├─ 同一 SkillDefinition / Validator / CapabilityIndex
用户数据库 Skill ┘
                         ↓
                  use_skill 按需加载
                         ↓
                  现有 Tool 权限与确认门
```

区别只保留在来源和作用域：

| 来源 | 作用域 | 默认可见范围 | 是否可被用户修改 |
|---|---|---|---|
| `builtin` | system | 所有授权用户 | 否 |
| `user` | user | 创建者 | 是 |
| `workspace` | workspace | 后续阶段实现 | 由工作区权限决定 |

用户 Skill 与系统 Skill 使用相同的：

- 字段结构
- slug 和名称校验
- 简介长度限制
- 正文格式校验
- `related_tools` 存在性校验
- `use_skill` 加载协议
- 内容指纹
- 工具权限检查
- 启用/禁用语义

### 2.3 为什么不开放用户 Tool

用户 Tool 可能直接获得文件、网络、Shell、外部 API 或凭据访问能力。若允许用户上传 handler 或任意脚本，Skill 注册会变成代码执行入口，必须先引入沙盒、签名、权限审批和资源限制。

因此本阶段只允许：

```text
用户 Skill → 描述流程 → 调用已有 Tool → 由 Tool 自己执行权限检查
```

---

## 3. 统一注册协议

### 3.1 注册字段

用户 Skill 不使用单独格式，复用系统 Skill 的注册字段：

```yaml
slug: weather-routine
name: 我的天气查询
description_short: 查询天气并按我的格式整理出行建议
description_long: 用户询问天气、出行或穿衣建议时使用
category: personal
related_tools:
  - http_get
source: user
owner_id: <user-id>
body: <skill 正文>
enabled: true
```

实现层可以把 `slug`、`source`、`owner_id` 作为数据库字段，不要求用户手动填写全部字段。用户界面只填写：

- 名称
- 简介
- 使用场景
- 可调用工具
- Skill 正文
- 启用状态

### 3.2 字段规则

| 字段 | 规则 |
|---|---|
| `name` | 必填，用户可读，长度受限，不得伪装成系统 Skill 或 Tool |
| `slug` | 系统生成或校验，使用小写英文、数字和连字符；用户不可通过 slug 覆盖系统项 |
| `description_short` | 必填，最多 100 个 Unicode 字符，用于能力目录 |
| `description_long` | 可选，最多 500 个 Unicode 字符，用于管理页和能力详情 |
| `category` | 使用受控枚举，未知分类拒绝注册或归入 `personal` |
| `related_tools` | 只能选择当前用户可见且已注册的工具 |
| `body` | 必填，Markdown/纯文本；禁止执行代码块协议和隐藏注册指令 |
| `enabled` | 默认开启；关闭后不进入当前用户的 Skill 目录 |
| `source` | 系统生成，用户 Skill 固定为 `user` |
| `owner_id` | 系统生成，所有读写必须做 ownership 校验 |
| `content_digest` | 系统生成的内部指纹，不作为用户编辑字段 |

不增加面向用户的 `version` 字段。内容更新通过 `content_digest` 判断是否变化；需要审计时使用数据库的 `updated_at` 和变更记录。

### 3.3 注册入口

所有入口最终调用同一个服务：

```python
skill_registry.register(
    source="user",
    owner_id=user_id,
    name=name,
    description_short=description_short,
    description_long=description_long,
    category=category,
    related_tools=related_tools,
    body=body,
    enabled=True,
)
```

UI、咕咕工具、未来导入器都不能绕过该服务直接写表或直接拼 prompt。

---

## 4. 工具关联与权限模型

### 4.1 UI 显示工具目录

用户编辑 Skill 时显示当前用户可调用的工具目录：

```text
工具名             简介                         当前权限
http_get            读取公开网页                 已开启
mind_search         搜索思维笔记                 已开启
shell                执行 Shell 命令              已关闭
```

选择工具只表示该 Skill 允许建议使用这些工具，不代表授予权限。

### 4.2 权限检查顺序

```text
用户请求
  ↓
加载用户可见 Skill
  ↓
验证 Skill.related_tools 是否仍存在
  ↓
模型决定是否使用 Skill
  ↓
模型调用已有 Tool
  ↓
Tool registry Schema 校验
  ↓
用户/平台/工作区权限检查
  ↓
确认门 / 沙盒 / handler 执行
```

如果用户后来关闭了某个工具：

- Skill 仍可以保留该关联记录。
- UI 显示“当前不可用”，而不是静默删除用户配置。
- 运行时不得向模型暴露不可用工具。
- 咕咕调用时返回标准工具权限错误，并提示用户开启对应工具权限或修改 Skill。

### 4.3 安全边界

用户 Skill 不得：

- 通过正文要求调用未关联或未授权工具来绕过 registry。
- 将用户输入拼接为 Shell、SQL 或任意代码执行内容。
- 要求读取其他用户、其他 workspace 或系统目录。
- 修改系统提示词、权限配置、工具 registry 或 Skill registry。
- 伪造 `system`、`builtin`、`admin` 等来源字段。

正文是模型指导文本，不是安全边界；真正安全边界始终在 Tool dispatch 和数据 ownership 层。

---

## 5. 咕咕创建 Skill

### 5.1 工具设计

新增固定 Adapter 工具 `create_skill`，由 Agent Loop 绑定当前用户身份：

```json
{
  "name": "create_skill",
  "arguments": {
    "name": "我的天气查询",
    "description_short": "查询天气并按我的格式整理出行建议",
    "description_long": "用户询问天气或出行建议时使用",
    "category": "personal",
    "related_tools": ["http_get"],
    "body": "..."
  }
}
```

### 5.2 创建流程

1. 咕咕识别用户明确的“记住这个流程/创建一个 Skill”意图。
2. 咕咕调用 `create_skill`，不直接写文件或数据库。
3. 服务层使用统一 validator 检查字段、正文和工具关联。
4. 若关联工具包含写操作、文件、Shell 或外部通信能力，进入现有确认门。
5. 注册成功后返回 Skill 名称、简介、关联工具和启用状态。
6. 当前 Run 可以继续使用新 Skill；后续 Run 从用户 Skill Snapshot 看到它。

### 5.3 更新与删除

后续可以提供：

- `update_skill`
- `delete_skill`
- `list_user_skills`

第一版也可以先复用 UI 管理，咕咕只支持创建，避免模型在没有明确意图时改写已有 Skill。

破坏性删除必须经过确认门；删除只影响用户 Skill，不影响系统 Skill 和历史消息中的已加载正文。

---

## 6. UI 设计

入口建议放在个人设置的“能力 / 工具权限”区域，和工具权限区相邻：

```text
个人设置
├── 咕咕设置
├── 工具权限
└── 我的 Skills
```

页面功能：

- Skill 列表：名称、简介、来源、启用状态、更新时间。
- 新建 Skill：表单创建。
- 编辑 Skill：修改正文和关联工具。
- 启用/禁用：不删除内容，只影响目录注入。
- 删除：二次确认。
- 工具目录：显示工具简介、权限状态和不可用原因。
- 冲突提示：与系统 Skill 同名时提示改名，禁止覆盖。

不在用户页面展示完整系统内部 handler、路径、凭据或安全策略细节。

---

## 7. 数据模型

建议新增用户 Skill 表：

```text
user_skills
-----------
id                  bigint / uuid
owner_id            user id
slug                varchar
name                varchar
description_short   varchar
description_long    text
category            varchar
body                text
related_tools       jsonb
source              varchar default 'user'
enabled             boolean default true
content_digest      varchar
created_at          timestamp
updated_at          timestamp
```

约束：

- `(owner_id, slug)` 唯一。
- `source='user'` 时必须有 `owner_id`。
- `related_tools` 保存注册名，不保存工具 Schema 副本。
- 查询必须使用 `get_owned()` 或等价 ownership helper。
- 禁止通过用户输入的 `owner_id` 查询或修改其他用户 Skill。

Capability Index 合并顺序：

```text
builtin skills
    + 当前用户 enabled user skills
    + 后续 workspace skills
```

同名时系统 Skill 优先，用户 Skill 必须使用不同 slug；禁止 shadowing。

---

## 8. 注入与缓存

### 8.1 首轮注入

只注入用户当前可见 Skill 的 metadata：

```text
- 我的天气查询：查询天气并按我的格式整理出行建议
```

不注入用户 Skill 正文，不注入完整 Tool Schema。

### 8.2 按需加载

咕咕调用 `use_skill` 后返回正文和结构化标记：

```json
{
  "_capability_usage": {
    "kind": "skill",
    "slug": "weather-routine",
    "loaded": true,
    "content_digest": "..."
  }
}
```

后续 Run 只有在正文指纹一致时才返回 `already_loaded`。用户更新 Skill 后自动重新加载新版正文；不需要用户手动更换 Skill 名称。

### 8.3 作用域变化

用户 Skill 启用状态、工具权限、用户注销或 workspace 变化时，Capability Snapshot 必须失效并重新生成。缓存不能扩大 Skill 或 Tool 的权限范围。

---

## 9. 分阶段实施 Todo

### Phase 0：协议与安全基线

- [x] 复用系统 Skill validator，明确用户 Skill 字段映射。
- [x] 明确用户 Skill 与系统 Skill 的来源、slug 和同名冲突规则。
- [x] 完成 Tool 关联权限矩阵和危险工具确认策略；注册入口必须显式传入当前授权工具集合。
- [x] 补充用户 Skill 的 ownership 和安全测试清单。

### Phase 1：用户 Skill 持久化注册

- [x] 新增 `user_skills` 数据模型和迁移。
- [x] 实现 `SkillRegistry` 的数据库来源适配器。
- [x] 统一 builtin/user Skill 的 metadata validator。
- [x] 实现启用状态、内容 digest 和工具关联校验。
- [x] 补充跨用户隔离、同名冲突、无效工具关联和正文限制测试。

Phase 0-1 实现位置：

- `backend/app/models/__init__.py`：`UserSkill` 持久化模型及 ownership 关系。
- `backend/alembic/versions/20260825000001_add_user_skills.py`：数据库迁移。
- `backend/agent/capabilities/skill_registry.py`：统一 validator、digest、用户 metadata 适配和创建入口。
- `backend/agent/capabilities/index.py`：`from_registries_for_user()` 合并 builtin/user metadata。
- `backend/tests/test_user_skills.py`：字段、隔离、禁用、重复和 Capability 合并测试。

Phase 0-1 不处理用户 Skill 正文注入和 `use_skill` 数据库加载；运行时按需加载属于 Phase 4，避免在持久化阶段引入第二套 prompt 逻辑。

### Phase 2：资源区咕咕技能 UI

- [x] 在导航栏“资源”区域新增“咕咕技能”，位置紧跟文件库下方。
- [x] 完成技能列表、新建、编辑、启用/禁用、删除。
- [x] 接入当前用户可见的工具目录和状态，不在前端复制权限规则。
- [x] 使用现有设计令牌、`BaseModal` 和统一表单交互。
- [x] 补充前端表单校验、空状态、错误状态和保存后刷新。

Phase 2 实现位置：

- `frontend/src/views/Skills/index.vue`：页面布局、列表和页面级调度。
- `frontend/src/views/Skills/components/SkillForm.vue`：新建/编辑表单。
- `frontend/src/views/Skills/composables/useUserSkills.ts`：列表加载及增删改启用流程。
- `frontend/src/services/api.ts`：`userSkillsApi` 及前端数据类型。
- `frontend/src/components/common/AppSidebar.vue`、`frontend/src/router/index.ts`：资源区导航和路由入口。
- `backend/app/api/v1/user_skills.py`：用户隔离的 CRUD API 与工具目录 API。

### Phase 3：咕咕创建入口

- [x] 新增 `create_skill` 固定 Adapter Tool，正文只允许 Prompt/Markdown 指导文本。
- [x] 接入统一 validator、ownership、工具存在性/授权校验和危险关联工具确认门。
- [x] 返回结构化创建成功/失败结果，供各渠道复用现有工具回执。
- [x] 首版只允许创建，不开放模型自动更新或删除已有 Skill。
- [x] 将创建入口注册到统一 Meta Skill，并复用现有 Agent Loop/Web/IM dispatch 链路。

Phase 3 实现位置：

- `backend/agent/tools/meta.py`：`create_skill` 固定 Adapter Tool。
- `backend/agent/capabilities/skill_registry.py`：创建、更新、删除及统一校验服务。
- `backend/app/api/v1/user_skills.py`：与 UI 共用的 ownership/校验边界。
- `backend/tests/test_user_skills.py`：注册协议、隔离和权限相关回归测试。

### Phase 4：按需注入与变更生效

- [x] 将用户 Skill metadata 合并到 Capability Snapshot，并按当前 owner 与授权工具集合收窄关联工具。
- [x] 接入 `use_skill` 的用户 Skill 加载；正文只从当前 owner 的启用记录按需读取。
- [x] 验证更新正文后 digest 会触发重新加载，旧 history 标记不会复用旧正文。
- [x] 验证禁用 Skill 不再出现在目录且旧 session 不扩大权限。
- [x] 接入 LoopScope 的 Skill source、owner fingerprint、content digest 脱敏观测。

Phase 4 实现位置：

- `backend/agent/capabilities/models.py`：Skill metadata 的 digest 与 owner fingerprint 字段。
- `backend/agent/capabilities/index.py`、`injector.py`：按 owner 合并用户 Skill metadata，固定 Adapter 目录包含用户 Skill。
- `backend/agent/runner.py`、`backend/agent/gateway/web.py`：Web、IM、定时任务统一构建用户能力快照。
- `backend/agent/capabilities/skill_registry.py`、`backend/agent/tools/meta.py`：owner 隔离的正文按需加载。
- `backend/agent/core.py`：基于当前 snapshot digest 判断 Skill 正文是否可复用。
- `backend/agent/capabilities/diagnostics.py`、`backend/agent/runtime/loopscope_trace/hooks.py`：只记录脱敏来源、指纹和 digest。
- `backend/tests/test_user_skills.py`：目录合并、正文加载、正文更新和停用回归测试。

### Phase 5：后续扩展

- [ ] workspace Skill 作用域。
- [ ] Skill 导入/导出和备份。
- [ ] 用户分享与社区审核。
- [ ] 在沙盒基础设施完成后重新评估用户 Tool，而不是直接开放代码执行。

---

## 10. 验收标准

- 系统 Skill 和用户 Skill 能通过同一个注册协议和 validator 被读取。
- 用户只能看到和修改自己的 Skill。
- 用户 Skill 不能覆盖系统 Skill，不能注册不存在或无权使用的工具。
- 咕咕可以创建用户 Skill，但不能直接写数据库、文件或代码目录。
- Skill 正文只按需加载，更新后不会因为旧 session 标记而继续使用旧正文。
- 关闭关联工具权限后，Skill 不会绕过权限继续调用该工具。
- Web 与 IM 渠道的创建、加载、失败和确认行为一致。
- 所有用户输入、Skill 正文、工具结果和凭据遵循现有日志脱敏规则。
- 不引入用户自定义可执行代码，不改变现有 Tool dispatch 和确认门安全边界。
