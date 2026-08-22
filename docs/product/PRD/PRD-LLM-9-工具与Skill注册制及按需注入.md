# 工具与 Skill 注册制及按需注入

> 状态：Phase 0 现状审查完成，Phase 1～4 待实施
> 创建：2026-08-22
> 最近更新：2026-08-22
> 所属层：Agent / Capability Registry / Prompt Assembly
> 关联模块：`backend/agent/tools/base.py`、`backend/agent/tools/__init__.py`、`backend/agent/skills/__init__.py`、`backend/agent/context/builder.py`、`backend/agent/loop_drivers.py`、`backend/agent/prompts/skills.md`
> 关联测试：`backend/tests/test_tool_schema_validation.py`、`backend/tests/test_tool_isolation.py`、LoopScope context/tool schema 相关测试

---

## 0. 实施状态

| 阶段 | 状态 | 说明 |
|---|---|---|
| Phase 0：现状审查与协议草案 | ✅ 已完成 | 已完成代码、Prompt、Provider、权限、LoopScope 和测试盘点；统一协议已形成文档草案，代码层尚未冻结。 |
| Phase 1：统一能力注册协议 | 🔲 待实施 | 增加工具与 Skill 的统一 metadata、短描述校验、来源和权限声明。 |
| Phase 2：能力目录与本地筛选 | 🔲 待实施 | 首轮只注入短描述目录，由本地 selector 根据上下文筛选候选能力。 |
| Phase 3：按需 Schema / Skill 正文注入 | 🔲 待实施 | 只为命中的工具注入完整 JSON Schema，只为命中的 Skill 注入完整操作说明。 |
| Phase 4：迁移、观测与回归 | 🔲 待实施 | 迁移现有工具和 Markdown Skill，补充 token、命中率、错误率和行为回归测试。 |
| Phase 5：插件/社区扩展 | 🔲 后续 | 在本地注册制稳定后，再开放外部包、版本、签名和隔离加载。 |

### 0.1 现状审查结论（2026-08-22）

本次审查覆盖工具注册、Skill 加载、Profile、Prompt 组装、Provider Driver、权限过滤、LoopScope 和现有测试。结论如下：

| 领域 | 当前实际状态 | 对本 PRD 的影响 |
|---|---|---|
| 工具注册 | `agent.tools.base.SkillRegistry` 已能注册 `Tool`、按领域 Skill 聚合、校验 JSON Schema、生成 OpenAI/Anthropic Schema、统一 dispatch。 | 可以复用执行注册表，但它目前只是工具执行 registry，不是统一 Capability Registry。 |
| 工具 metadata | 当前 `Tool` 有 `name`、完整 `description`、`input_schema`、handler、`destructive`、`mutates`、`start_message`；没有 `description_short`、category、source、version、关联 Skill。 | 88 个默认工具都需要补短描述或生成迁移报告；不能把现有完整 description 直接当成 100 字符短描述。 |
| 默认工具规模 | `DefaultProfile` 当前启用 17 个工具组，共 88 个工具；OpenAI Schema 序列化约 62,178 字符，Anthropic 约 59,626 字符。 | “每轮减少 80k 字符”不能作为固定承诺；可确认的是当前每轮会重复注入约 60k 字符的工具 Schema，另有消息、记忆和 Skill 文案。 |
| Skill 注册 | `agent/skills/*.md` 通过 frontmatter 扫描，`skills_index()` 返回 `slug/name/when/emoji`；`use_skill` 按需加载正文。 | 已有“Skill 正文渐进式加载”，但 metadata 仍使用 `description`/`when` 兼容字段，且没有统一 registry。 |
| Skill 规模 | 默认 Profile 启用 9 个 Markdown Skill；其中 `project-planning` 和 `scheduled-tasks` 的触发描述超过 100 字符。 | 需要先收敛短描述，再执行 100 字符校验；不能直接把现有 `when` 全部改名而不改文案。 |
| Profile | `BaseProfile.tool_names` 通过工具组展开；`skills` 是独立 slug 列表。 | 当前存在两套能力声明，Phase 1 要增加 adapter，而不是立即删除 Profile。 |
| Prompt 组装 | `builder._skills_index_block()` 会把 9 个 Skill 的索引放进静态 Prompt；常驻 `prompts/skills.md` 还维护主动指针；完整工具 Schema 不由 builder 生成。 | Skill 短目录、常驻指针和工具 Schema 需要明确职责，避免三处重复描述同一能力。 |
| Schema 注入 | `AnthropicDriver`、`OpenAIDriver`、`OllamaDriver` 都调用 `registry.*_schemas(tool_names)`；`tool_names` 来自 Profile 加 IM 白名单和 shell 过滤，没有 selector。 | Phase 3 的真正改造点在 runner/driver 之间的调用契约，不是只改 Prompt builder。 |
| 权限 | IM 入口通过 `filter_tool_names()` 做模型可见工具裁剪，dispatch 再通过 `can_use_tool()` 做第二道检查；shell 还有工作区过滤。 | Capability selector 必须复用现有权限结果，不能自行复制权限逻辑或仅靠隐藏目录实现安全控制。 |
| Skill 与工具关联 | 目前主要依赖 `prompts/skills.md` 的主动指针和 Skill 正文中的手写工具名；工具 registry 只记录“工具组 → 工具名”，不记录 Markdown Skill 关联。 | 需要先建立关联 metadata，再逐步删除重复指针；关联错误必须在启动/快照构建时暴露。 |
| LoopScope | 已有 `LLM round` 的 `tool_count`、Schema 字节数、估算 token 和 digest；另有独立的 `Tool schemas injected` context span。 | 观测层已有基础，但它记录的是当前全量 Schema，不代表“已筛选”；Phase 4 需要新增 catalog/selected/omitted 指标。 |
| 测试 | 已覆盖 Tool JSON Schema 注册/dispatch、Provider Schema 保持不变、Skill/Prompt 语言的部分回归、LoopScope Schema 诊断；没有 Capability Registry、selector、按需注入和遗漏扩展测试。 | Phase 1～4 都需要新增测试，不能以现有工具契约测试代替。 |

因此，当前最小可行路线不是一次性替换 Profile，而是：

```text
现有 Tool/Skill → Capability Adapter → 统一快照 → shadow selector
    → 只观测不改注入 → 按 Provider 切换按需 Schema
```

---

## 1. 背景与目标

### 1.1 当前问题

当前工具和 Skill 有两套并行组织方式：

- 工具由 `BaseSkill` 聚合，工具实例进入全局 `SkillRegistry`，并能生成 Anthropic/OpenAI 两种 Schema。
- Skill 是 `backend/agent/skills/*.md`，通过 frontmatter 解析 `name`、`description`/`when`，由 `skills_index()` 提供索引，再通过 `use_skill` 加载正文。
- `builder.py` 会把常驻提示词、Skill 索引和动态上下文组装到 Agent 上下文。
- 当前完整工具 Schema 会按 profile 组合后进入模型请求。工具 Schema 数量较多时，每轮都会重复传输大量参数定义。

这带来几个问题：

1. 工具和 Skill 缺少统一的能力发现协议，未来插件无法只依赖一个入口注册能力。
2. 首轮上下文需要携带大量模型暂时用不到的完整 Schema。
3. Skill 的触发描述、工具的 description、权限和关联关系分散在不同位置。
4. 无法清楚观测“目录大小、候选命中、完整 Schema 注入、最终调用”各阶段的 token 成本。
5. 外部社区若要贡献能力，需要理解多套隐式约定，容易出现重名、缺短描述、权限漏声明和 Schema 不合法。

### 1.2 目标

建立统一的 **Capability Index（能力索引）**，同时保留工具和 Skill 各自独立、细粒度的注册表：

- 工具和 Skill 都通过注册协议暴露元数据。
- 每个能力必须提供不超过 100 字符的短描述，用于首轮能力目录和 UI 展示。
- 首轮只注入短描述目录，不默认注入全部完整工具 Schema 和 Skill 正文。
- 本地 selector 结合用户输入、当前会话、权限、平台和工作区筛选候选能力。
- 命中后按需注入完整工具 Schema、Skill 正文及其关联关系。
- 保留现有 Agent Loop、工具校验、确认门和 handler 执行边界，不把能力筛选变成隐藏业务编排。
- 为未来插件/Skill 社区提供稳定、可校验、可观测的注册接口。
- 注册表原子单位是单个工具或单个 Skill，不是当前的领域工具组 `BaseSkill`。

### 1.3 非目标

- 本 PRD 不重写工具 handler、数据库服务层或权限实现。
- 本 PRD 不要求每个请求额外调用一次 LLM；默认 selector 使用本地规则和 metadata。
- 本 PRD 不把能力筛选等同于 Plan 模式。多步骤规划仍由 Agent Loop 或未来的 Plan 模块负责。
- 本 PRD 不在首版开放任意第三方代码热加载、任意 shell、任意网络权限或自动安装插件。
- 本 PRD 不删除现有完整 Schema；Schema 仍是执行契约，只改变其注入时机。

---

## 2. 核心概念

### 2.1 Capability

Capability 是模型可以发现或调用的一项能力，分为两类：

| 类型 | 作用 | 是否有执行 Schema |
|---|---|---|
| `tool` | 可被模型直接调用的函数，例如 `image_search`、`mind_search_canvas` | 有，必须提供 JSON Schema |
| `skill` | 一组操作规则、流程和工具使用约束，例如“联网搜索”“思维画布” | 无直接函数 Schema，可关联工具并按需加载正文 |

二者共享注册 metadata，但不强行共享 handler。Skill 可以声明关联工具，工具也可以声明所属 Skill。

### 2.2 注册表粒度

注册表拆成两个独立的细粒度注册表，再由统一索引合并：

```text
单个工具声明 → ToolRegistry
单个 Skill 声明 → SkillRegistry
                     ↓
              CapabilityIndex
                     ↓
       selector / injector / Admin / LoopScope
```

设计约束：

- `ToolRegistry` 的原子项是一个 `ToolDefinition`，例如 `list_projects`、`create_project`、`image_search`。
- `SkillRegistry` 的原子项是一个 `SkillDefinition`，例如 `web-search`、`image-analysis`。
- `CapabilityIndex` 只负责合并、查询和生成不可变快照，不复制 handler、Schema 或 Skill 正文。
- 一个工具可以关联多个 Skill；一个 Skill 可以关联多个工具；关联只影响发现和注入，不改变工具权限。
- 工具组、领域模块和 Profile 是筛选输入，不是能力注册项。

现有 `BaseSkill` 的最终定位：

- 迁移期继续作为 Python 工具模块的批量导入/组织方式。
- `BaseSkill.name` 只作为内部 domain/group 标识，不进入模型能力目录。
- `BaseSkill.tools` 中的每个 `Tool` 必须逐个进入 `ToolRegistry`。
- 完成迁移后，避免继续使用 `SkillRegistry` 这个旧名称同时表示“工具组注册表”和“模型 Skill 注册表”。

### 2.3 短描述与完整描述

- `description_short`：必填，最多 100 个 Unicode 字符，用于能力目录、首轮 Prompt 和管理界面。
- `description`：可选的完整模型说明。工具的完整说明继续进入 provider tool schema；Skill 的详细说明保存在正文或资源文件中。
- 短描述必须回答“能做什么、什么时候使用”，不能只写分类名或内部实现名。

示例：

```text
image_search：按文字或图片搜索相关图片。
mind-canvas：用户要查看、搜索、创建、整理或连接思维画布节点时使用。
```

### 2.4 能力路由不是 Plan

能力路由只回答“本轮可能需要哪些能力”：

```text
用户输入 → 能力目录 → 本地筛选 → 注入候选 Schema/Skill 正文 → Agent Loop
```

Plan 模式回答“任务要拆成哪些步骤以及如何按依赖执行”。两者可以组合，但不能把本地能力筛选命名为 Plan，避免后续职责混淆。

---

## 3. 功能需求

### FR-REG-1：细粒度工具与 Skill 注册协议（🔲 待实施）

所有工具和 Skill 必须通过各自独立的注册表注册，再由统一能力索引提供跨类型查询。注册 API 可以保持一致，但注册表不能把工具组和 Skill 混为同一个原子项。

建议内部模型：

```python
from dataclasses import dataclass, field
from typing import Literal


@dataclass(frozen=True)
class CapabilityMeta:
    name: str
    kind: Literal["tool", "skill"]
    description_short: str
    category: str
    version: str = "1"
    permissions: tuple[str, ...] = ()
    platforms: tuple[str, ...] = ()
    related_tools: tuple[str, ...] = ()
    source: str = "builtin"
    enabled: bool = True
```

注册期必须校验：

- `name` 非空且全局唯一。
- `kind` 只能是 `tool` 或 `skill`。
- `description_short` 非空且长度不超过 100 个 Unicode 字符。
- `version`、`category`、`source` 格式合法。
- `related_tools` 中的工具在最终 registry 构建完成后可解析；允许分阶段注册，但启动完成前必须报告孤儿引用。
- 工具仍必须通过现有 JSON Schema、handler callable 和 destructive/mutates 契约校验。
- Skill 的正文文件可以延迟读取，但 metadata 不能缺失。

建议对外入口：

```python
tool_registry.register(tool_definition)
skill_registry.register(skill_definition)
capability_index = CapabilityIndex.from_registries(tool_registry, skill_registry)
```

禁止让业务模块直接修改 `CapabilityIndex` 内部字典；索引只能从两个注册表重新构建或生成新快照。

### FR-REG-2：工具注册 metadata（🔲 待实施）

现有 `Tool` 增加或映射以下字段：

```python
Tool(
    name="image_search",
    description="完整工具说明……",
    description_short="按文字或图片搜索相关图片。",
    input_schema=IMAGE_SEARCH_SCHEMA,
    handler=handler,
    category="search",
    permissions=("network",),
    related_skills=("web-search", "image-analysis"),
)
```

`description_short` 与完整 `description` 分离：

- 短描述进入能力目录。
- 完整描述只在工具 Schema 被选中时进入 provider 请求。
- 现有 `to_anthropic()`、`to_openai()` 的 Schema 结构保持不变，避免影响 provider 适配层。

### FR-REG-3：Skill 注册 metadata（🔲 待实施）

现有 Markdown frontmatter 逐步统一为：

```yaml
---
name: 联网搜索
description_short: 查资料、新闻、官网事实、研究比较和图片搜索时使用。
category: search
version: "1"
permissions: network
related_tools: web_search,deep_research,image_search
source: builtin
---
```

迁移期兼容：

- `description_short` 优先。
- 旧 `description` / `when` 作为临时别名解析。
- 启动诊断中标记旧字段使用情况。
- 完成迁移后删除旧字段兼容，不再在运行时静默猜测。

### FR-REG-4：首轮注入能力目录（🔲 待实施）

首轮 Agent 上下文只注入当前可用能力的短描述，不注入完整工具 Schema 或所有 Skill 正文。

目录内容最小化为：

```text
## 可用能力
- image-analysis：识别、比较图片；需要查找来源或相似图时使用。
- web-search：查找外部资料、新闻、官网事实和图片。
- image_search：按文字或图片搜索相关图片。
- mind-canvas：搜索、创建、整理或连接思维画布节点。
```

目录必须经过以下过滤：

1. 全局 admin 开关和用户权限。
2. 当前平台能力，例如 IM、Web、桌面端差异。
3. 当前会话工作区、项目、画布或附件是否可用。
4. 能力自身的 `enabled` 状态。

未通过过滤的能力不能进入模型目录，避免模型尝试调用必然被拒绝的工具。

### FR-REG-5：本地能力筛选（🔲 待实施）

默认不增加 LLM 请求，由本地 selector 计算候选能力：

- 关键词和类别匹配。
- 当前消息附件类型匹配。
- 当前会话来源、权限、工作区和平台匹配。
- Skill 关联工具展开。
- 当前 Agent 已经使用过的工具保持在候选集合中，避免下一轮失去必要 Schema。

筛选结果限制：

- 默认最多 8 个 Skill 和 12 个工具。
- 每个候选工具必须满足权限和上下文约束。
- 置信度低时允许保留一个小型通用工具集合，但不得退化为全部工具 Schema。
- selector 只负责候选能力，不执行 handler、不改变数据库状态、不代替 Agent 规划。

### FR-REG-6：按需注入完整工具 Schema（🔲 待实施）

正式 Agent Loop 只接收候选工具的完整 provider Schema：

```text
短描述目录
  ↓
本地 selector 选出 image_search、web_search
  ↓
注入这两个工具的完整 Schema
  ↓
模型生成 tool call
  ↓
现有 registry.dispatch() 校验并执行
```

要求：

- 候选 Schema 使用 ToolRegistry adapter 复用当前 `SkillRegistry.openai_schemas()` / `anthropic_schemas()` 的 provider 格式；迁移完成后再把 Schema 序列化职责移入 ToolRegistry，不复制实现。
- 不改变 `dispatch()` 的 schema 校验、权限、确认门和事务边界。
- 如果模型请求了未注入但已注册的工具，返回结构化 `tool_not_loaded`，由下一轮 selector 扩展候选后重试。
- 如果模型传入了不存在的工具名，继续返回现有未知工具错误。
- Schema 缓存按 `tool name + version + api_format` 计算 digest，避免每轮重复序列化。

### FR-REG-7：按需加载 Skill 正文（🔲 待实施）

Skill 首轮只注入短描述。命中后加载正文：

- 可由本地 selector 直接命中并注入。
- 也可由现有 `use_skill` 工具显式加载。
- 同一轮只加载一次，相同 `slug + version` 使用缓存。
- Skill 正文中的工具名必须来自 registry，启动或加载时校验孤儿引用。
- Skill 正文不能绕过工具权限、确认门和 Schema 校验。

### FR-REG-8：能力与权限统一（🔲 待实施）

注册 metadata 只声明所需权限，不授予权限。实际权限仍由现有权限层决定：

```text
registry metadata.permissions
        ↓ 仅作为筛选条件
can_use_tool / admin 开关 / user setting
        ↓ 最终判定
dispatch / handler
```

特别要求：

- `destructive`、`mutates` 继续保留在工具契约中，不合并成模糊的 `permissions`。
- `shell` 等高风险工具必须同时声明 capability permission 和现有确认/工作区约束。
- 被权限过滤的能力不应只在目录里隐藏；如果模型仍然请求，后端仍必须拒绝。

### FR-REG-9：LoopScope 记录能力注入过程（🔲 待实施）

LoopScope 增加独立 context span，记录元数据而不是完整 Schema/用户内容：

```json
{
  "kind": "context",
  "name": "Capability catalog injected",
  "capability_count": 18,
  "selected_tool_count": 4,
  "selected_skill_count": 2,
  "catalog_chars": 2140,
  "schema_chars": 9820,
  "schema_tokens_estimate": 3200,
  "digest": "..."
}
```

不得记录：

- 完整工具参数值。
- 用户原始消息、附件名、Skill 正文中的敏感业务内容。
- token、密钥、工作区绝对路径。

### FR-REG-10：注册信息可供插件与管理页使用（🔲 后续）

注册表应能输出脱敏的能力目录，供 Admin 和未来插件市场使用：

- 名称、类型、短描述、类别、版本、来源。
- 是否启用、需要的权限类别、关联工具名称。
- Schema digest，不直接暴露 handler、内部路径或凭据。

外部插件首版只允许显式安装和显式启用，不允许通过模型或远程内容自动注册。

---

## 4. 技术方案

### 4.1 推荐模块划分

新增统一模块，建议放在 `backend/agent/capabilities/`：

```text
backend/agent/capabilities/
├── __init__.py          # 对外注册入口
├── models.py            # CapabilityMeta、CapabilityRef、SelectedCapabilities
├── tool_registry.py     # 单个 ToolDefinition 注册与校验
├── skill_registry.py    # 单个 SkillDefinition 注册与正文加载索引
├── index.py             # 合并两个注册表，生成 CapabilityIndex/快照
├── selector.py          # 本地筛选，不执行工具
├── injector.py          # 目录、Schema、Skill 正文注入
├── diagnostics.py       # digest、字符数、token 估算、LoopScope metadata
└── errors.py            # 注册期和加载期错误
```

职责边界：

- `agent.tools.base.SkillRegistry` 在迁移期继续负责工具执行契约；`ToolRegistry` 通过 adapter 读取单个工具，不复制 handler 和 Schema 校验逻辑。
- `agent.skills` 继续负责 Markdown 解析和正文加载；`SkillRegistry` 读取单个 Skill metadata，不复制正文加载逻辑。
- `CapabilityIndex` 只合并两个注册表的 metadata 和关联引用，不承载业务 handler。
- `selector.py` 不调用 LLM、不执行 handler、不写数据库。
- `injector.py` 不决定权限，只接收已经过滤的候选集合。
- `dispatch()` 仍是唯一工具执行入口。

### 4.1.1 文件级改动清单

以下清单以当前代码为基线，区分新增文件、需要改动的文件和明确不应改动的文件。实现时按 Phase 更新状态，避免只新增注册表却遗漏真实注入链路。

#### 新增文件

| 文件 | 阶段 | 职责 |
|---|---|---|
| `backend/agent/capabilities/__init__.py` | Phase 1 | 暴露能力注册、快照和筛选的稳定入口。 |
| `backend/agent/capabilities/models.py` | Phase 1 | 定义 `CapabilityMeta`、`CapabilityRef`、`CapabilitySnapshot`、`SelectedCapabilities`。 |
| `backend/agent/capabilities/tool_registry.py` | Phase 1 | 注册单个工具 metadata，校验工具名、Schema、handler 和短描述。 |
| `backend/agent/capabilities/skill_registry.py` | Phase 1 | 注册单个 Markdown Skill metadata，管理正文 loader 和短描述。 |
| `backend/agent/capabilities/index.py` | Phase 1 | 合并两个细粒度注册表，校验跨表关联并生成不可变能力快照。 |
| `backend/agent/capabilities/selector.py` | Phase 2 | 根据已授权能力、平台、附件、工作区、类别和用户消息做本地候选筛选。 |
| `backend/agent/capabilities/injector.py` | Phase 2～3 | 生成短描述目录、选择后的工具 Schema 和按需 Skill 正文。 |
| `backend/agent/capabilities/diagnostics.py` | Phase 2～4 | 计算字符数、Schema digest、token 估算和 LoopScope 注入元数据。 |
| `backend/agent/capabilities/errors.py` | Phase 1 | 定义注册失败、关联缺失、能力未加载等结构化错误。 |
| `backend/tests/test_capability_registry.py` | Phase 1 | 注册契约、metadata、旧字段迁移和关联校验。 |
| `backend/tests/test_capability_selector.py` | Phase 2 | 本地 selector 的权限、平台、附件、工作区和候选上限测试。 |
| `backend/tests/test_capability_injection.py` | Phase 2～3 | 目录、完整 Schema、Skill 正文按需注入和未加载工具扩展测试。 |

#### 需要修改的现有文件

| 文件 | 阶段 | 改动范围 |
|---|---|---|
| `backend/agent/tools/base.py` | Phase 1 | 给 `Tool` 增加能力 metadata；保留现有 Schema validator、`to_openai()`、`to_anthropic()` 和 `dispatch()` 语义；由 adapter 提供给 Capability Registry。 |
| `backend/agent/tools/__init__.py` | Phase 1 | 在现有工具导入完成后触发能力快照构建或显式注册，不复制各工具 handler 清单。 |
| `backend/agent/skills/__init__.py` | Phase 1～4 | 将 Markdown frontmatter 解析统一为 `description_short` 等 metadata；迁移期保留旧 `description/when` 诊断，完成后删除兼容解析。 |
| `backend/agent/skills/*.md` | Phase 1 | 为 9 个内置 Skill 补齐短描述、类别、版本、来源和关联工具；收敛过长文案。 |
| `backend/agent/profiles/base.py` | Phase 1～2 | 保留旧 `tools/skills` 配置作为输入适配；增加从 Profile 生成授权 Capability 视图的入口，避免立即删除存量配置。 |
| `backend/agent/profiles/default.py` | Phase 1～2 | 补充默认 Profile 的能力类别/上下文声明；不再新增扁平工具名清单。 |
| `backend/agent/context/builder.py` | Phase 2～3 | 移除或收敛独立 Skill 目录拼装，改调用 Capability Injector；保留 persona、policy、记忆和业务上下文职责。 |
| `backend/agent/prompts/skills.md` | Phase 2～4 | 保留少量不可遗漏的行为规则；删除与注册 metadata 重复的能力目录描述，避免短描述、主动指针和 Skill 索引三处漂移。 |
| `backend/agent/tools/meta.py` | Phase 2～3 | 让 `use_skill` 从 Capability Registry 校验和加载 Skill，保留正文返回格式和错误语义。 |
| `backend/agent/im/permissions.py` | Phase 2 | 提供统一的“已授权能力视图”；复用现有白名单和 dispatch 二次权限门，不在 selector 中复制权限判断。 |
| `backend/agent/runner.py` | Phase 2～3 | 在构造 `LLMRunner` 前完成能力筛选和注入上下文传递；处理候选扩展、`tool_not_loaded` 和 emergency switch。 |
| `backend/agent/core.py` | Phase 3 | 保持 Agent Loop 控制流，只适配新的 selected tool context；不把 selector 逻辑塞进 handler/loop 分支。 |
| `backend/agent/loop_drivers.py` | Phase 3 | Anthropic/OpenAI/Ollama Driver 读取 selected tools；保留 provider Schema 转换、缓存和流式行为。 |
| `backend/agent/runtime/loopscope_trace/context.py` | Phase 2～4 | 记录能力目录、候选筛选和 Skill 正文来源，不重复记录完整 Schema。 |
| `backend/agent/runtime/loopscope_trace/hooks.py` | Phase 2～4 | 记录 selector 耗时、候选数量、Schema 注入大小、未加载工具扩展和 digest。 |
| `backend/agent/runtime/loopscope_trace/utils.py` | Phase 2～4 | 扩展脱敏的能力注入诊断和 token/字符估算，禁止记录用户原文和完整 Schema。 |
| `backend/tests/test_loop_driver_vision.py` | Phase 3 | 增加三类 Provider 对 selected Schema 的 parity 回归。 |
| `backend/tests/test_core_loop_characterization.py` | Phase 3 | 验证新工具上下文不改变共享 Agent Loop、核验、重试和工具调用顺序。 |
| `backend/tests/test_tool_schema_validation.py` | Phase 1～3 | 增加 registry adapter、未加载工具和按需 Schema 不影响 dispatch 校验的测试。 |
| `backend/tests/test_agent_prompt_language.py` | Phase 2～4 | 验证短描述目录、Skill 主动规则和不泄露内部能力名的 Prompt 约束。 |

#### 明确不应改动职责的文件

| 文件/区域 | 原因 |
|---|---|
| `backend/agent/tools/*.py` 的业务 handler | 只补 metadata，不把 selector、目录生成或能力路由逻辑写进业务工具。 |
| `backend/agent/tools/tool_contract.py` | 继续作为 JSON Schema validator 的单一事实源；注册制不复制实例校验。 |
| `backend/agent/security/confirm.py` 及 destructive 工具确认链 | 注册 metadata 只用于筛选，不能替代确认门。 |
| `backend/app/services/**`、数据库模型和工具业务 Service | 本 PRD 不改变业务数据模型，不为能力注册新增用户数据表。 |
| Provider 各自的 HTTP/SDK 适配器 | 只由 `loop_drivers.py` 传入选定 Schema，不把能力注册逻辑下沉到供应商适配器。 |

#### 文件改动完成判定

- 🔲 新增文件全部有单元测试和模块级 docstring。
- 🔲 现有工具业务文件只出现 metadata 增量，不出现 selector/import 循环。
- 🔲 `runner.py`、`core.py`、`loop_drivers.py` 的工具执行职责边界保持清晰。
- 🔲 删除旧目录生成逻辑前，先确认 Capability Injector 已覆盖 Web、IM、定时任务和 LoopScope。
- 🔲 每个删除项在 PRD Phase 4 和 `docs/devlog.md` 留有迁移记录。

### 4.2 注册顺序

```text
导入内置工具
  ↓
工具注册到现有 SkillRegistry
  ↓
Capability Registry 读取/适配工具 metadata
  ↓
扫描 Markdown Skill frontmatter
  ↓
校验 related_tools / related_skills
  ↓
构建不可变能力快照
  ↓
每轮 selector 使用该快照
```

能力快照按 `registry_generation` 标识。开发环境支持文件变更后重新加载，生产环境默认在进程启动时构建并缓存。

### 4.3 上下文组装流程

```text
用户消息 / 当前状态
        ↓
Context Builder 生成静态提示词和动态上下文
        ↓
Capability Selector 过滤并选出候选工具/Skill
        ↓
Capability Injector 注入短目录
        ↓
Provider Adapter 注入候选工具完整 Schema
        ↓
Agent Loop
        ├─ tool call → registry.dispatch()
        ├─ use_skill → 加载 Skill 正文
        └─ tool_not_loaded → 扩大候选并重试一次
```

首版不强制增加独立 LLM 选择轮。若未来本地 selector 命中率不足，可以增加一个关闭深度思考、低 token 的 capability routing 请求，但它是可选优化，不是注册制的前置依赖。

### 4.4 预算与收益指标

每轮分别统计：

| 指标 | 含义 |
|---|---|
| `catalog_chars` | 短描述目录字符数 |
| `schema_chars` | 实际注入完整工具 Schema 字符数 |
| `skill_chars` | 实际注入 Skill 正文字符数 |
| `selected_tools` | 候选工具数量 |
| `selected_skills` | 候选 Skill 数量 |
| `tool_not_loaded` | 模型请求未注入工具的次数 |
| `route_latency_ms` | 本地 selector 耗时 |
| `schema_tokens_estimate` | Schema 估算 token 数 |
| `provider_input_tokens` | provider 返回的实际输入 token，若可用 |

首版验收目标：

- 首轮不再默认注入 profile 中全部工具完整 Schema。
- 常见单能力任务的完整 Schema 注入字符数比基线减少 60% 以上。
- 本地 selector P95 小于 5ms，不产生额外网络请求。
- `tool_not_loaded` 重试率低于 2%。
- 工具调用成功率、确认门拦截率和 mutation 行为不低于迁移前基线。

### 4.5 缓存策略

- Capability metadata 按 `registry_generation` 缓存。
- 短目录按“能力集合 + 平台 + 权限视图”缓存。
- 工具 Schema 按“工具名 + 版本 + provider 格式”缓存序列化结果。
- Skill 正文按“slug + 版本”缓存，开发环境支持文件 mtime 失效。
- 任何权限变化必须使 selector 结果失效，不能复用旧的候选集合。

### 4.6 错误处理

| 错误 | 行为 |
|---|---|
| 注册重名 | 启动期失败，明确报告来源和冲突名称 |
| 短描述缺失/超长 | 内置能力启动失败；外部插件拒绝加载 |
| related tool 不存在 | 能力快照构建失败或标记该 Skill 不可用，不静默注入残缺 Skill |
| selector 无候选 | 保留最小通用目录或走现有全局能力策略，但记录诊断，不注入全部 Schema |
| 模型调用未加载工具 | 返回 `tool_not_loaded`，扩展候选并最多自动重试一次 |
| Skill 正文加载失败 | 返回结构化能力加载错误，不执行关联工具 |

---

## 5. 迁移计划

### Phase 1：协议和适配层

实施文件范围：`backend/agent/capabilities/`、`backend/agent/tools/base.py`、`backend/agent/skills/__init__.py`、`backend/agent/skills/*.md`、`backend/tests/`。

- 🔲 新增 `CapabilityMeta`、`CapabilityRef`、`CapabilitySnapshot` 和注册期错误模型。
- 🔲 新增 Tool adapter：从现有 `Tool` 读取 metadata，不复制 handler、Schema validator 或 dispatch。
- 🔲 给 `Tool` 增加 `description_short`、`category`、`permissions`、`version`、`source`、关联 Skill 字段。
- 🔲 先为 88 个默认工具建立短描述清单；禁止用完整 description 自动截断生成正式文案。
- 🔲 为 9 个默认 Markdown Skill 增加 `description_short`，先处理超过 100 字符的 `project-planning`、`scheduled-tasks`。
- 🔲 保留 `description` / `when` 兼容解析，但输出 warning/diagnostic，统计剩余旧字段数量。
- 🔲 建立 registry generation，启动时一次性校验重名、短描述长度、孤儿关联和版本格式。
- 🔲 测试：注册失败、旧字段迁移、Unicode 长度、工具 adapter 与现有 Provider Schema 完全等价。

完成标准：所有内置能力都有明确短描述，Capability 快照可以构建；现有 Agent Loop 的工具执行路径和 Schema 输出不变。

### Phase 2：目录与本地 selector

- 🔲 从 `DefaultProfile`、IM 白名单、shell 工作区过滤结果构建统一候选输入。
- 🔲 把现有 `filter_tool_names()` 和 `_filter_shell_tool()` 的结果作为 selector 前置条件，避免复制权限逻辑。
- 🔲 实现本地规则 selector：类别、关键词、附件类型、平台、会话状态、工作区和已调用工具关联。
- 🔲 设定默认候选上限：Skill 8 个、工具 12 个；上限必须可配置并记录实际值。
- 🔲 将短描述目录作为独立 context block 注入。
- 🔲 保持完整 Schema 全量注入，进入 shadow mode；只记录“本次 selector 会选哪些”，不改变行为。
- 🔲 LoopScope 新增 `capability_catalog` 和 `capability_selection` 元数据：数量、字符数、候选名 digest、耗时、过滤原因统计。
- 🔲 新增 selector 单测和 20～50 个虚拟能力的性能基准，验证 P95 小于 5ms。
- 🔲 用真实多场景样本评估漏选率：天气、图片、文件、画布、shell、定时任务、群聊权限、多步骤任务。

完成标准：shadow mode 下能稳定解释每个候选能力为什么入选或被过滤；不改变现有工具调用结果。

### Phase 3：按需注入

- 🔲 把 `LLMRunner` 的 `tool_names` 改为“已授权工具全集 + selected tool names”的明确上下文对象，避免只传一个含义不清的列表。
- 🔲 让 Anthropic/OpenAI/Ollama 三个 Driver 只序列化 selected tools；保留同一套 Provider Schema 转换。
- 🔲 Skill 正文只在 selector 命中或显式 `use_skill` 时加载；同一轮去重。
- 🔲 增加 `tool_not_loaded` 结构化错误，并允许 selector 扩大候选后最多重试一次。
- 🔲 未加载工具不得进入 handler；`dispatch()` 仍按全局 registry 查找并执行权限、Schema、确认门。
- 🔲 保留完整 Schema emergency switch，支持按 provider、平台和用户灰度。
- 🔲 对 OpenAI、Anthropic、Ollama、MiniMax、DeepSeek 做 Schema parity、流式、多轮工具调用和缓存回归。
- 🔲 对写工具验证“筛选/重试不会重复执行”：`mutates`、destructive、确认 token 和核验流程保持原语义。
- 🔲 对比基线并记录：首轮/后续轮字符数、Schema 字符数、provider input tokens、cache ratio、P95 延迟、tool_not_loaded 率。

完成标准：默认路径不再向每轮请求注入 88 个工具的完整 Schema；常见单能力任务 Schema 字符数至少减少 60%，工具成功率和安全门无回归。

### Phase 4：清理与稳定化

- 🔲 所有内置 Skill 完成 frontmatter 迁移后，删除旧 `description` / `when` 解析兼容。
- 🔲 删除 Prompt builder、`skills_index()`、Profile 和 Capability Registry 之间的重复目录生成逻辑，保留一个单一事实源。
- 🔲 统一 Admin 能力目录展示、启用状态和权限状态；页面不得自行猜测工具能力。
- 🔲 将能力注入指标纳入 LoopScope 性能报告和现有 prompt/cache 报告。
- 🔲 清理 shadow mode、临时 fallback 和迁移 warning；保留明确的 emergency switch。
- 🔲 完成全量后端 CI、工具契约检查、确认门检查、权限检查和关键 E2E。
- 🔲 更新 `docs/product/PRD/README.md`、`docs/agent/30-提示词优化指南.md`、技能文案规范和 Changelog。

完成标准：能力注册表成为工具/Skill 元数据唯一来源；旧字段、重复目录和临时路由代码均有删除记录，且可通过 emergency switch 回滚注入策略。

### Phase 5：插件/社区能力（后续）

1. 定义插件 manifest 和签名校验。
2. 明确代码执行隔离、文件访问、网络访问和 shell 权限。
3. 支持显式安装、启用、禁用和版本回滚。
4. 外部 Skill 只能声明能力和资源，不能通过 prompt 覆盖系统权限或确认门。

---

## 6. 验证与上线

### 6.1 单元测试

- 注册项缺少 `description_short` 时失败。
- `description_short` 超过 100 个 Unicode 字符时失败。
- 工具和 Skill 重名时失败。
- `related_tools` 孤儿引用被发现。
- 权限过滤后能力不进入目录和 Schema。
- selector 对图片、画布、工作区、IM 和 Web 场景选出正确候选。
- 选中工具的完整 Schema 注入；未选中工具不注入。
- Skill 正文只在命中后加载，并且关联工具正确展开。
- `tool_not_loaded` 最多触发一次候选扩展。
- 现有 `dispatch()` schema 校验、destructive 确认门和 mutates 行为不变。
- LoopScope 记录字符数、估算 token 和 digest，但不记录用户原文或完整 Schema。

### 6.2 对比测试场景

至少覆盖：

1. 简单天气查询：只命中天气 Skill 和天气工具。
2. 图片识别/以图搜图：命中图片 Skill、`image_search` 和必要的验证工具。
3. 思维画布批量操作：命中画布 Skill 和相关 CRUD 工具，不加载文件、日历、shell Schema。
4. 工作区 shell：无工作区时不展示可执行 shell 能力；绑定后才显示。
5. 多步骤任务：候选工具跨多个类别时，验证不会因为候选限制丢失必要工具。
6. IM 群聊：按群权限过滤工具，并验证被过滤工具无法绕过 dispatch。
7. 无法识别请求：不回退到全量 Schema，记录 selector miss 并保持可解释错误。

### 6.3 灰度和回滚

- Phase 2 使用 shadow mode，不改变实际工具注入。
- Phase 3 增加配置开关，支持按用户、平台或 provider 灰度。
- 出现 `tool_not_loaded`、工具成功率、确认门或上下文错误明显回归时，关闭按需注入开关即可恢复旧 Schema 注入路径。
- 回滚不删除注册 metadata；只切换 injector 策略，保证迁移可继续。

---

## 7. 风险与待确认问题

| 风险 | 影响 | 对策 |
|---|---|---|
| selector 漏选必要工具 | 模型无法完成本来可完成的任务 | shadow mode 统计；保留一次 `tool_not_loaded` 扩展；设置候选上限而非硬编码单工具 |
| 短描述写得过于模糊 | 模型无法正确发现能力 | 注册期只校验长度，内容质量通过人工 review、命中率和失败案例持续修订 |
| Skill 与工具关联维护不一致 | Skill 加载后找不到工具 | registry generation 构建时校验孤儿引用，禁止静默降级 |
| 权限状态变化后复用旧缓存 | 用户看到或调用已禁用能力 | 权限视图进入缓存 key，权限变化主动失效 |
| 多 Provider Schema 格式差异 | 某个模型无法调用候选工具 | 继续复用现有 provider adapter，分别做 OpenAI/Anthropic parity 测试 |
| 插件带来不可信代码 | 数据、文件和系统安全风险 | Phase 5 前不开放远程代码加载；插件 manifest、签名和沙盒另立安全评审 |
| 首轮能力目录仍然偏大 | 节省效果不明显 | 按类别和上下文过滤；记录 `catalog_chars`；必要时分层目录，不恢复全量 Schema |

### 待确认

- 🔲 `description_short` 的 100 字符限制是否按 Unicode code point 计算：建议按 Python `len()` 的 Unicode 字符数，而不是 UTF-8 字节数。
- 🔲 首版 selector 是否只做规则匹配：建议是，先不增加额外 LLM 请求，等 shadow mode 有数据后再评估轻量意图模型。
- 🔲 Skill 是否允许多个版本并存：首版建议同一名称只保留一个 active version，插件市场阶段再支持版本并行。
- 🔲 是否允许一个工具属于多个 Skill：建议允许，关联只用于发现和注入，不改变工具执行权限。
