# 工具与 Skill 注册制及按需注入

> 状态：Phase 1～5 已完成；固定 Adapter Tool 与 canonical history 已接入，下一阶段接入 Capability RAG。
> 创建：2026-08-22
> 最近更新：2026-08-23
> 所属层：Agent / Capability Registry / Prompt Assembly
> 关联模块：`backend/agent/tools/base.py`、`backend/agent/tools/__init__.py`、`backend/agent/skills/__init__.py`、`backend/agent/context/builder.py`、`backend/agent/loop_drivers.py`、`backend/agent/prompts/skills.md`
> 关联测试：`backend/tests/test_tool_schema_validation.py`、`backend/tests/test_tool_isolation.py`、LoopScope context/tool schema 相关测试

---

## 0. 实施状态

| 阶段 | 状态 | 说明 |
|---|---|---|
| Phase 0：现状审查与协议草案 | ✅ 已完成 | 已完成代码、Prompt、Provider、权限、LoopScope 和测试盘点；统一协议已形成文档草案，代码层尚未冻结。 |
| Phase 1：统一能力注册协议 | ✅ 已完成 | 89 个工具和 10 个 Skill 已具备可校验短描述、类别/关联 metadata、注册适配器、不可变快照和社区 README；旧 Skill 字段已迁移，注册与关联回归已补齐。 |
| Phase 2：能力目录基础设施 | ✅ 非 RAG 部分完成 | 已提供能力快照、授权交集、可替换 selector 和兼容模式；Capability RAG 索引、候选召回、排序和每轮推荐暂不实施。 |
| Phase 3：按需 Schema / Skill 正文基础设施 | ✅ 非 RAG 部分完成 | 三类 Driver 已支持 selected tools，Skill 使用标记可跨同一 session 的 history 复用，已提供 emergency 全量 Schema 开关；当前不启用每轮候选推荐。 |
| Phase 4：迁移、观测与回归 | ✅ 基础稳定化完成 | 已完成旧字段清理、Admin 能力目录、Provider Schema parity、脱敏诊断和关键行为回归；独立基线报告仍待后续性能任务。Phase 1～4 的文件级基础设施已完成。 |
| Phase 5：固定 Adapter Tool 与 canonical history | ✅ 已完成 | Provider 只注册固定 `call_tool`、`use_skill`、`ask_user`；业务 Schema、Skill 关联和调用历史使用 canonical event 追加并跨 Provider 重建。 |
| Phase 6：Capability RAG 与推荐 | 🔲 后置 | 在固定 Adapter Tool 链路稳定后，与 `PRD-RAG-1` 联动实现工具推荐、推荐原因、命中率观测和灰度；不缩减授权工具目录。 |
| Phase 7：插件/社区扩展 | 🔲 后续 | 在注册制、Adapter Tool 和 RAG 稳定后，再开放外部包、签名和隔离加载。 |

> **文件级完成判定（2026-08-23）**：Phase 1～5 的注册表、能力快照、固定 Adapter、canonical event、跨 Provider history adapter 和基础回归测试均已落地。兼容模式的 `declare_tools → driver.update_tools()` 仍保留为 emergency switch；正常能力注入路径不再使用它。

对应回归已核验：能力注册、selector、能力注入、canonical history、Provider history adapter 和工具 Schema 校验均通过；兼容模式与固定 Adapter 模式分别保留回归覆盖。

### 0.2 Phase 1～3 未完成项说明

当前仍显示为 `🔲` 或 `⏸️` 的项目，按原因分为三类：

| 类别 | 项目 | 处理阶段 | 当前策略 |
|---|---|---|---|
| 注册迁移收尾 | 旧 `description/when` 解析兼容、完整 Provider parity | Phase 4 | 已删除旧 Skill 字段读取兼容；Provider 统一由 Tool contract 生成两种 Schema，并补 parity 回归。 |
| 观测与安全回归 | LoopScope 能力目录指标、emergency switch、权限/确认门/写工具回归 | Phase 4 | 已记录脱敏目录指标并补关键回归，不接入候选推荐。 |
| RAG 依赖项 | Capability RAG 索引、BM25/Embedding、每轮软推荐、推荐命中率评估 | Phase 6，依赖 `PRD-RAG-1` | 必须在 Phase 5 固定 Adapter Tool 链路稳定后实施。 |

因此，Phase 1～3 的“代码基础设施”已经完成；未完成标记主要代表迁移、观测和 RAG 接入，不代表注册表、Skill 标记或三类 Provider 的基础能力缺失。

### 0.1 现状审查结论（2026-08-22）

本次审查覆盖工具注册、Skill 加载、Profile、Prompt 组装、Provider Driver、权限过滤、LoopScope 和现有测试。结论如下：

| 领域 | 当前实际状态 | 对本 PRD 的影响 |
|---|---|---|
| 工具注册 | `agent.tools.base.SkillRegistry` 已能注册 `Tool`、按领域 Skill 聚合、校验 JSON Schema、生成 OpenAI/Anthropic Schema、统一 dispatch。 | 可以复用执行注册表，但它目前只是工具执行 registry，不是统一 Capability Registry。 |
| 工具 metadata | `Tool` 已提供短描述、category、source、权限和关联 Skill metadata；category 缺省时由现有工具组派生。 | 继续由注册 adapter 校验，不复制 89 个工具名称清单。 |
| 默认工具规模 | `DefaultProfile` 当前启用 17 个工具组，共 89 个工具；OpenAI Schema 序列化约 62,178 字符，Anthropic 约 59,626 字符。 | “每轮减少 80k 字符”不能作为固定承诺；可确认的是当前每轮会重复注入约 60k 字符的工具 Schema，另有消息、记忆和 Skill 文案。 |
| Skill 注册 | `agent/skills/*.md` 通过 frontmatter 扫描，`skills_index()` 返回 `slug/name/when/emoji`；`use_skill` 按需加载正文。 | 已有“Skill 正文渐进式加载”，但 metadata 仍使用 `description`/`when` 兼容字段，且没有统一 registry。 |
| Skill 规模 | 默认 Profile 启用 10 个 Markdown Skill；短描述均已控制在 100 个 Unicode 字符以内，长触发说明迁移到 `description_long`。 | 注册期校验短描述；正文和长说明不进入首轮能力目录。 |
| Profile | `BaseProfile.tool_names` 通过工具组展开；`skills` 是独立 slug 列表。 | 当前存在两套能力声明，Phase 1 要增加 adapter，而不是立即删除 Profile。 |
| Prompt 组装 | `builder._skills_index_block()` 会把 9 个 Skill 的索引放进静态 Prompt；常驻 `prompts/skills.md` 还维护主动指针；完整工具 Schema 不由 builder 生成。 | Skill 短目录、常驻指针和工具 Schema 需要明确职责，避免三处重复描述同一能力。 |
| Schema 注入 | `AnthropicDriver`、`OpenAIDriver`、`OllamaDriver` 都调用 `registry.*_schemas(tool_names)`；`tool_names` 来自 Profile 加 IM 白名单和 shell 过滤，没有 Capability RAG。 | Phase 3 的真正改造点在 runner/driver 之间的调用契约，不是只改 Prompt builder。 |
| 权限 | IM 入口通过 `filter_tool_names()` 做模型可见工具裁剪，dispatch 再通过 `can_use_tool()` 做第二道检查；shell 还有工作区过滤。 | Capability RAG 查询必须复用现有权限结果，不能自行复制权限逻辑或仅靠隐藏目录实现安全控制。 |
| Skill 与工具关联 | 目前主要依赖 `prompts/skills.md` 的主动指针和 Skill 正文中的手写工具名；工具 registry 只记录“工具组 → 工具名”，不记录 Markdown Skill 关联。 | 需要先建立关联 metadata，再逐步删除重复指针；关联错误必须在启动/快照构建时暴露。 |
| LoopScope | 已有 `LLM round` 的 `tool_count`、Schema 字节数、估算 token 和 digest；另有独立的 `Tool schemas injected` context span。 | 观测层已有基础，但它记录的是当前全量 Schema，不代表“已筛选”；Phase 4 需要新增 catalog/selected/omitted 指标。 |
| 测试 | 已覆盖 Tool JSON Schema 注册/dispatch、Provider Schema 保持不变、Capability Registry、selector、按需注入和 Skill 使用标记回归。 | Phase 4 继续补齐 Provider parity、权限和 emergency switch；RAG 召回质量归 Phase 6。 |

因此，当前已落地的最小路线不是一次性替换 Profile，而是先完成注册与注入基础设施；RAG 召回暂不接入生产请求：

```text
现有 Tool/Skill → Capability Adapter → 统一快照
    → 现有授权工具集（当前兼容模式）→ 按 Provider 切换注入基础设施
    → [Phase 5] 固定 Adapter Tool + canonical history
    → [Phase 6] Capability RAG 工具软推荐
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
- [Phase 6] Capability RAG 结合用户输入、当前会话、平台和工作区，为已授权工具生成推荐顺序；权限仍由 Runtime 独立执行硬校验。
- 命中后按需注入完整工具 Schema、Skill 正文及其关联关系。
- 保留现有 Agent Loop、工具校验、确认门和 handler 执行边界，不把能力筛选变成隐藏业务编排。
- 为未来插件/Skill 社区提供稳定、可校验、可观测的注册接口。
- 注册表原子单位是单个工具或单个 Skill，不是当前的领域工具组 `BaseSkill`。

### 1.3 非目标

- 本 PRD 不重写工具 handler、数据库服务层或权限实现。
- 本 PRD 不要求每个请求额外调用一次 LLM；候选召回由 `PRD-RAG-1` 的 Capability RAG 提供。
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
用户输入 → 能力简介目录 → `declare_tools` 声明 → Runtime 校验 → 下一轮注入声明工具 Schema → Agent Loop

Capability RAG（后置）只负责给完整能力目录生成推荐顺序和理由，不改变声明协议，也不执行工具。

当前阶段跳过括号内步骤，继续使用现有授权工具集合；不额外发起 LLM 推荐请求。
```

Plan 模式回答“任务要拆成哪些步骤以及如何按依赖执行”。两者可以组合，但不能把本地能力筛选命名为 Plan，避免后续职责混淆。

### 2.5 静态 Snapshot 与动态候选

能力注入分为两层：

| 层 | 内容 | 生命周期 |
|---|---|---|
| 静态 Snapshot | 已注册、已授权能力的短描述目录，以及注册代数和诊断摘要 | 可跨轮缓存；权限、注册或平台变化时失效 |
| 动态工具 | Runtime 根据声明得到的工具名 | 声明后下一轮注入；RAG 未来只负责推荐优先级 |

兼容模式下，完整工具 Schema 仍通过 provider 原生 `tools` 参数传递，不拼成普通 Prompt 文本；Phase 5
固定 Adapter 模式下，完整 Schema 以 canonical `tool-schema` history event 保存，由固定 `call_tool` 使用。
Skill 正文不属于候选集合，只能通过 `use_skill` 等明确加载路径进入动态上下文。

### 2.6 Snapshot / tail / history 分层

上下文缓存和消息历史分为三个职责不同的区域：

```text
Snapshot（稳定目录）
  └─ 永远保留当前已授权能力的短描述目录

tail（后置的本轮推荐提示）
  └─ [Phase 6] 可放本轮 Capability RAG 推荐的工具名、短描述和推荐理由
  └─ 当前不执行每轮推荐，不生成推荐 tail

history（消息历史）
  └─ 用户消息
  └─ assistant tool_call
  └─ tool result
```

规则：

- Snapshot 是稳定的能力目录，不因为某个工具本轮已声明而删除工具，也不存放完整 Schema。
- tail 是 [Phase 6] 本轮 UI/Prompt 中的筛选结果；当前不执行每轮推荐。
- 已声明工具的完整 Schema 仍通过当前请求的 provider `tools` 参数传递，不写入普通 history。
- 工具调用和工具结果继续按现有协议进入 history，不改变消息格式、顺序或持久化方式。
- Skill 正文只在本次 Run 首次成功调用 `use_skill` 时加载一次，工具结果进入 history 后由后续轮次复用，不再重复注入正文。
- `use_skill` 成功结果带结构化 `_capability_usage` 使用标记；Run 开始时只读取该标记，不扫描正文、不做关键词去重。上下文压缩或截断后标记与正文一起消失，才允许再次调用 `use_skill`。
- 重复调用已加载 Skill 返回轻量的 `already_loaded` 结果，不复制正文，也不改变工具调用/结果的 history 结构。
- 下一轮重新从 Snapshot 和当前状态筛选 tail，不自动继承上一轮 tail。
- 这套去重只影响候选展示和动态目录，不影响 Agent Loop 的工具调用、结果回传和重试语义。

### 2.7 固定 Adapter Tool 与 canonical history（Phase 5 目标架构）

Phase 5 不再通过动态修改 provider 原生 `tools` 集合来实现工具声明。Provider 侧只保留稳定的抽象入口：

```text
固定 Provider tools
├── call_tool
├── use_skill
└── ask_user
```

业务工具的 Schema、Skill Schema、调用和结果统一保存为 provider-neutral 的 canonical history/event：

```text
skill-schema
tool-schema
tool-call
tool-result
```

要求：

- `call_tool` 是稳定的 Adapter Tool，接收业务工具名和参数；Runtime 仍必须重新执行权限、Schema、确认门、ownership 和 destructive 校验。
- `tool-schema` 可以作为 Session history 的追加内容供后续 round/run 复用，但不能伪装成 OpenAI `tool` 或 Anthropic `tool_result`。
- Provider 原生消息格式只在 adapter 边界由 canonical history 重建；数据库和 Session history 不保存 provider wire format。
- `tool-call + tool-result` 是不可拆分的历史原子单元；`tool-schema` 不能在压缩时被单独丢弃而留下无法解释的 `call_tool` 调用。
- Skill 首次加载后，Skill 正文和关联工具 Schema 追加一次；后续 round/run 从 history 复用，不重复注入。
- 一个工具可以属于多个 Skill；Skill 自动注入的是 canonical `tool-schema`，不是动态 provider tools。
- Schema 必须带 `tool_name + schema_version + schema_digest`，版本变化时追加新版本，不原地改写旧 history。
- 诊断记录工具名、版本、digest、数量和耗时即可；完整 Schema、参数、用户正文和 Skill 敏感内容不得进入可见日志或模型上下文之外的诊断数据。

目标请求结构：

```text
固定 system/session
+ 固定 call_tool/use_skill/ask_user Schema
+ canonical history
+ 新消息
```

声明业务工具只会追加 history，不会改变固定 provider tools 前缀，从而避免当前 `declare_tools → 动态原生 Schema` 导致的 Cache 断点前移。

---

## 3. 功能需求

### FR-REG-1：细粒度工具与 Skill 注册协议（✅ 基础设施完成）

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
- `category`、`source` 格式合法。
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

#### 注册表最小 API

```python
# 工具模块导入时自注册
tool_registry.register(tool_definition)
tool_registry.get("image_search")
tool_registry.list(category="search")

# SkillRegistry 扫描 Markdown frontmatter，并按需读取正文
skill_registry.scan(Path("backend/agent/skills"))
skill_registry.get("image-analysis")
skill_registry.load_body("image-analysis")

# 每次构建生成不可变快照，供 selector、injector、Admin 和诊断使用
index = CapabilityIndex.from_registries(tool_registry, skill_registry)
snapshot = index.snapshot(authorized_names=authorized_names)
```

注册表只提供通用注册、查询、校验和快照能力，不维护 `image_search` 等业务名称清单；新增社区能力只需新增定义文件并通过目录/模块发现流程，不修改中央 registry。

注册方式必须遵守“定义所在文件自注册、注册表不维护清单”的原则：

```text
backend/agent/tools/image_search.py
        └─ 定义 image_search
        └─ tool_registry.register(image_search)

backend/agent/tools/tool_registry.py
        └─ 只实现通用 register()、校验和查询
        └─ 不手写 image_search / web_search 等工具清单
```

Skill 采用目录扫描方式：

```text
backend/agent/skills/*.md
        ↓
SkillRegistry 扫描 frontmatter
        ↓
自动注册每个 SkillDefinition
```

约束：

- `tool_registry.py` 不得集中调用所有工具的 `register()`。
- `skill_registry.py` 不得集中硬编码所有 Skill 名称；文件名和 frontmatter 是扫描输入。
- 工具模块只需要导出定义并调用一次通用 `register()`；不需要修改中央 registry 文件。
- `CapabilityIndex` 只消费两个注册表的结果，不负责发现业务模块，也不复制注册代码。
- 迁移期可由 `backend/agent/tools/__init__.py` 负责导入内置工具模块；导入只为触发模块自注册，不维护工具名称列表。
- 未来插件通过显式插件目录/manifest 加载模块，不能扫描任意用户路径或任意 Python 文件。
### FR-REG-2：工具注册 metadata（✅ 基础设施完成，文案迁移后置）

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

#### Tool 注册字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | `str` | 是 | 稳定的工具名，全局唯一，作为模型调用名。 |
| `description_short` | `str` | 是 | 不超过 100 个 Unicode 字符，说明“做什么、什么时候用”。 |
| `description` | `str` | 是 | 完整模型说明，仅在工具被选中时进入 provider Schema。 |
| `input_schema` | `dict` | 是 | 顶层为 `object` 的 JSON Schema，继续由现有 validator 校验。 |
| `handler` | `Callable` | 是 | 现有工具执行函数，不在注册层复制或包装业务逻辑。 |
| `category` | `str` | 否 | 能力分类，例如 `search`、`canvas`、`file`。 |
| `permissions` | `tuple[str, ...]` | 否 | 筛选所需权限，不授予权限；最终仍由权限层判定。 |
| `related_skills` | `tuple[str, ...]` | 否 | 关联 Skill slug，用于发现和按需注入。 |
| `destructive` | `bool` | 否 | 沿用现有确认门契约，默认 `False`。 |
| `mutates` | `bool` | 否 | 沿用现有状态变更契约，默认 `False`。 |
| `source` | `str` | 否 | `builtin` 或受信任插件来源，默认 `builtin`。 |

最小注册示例：

```python
image_search = Tool(
    name="image_search",
    description_short="按文字或图片搜索相关图片。",
    description="根据用户的文字查询或附件图片检索候选图片，并返回可核验结果。",
    input_schema=IMAGE_SEARCH_SCHEMA,
    handler=handle_image_search,
)
tool_registry.register(image_search)
```

`description_short` 与完整 `description` 分离：

- 短描述进入能力目录。
- 完整描述只在工具 Schema 被选中时进入 provider 请求。
- 现有 `to_anthropic()`、`to_openai()` 的 Schema 结构保持不变，避免影响 provider 适配层。

### FR-REG-3：Skill 注册 metadata（✅ 已完成）

现有 Markdown frontmatter 逐步统一为：

```yaml
---
name: 联网搜索
description_short: 查资料、新闻、官网事实、研究比较和图片搜索时使用。
category: search
permissions: network
related_tools: web_search,deep_research,image_search
source: builtin
---
```

#### Skill 注册字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | `str` | 是 | 面向模型和 UI 的显示名。 |
| `slug` | `str` | 是 | 由文件名确定的稳定标识，例如 `image-analysis`；不随显示名变化。 |
| `description_short` | `str` | 是 | 不超过 100 个 Unicode 字符，进入首轮能力目录。 |
| `category` | `str` | 否 | 能力分类，例如 `search`、`canvas`。 |
| `permissions` | `tuple[str, ...]` | 否 | 作为筛选条件，不替代用户权限。 |
| `related_tools` | `tuple[str, ...]` | 否 | 必须能在 ToolRegistry 中解析。 |
| `source` | `str` | 否 | `builtin` 或受信任插件来源。 |
| `emoji` | `str` | 否 | 仅用于 UI 或目录展示。 |
| `body` | `str` | 否 | Markdown 正文，命中后延迟加载，不进入首轮目录。 |

Skill 文件名负责 `slug`，frontmatter 负责注册 metadata，正文负责流程规则。正文中的普通文本不能被当作注册字段，也不能偷偷声明新工具。

迁移期兼容：

- `description_short` 优先。
- 旧 `description` / `when` 作为临时别名解析。
- 启动诊断中标记旧字段使用情况。
- 完成迁移后删除旧字段兼容，不再在运行时静默猜测。

### FR-REG-4：首轮注入能力目录（✅ 基础设施完成，默认关闭）

首轮只注入静态 Snapshot 中的短描述目录，不注入完整工具 Schema 或所有 Skill 正文。Snapshot 不等于本轮候选，也不应携带上一轮的完整 Schema。

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

### FR-REG-5：Capability RAG 软推荐接口（⏸️ 后置，依赖 PRD-RAG-1）

本 PRD 不实现 BM25、Embedding 或候选排序算法，只定义注册信息如何提供给统一 RAG 层，以及如何消费 RAG 返回的工具推荐：

- Capability RAG 索引工具的名称、短描述、类别、关键词、平台和关联 Skill metadata。
- 权限、平台、工作区和会话 scope 由 Runtime 先生成授权视图；权限是硬安全边界，RAG 不复制也不替代它。
- RAG 只返回工具推荐，不返回 Skill 正文，也不能改变授权工具目录。
- 不默认继承上一轮推荐；每轮根据当前请求和必要的任务状态重新计算推荐顺序。

推荐结果约束：

- 推荐项只能来自当前授权视图；未知、禁用或越权名字会被 Runtime 忽略。
- 推荐结果只是排序和提示，不能作为工具可见性过滤器，不能因为漏召回而丢失工具。
- 推荐为空或 RAG 失败时，完整短描述目录仍然可用，Agent 仍可声明任意授权工具。
- Capability RAG 只负责推荐，不执行 handler、不改变数据库状态、不代替 Agent 规划。

`capabilities/selector.py` 只作为 RAG 结果适配层，负责把推荐结果排在授权工具全集前面，不复制 RAG 的分词、BM25 或 Embedding 实现，也不执行候选裁剪。

### FR-REG-6：按需注入完整工具 Schema（🟡 现有链路完成，固定 Adapter 目标待 Phase 5）

当前兼容链路是：首轮只注入工具简介目录和固定的 `declare_tools` Schema。模型声明本轮需要的工具后，Runtime
执行权限/注册校验，并在下一轮 provider 请求中注入声明工具的完整 Schema。该链路已经可用，但会因为动态修改
provider 原生 `tools` 集合而造成声明后的 Cache 断点变化。

Phase 5 将升级为固定 Adapter Tool：业务工具 Schema 作为 canonical `tool-schema` event 追加到 Session
history，provider 每轮只注册固定的 `call_tool`、`use_skill`、`ask_user`，不再把业务工具 Schema 动态加入原生
`tools` 集合。

RAG 不属于这条链路的前置条件；未来只需把 RAG 推荐结果作为声明前的优先提示，不改变工具
可见目录、工具 handler、确认门或 history 协议。

现有兼容模式的 Agent Loop 仍接收动态候选工具的完整 provider Schema：

```text
静态 Snapshot：短描述目录
        ↓
Capability RAG 推荐 image_search、web_search 优先考虑（不隐藏其它授权工具）
        ↓
动态上下文：仅由明确的 `use_skill` 加载 Skill 正文和临时说明
Provider tools 参数：这两个工具的完整 Schema
        ↓
模型生成 tool call
  ↓
现有 registry.dispatch() 校验并执行
```

Phase 5 目标模式：

```text
静态 Snapshot：短描述目录
        ↓
固定 Provider tools：call_tool / use_skill / ask_user
        ↓
canonical history：skill-schema / tool-schema / tool-call / tool-result
        ↓
模型调用 call_tool(name, arguments)
        ↓
Runtime 从 ToolRegistry 取 canonical 定义并校验执行
```

要求：

- 候选 Schema 使用 ToolRegistry adapter 复用当前 `SkillRegistry.openai_schemas()` / `anthropic_schemas()` 的 provider 格式；迁移完成后再把 Schema 序列化职责移入 ToolRegistry，不复制实现。
- 不改变 `dispatch()` 的 schema 校验、权限、确认门和事务边界。
- 兼容模式下，如果模型请求了尚未声明的已注册工具，仍由 `declare_tools` 在下一轮注入其 Schema；Phase 5
  改为追加 canonical `tool-schema`，由固定 `call_tool` 执行，不依赖 RAG 推荐结果。
- 如果模型传入了不存在的工具名，继续返回现有未知工具错误。
- Schema 缓存按 `tool name + api_format` 计算 digest，避免每轮重复序列化。

兼容模式下，工具声明的生命周期以“单次模型请求”为单位；Phase 5 改为 Session history 可复用的 append-only 生命周期：

- 当前兼容模式每次调用模型前都可重新计算当前请求的推荐顺序和已声明工具；固定 Adapter 模式不重新修改
  provider tools，只在 history 中追加尚未存在的 Schema 版本。
- Skill 首次调用或工具结果暴露出新需求时，追加对应 `skill-schema`/`tool-schema` event；后续 Run 通过 history
  复用，不重复注入。
- 权限、平台或 Schema 版本发生变化时，追加新的 canonical event；旧 event 保留用于历史重放。

### FR-REG-7：按需加载 Skill 正文（✅ 已完成）

Skill 首轮只注入短描述。命中后加载正文：

- Skill 不进入工具候选，也不由 Capability RAG 返回正文。
- 通过现有 `use_skill` 工具或明确的 Skill 加载规则显式加载。
- 同一 Run 或已有 history 已包含正文时不重复加载；只有正文被压缩/截断后才重新加载。
- 去重依据是 Skill 使用标记中的稳定 slug，不依赖展示名称；重复请求返回轻量状态结果。
- Skill 正文中的工具名必须来自 registry，启动或加载时校验孤儿引用。
- Skill 正文不能绕过工具权限、确认门和 Schema 校验。

### FR-REG-8：能力与权限统一（🟡 基础规则保留，统一视图待 Phase 4）

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

### FR-REG-9：LoopScope 记录能力注入过程（🟡 基础能力已有，指标补齐归 Phase 4/5）

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

- 名称、类型、短描述、类别、来源。
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
├── selector.py          # 适配 Capability RAG 结果，不实现检索算法
├── injector.py          # 目录、Schema、Skill 正文注入
├── diagnostics.py       # digest、字符数、token 估算、LoopScope metadata
└── errors.py            # 注册期和加载期错误
```

职责边界：

- `agent.tools.base.SkillRegistry` 在迁移期继续负责工具执行契约；`ToolRegistry` 通过 adapter 读取单个工具，不复制 handler 和 Schema 校验逻辑。
- `agent.skills` 继续负责 Markdown 解析和正文加载；`SkillRegistry` 读取单个 Skill metadata，不复制正文加载逻辑。
- `CapabilityIndex` 只合并两个注册表的 metadata 和关联引用，不承载业务 handler。
- `selector.py` 不调用 LLM、不执行 handler、不写数据库。
- `injector.py` 不决定权限，只接收 Runtime 已生成的授权视图；RAG 推荐不会缩小这份视图。
- `dispatch()` 仍是唯一工具执行入口。

### 4.1.1 文件级改动清单

以下清单以当前代码为基线，区分新增文件、需要改动的文件和明确不应改动的文件。实现时按 Phase 更新状态，避免只新增注册表却遗漏真实注入链路。

#### 新增文件

| 文件 | 阶段 | 职责 |
|---|---|---|
| `backend/agent/capabilities/__init__.py` | Phase 1 | 暴露能力注册、快照和筛选的稳定入口。 |
| `backend/agent/capabilities/models.py` | Phase 1 / Phase 5 | Phase 1 定义能力快照；Phase 5 补充工具 Schema 的版本和 digest 引用，不把 Provider wire format 放入能力模型。 |
| `backend/agent/capabilities/tool_registry.py` | Phase 1 | 注册单个工具 metadata，校验工具名、Schema、handler 和短描述。 |
| `backend/agent/capabilities/skill_registry.py` | Phase 1 | 注册单个 Markdown Skill metadata，管理正文 loader 和短描述。 |
| `backend/agent/capabilities/index.py` | Phase 1 | 合并两个细粒度注册表，校验跨表关联并生成不可变能力快照。 |
| `backend/agent/capabilities/selector.py` | Phase 2 / Phase 6 | Phase 2 提供可替换 selector 和兼容模式；Phase 6 消费 Capability RAG 推荐结果，不实现 BM25/Embedding，也不裁剪授权工具。 |
| `backend/agent/capabilities/injector.py` | Phase 2～3 / Phase 5～6 | Phase 5 增加固定 Adapter Tool 和 canonical history 注入；Phase 6 接入推荐提示，不把推荐结果当作候选硬过滤。Skill 正文只服务显式 `use_skill`。 |
| `backend/agent/capabilities/diagnostics.py` | Phase 4～6 | Phase 4 计算目录/Schema 字符数、digest 和 token 估算；Phase 5 增加 canonical event、Adapter Tool 和 history 复用指标；Phase 6 增加推荐、召回和命中指标。 |
| `backend/agent/capabilities/errors.py` | Phase 1 | 定义注册失败、关联缺失、能力未加载等结构化错误。 |
| `backend/agent/tools/README.md` | Phase 1 | 说明工具 Python 文件格式、单工具注册、Schema、短描述、权限字段、确认门和测试要求。 |
| `backend/agent/skills/README.md` | Phase 1 | 说明 Skill Markdown frontmatter、正文边界、短描述、关联工具、加载方式和注册校验。 |
| `backend/tests/test_capability_registry.py` | Phase 1 | 注册契约、metadata、旧字段迁移和关联校验。 |
| `backend/tests/test_capability_selector.py` | Phase 2 / Phase 6 | Phase 2 测试授权全集保留；Phase 6 增加推荐顺序、推荐失败和权限边界测试。 |
| `backend/tests/test_capability_injection.py` | Phase 2～4 | 目录、兼容模式 Schema、显式 Skill 正文加载和未加载工具扩展测试；固定 Adapter Tool 与 canonical history 测试归 Phase 5。 |

#### Phase 5 新增文件

以下文件是固定 Adapter Tool 与 canonical history 的最小承载层，目前尚未创建：

| 文件 | 职责 |
|---|---|
| `backend/agent/context/canonical_tool_history.py` | 定义 `tool-discovery`、`skill-schema`、`tool-schema`、`tool-call`、`tool-result` 的 provider-neutral 结构，以及跨 Provider 重建入口。 |
| `backend/agent/tools/call_tool.py` | 定义固定 `call_tool` Adapter Tool；只负责接收工具名和参数，实际权限、Schema、确认门和执行仍交给 Runtime。 |
| `backend/tests/test_call_tool_adapter.py` | 固定 Adapter Tool 的参数校验、未知工具、权限和确认门回归。 |
| `backend/tests/test_canonical_tool_history.py` | canonical event 的追加、去重、版本和顺序回归。 |
| `backend/tests/test_cross_provider_tool_history.py` | OpenAI、Anthropic、DeepSeek 等 Provider 从同一 canonical history 重建合法消息。 |
| `backend/tests/test_tool_history_compaction.py` | Schema event、`tool-call + tool-result` 原子压缩和重放回归。 |

#### 需要修改的现有文件

| 文件 | 阶段 | 改动范围 |
|---|---|---|
| `backend/agent/tools/base.py` | Phase 1 | 给 `Tool` 增加能力 metadata；保留现有 Schema validator、`to_openai()`、`to_anthropic()` 和 `dispatch()` 语义；由 adapter 提供给 Capability Registry。 |
| `backend/agent/tools/__init__.py` | Phase 1 | 只负责导入受信任的内置工具模块以触发自注册，不维护工具名称清单；能力快照由 CapabilityIndex 统一构建。 |
| `backend/agent/skills/__init__.py` | Phase 1 / Phase 4 | 已统一解析 `description_short`、`description_long` 等 metadata，已删除旧 `description/when` 读取兼容。 |
| `backend/agent/skills/*.md` | Phase 1 | 为 10 个内置 Skill 补齐短描述、类别、来源和关联工具；长触发说明已迁移。 |
| `backend/agent/profiles/base.py` | Phase 1～2 | 保留旧 `tools/skills` 配置作为输入适配；增加从 Profile 生成授权 Capability 视图的入口，避免立即删除存量配置。 |
| `backend/agent/profiles/default.py` | Phase 1～2 | 补充默认 Profile 的能力类别/上下文声明；不再新增扁平工具名清单。 |
| `backend/agent/context/builder.py` | Phase 2～3 | 移除或收敛独立 Skill 目录拼装，改调用 Capability Injector；保留 persona、policy、记忆和业务上下文职责。 |
| `backend/agent/prompts/skills.md` | Phase 2～4 | 保留少量不可遗漏的行为规则；删除与注册 metadata 重复的能力目录描述，避免短描述、主动指针和 Skill 索引三处漂移。 |
| `backend/agent/tools/meta.py` | Phase 2～3 | 让 `use_skill` 从 Capability Registry 校验和加载 Skill，保留正文返回格式和错误语义。 |
| `backend/agent/im/permissions.py` | Phase 4 / Phase 5～6 | Phase 4 收敛统一授权视图；Phase 5 固定 Adapter Tool 复用该视图，Phase 6 为 RAG 提供授权视图，不在 RAG 或 selector 中复制权限判断。 |
| `backend/agent/runner.py` | Phase 2～3 / Phase 5～6 | Phase 5 传递 Adapter Tool 与 canonical history，Phase 6 再传递推荐顺序和推荐诊断，不改变执行链路。 |
| `backend/agent/core.py` | Phase 3 | 保持 Agent Loop 控制流，只适配新的 selected tool context；不把 selector 逻辑塞进 handler/loop 分支。 |
| `backend/agent/loop_drivers.py` | Phase 3 | Anthropic/OpenAI/Ollama Driver 读取 selected tools；保留 provider Schema 转换、缓存和流式行为。 |
| `backend/agent/context/history.py` | Phase 5 | 在现有工具历史 canonicalization 基础上扩展 Schema event、ToolCall 和 ToolResult 的统一读写；不再持久化 Provider wire format。 |
| `backend/agent/runtime/loopscope_trace/context.py` | Phase 4～6 | Phase 4 记录能力目录和 Skill 正文来源；Phase 5 增加 canonical event/Adapter Tool 来源；Phase 6 增加推荐来源，不重复记录完整 Schema。 |
| `backend/agent/runtime/loopscope_trace/hooks.py` | Phase 4～6 | Phase 4 已记录目录/选中工具的脱敏数量、字符数和 digest；Phase 5 增加 Adapter Tool/history 事件；Phase 6 增加推荐耗时、推荐命中和声明结果。 |
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

- ✅ 新增能力模块全部有模块级 docstring，注册/注入/诊断关键路径有单元测试。
- 🔲 现有工具业务文件只出现 metadata 增量，不出现 selector/import 循环。
- 🔲 `runner.py`、`core.py`、`loop_drivers.py` 的 Adapter Tool、canonical history 和工具执行职责边界保持清晰。
- ✅ 删除旧目录生成逻辑前已确认 Capability Injector 覆盖 Web、IM、定时任务和 LoopScope；当前仅保留 Builder 的 Skill 索引职责。
- 🔲 每个删除项继续在 `docs/devlog.md` 留下独立迁移记录。

#### 两个目录 README 的最低内容

两个 README 的第一目标不是解释内部实现，而是让社区作者在不阅读 Agent Loop、Provider Driver 和 registry 内部代码的情况下完成一个可注册的 Tool 或 Skill。

`backend/agent/tools/README.md` 必须包含：

1. 从创建目录到注册成功的最小可复制示例。
2. 一个最小 `ToolDefinition`/`Tool(...)` 示例，复制后只需替换名称、简介、Schema 和 handler。
3. `name`、`description_short`、完整 `description`、`input_schema`、handler 的字段表和填写示例。
4. `category`、`permissions`、`related_skills`、`destructive`、`mutates` 的填写边界；不需要的字段明确写“可省略”。
5. 单工具注册方式，以及为什么不能只把工具加入某个工具组而不注册单项 metadata。
6. 从本地校验到测试的完整命令，例如“检查注册协议”“运行该工具测试”“运行相关后端测试”。
7. Schema、确认门、归属校验、脱敏日志和测试要求，用社区作者能理解的语言解释。
8. 常见错误示例：简介超过 100 字符、Schema 顶层不是 object、忘记注册 handler、权限声明和确认门混淆。
9. 禁止在业务 handler 中实现 selector、Prompt 拼装或第二套权限判断。

`backend/agent/skills/README.md` 必须包含：

1. 一个可以直接复制的 Skill 目录和 Markdown 文件示例。
2. frontmatter 与正文的明确分界，推荐使用结构化 YAML parser。
3. 允许的 metadata 字段：`name`、`description_short`、`category`、`permissions`、`related_tools`、`source`、`emoji`。
4. `description_short` 不超过 100 个 Unicode 字符，正文中的同名字段不参与注册。
5. 一个完整 frontmatter 示例和正文示例，并标出哪些内容会进入首轮目录、哪些内容只在命中后加载。
6. `SkillRegistry.register()`、正文延迟加载和 `use_skill` 的关系，但不要求作者理解 registry 内部实现。
7. `related_tools` 必须是已注册工具，禁止在正文里偷偷声明或执行未注册能力。
8. 从本地校验到预览能力目录的完整命令，以及如何查看校验错误。
9. 常见错误示例：frontmatter 未闭合、字段拼写错误、正文误当 metadata、关联工具不存在、简介过长。
10. 注册失败、正文加载失败和敏感信息记录规则。

两个 README 还应提供统一的作者检查清单：

```text
□ 能力名称稳定且没有暴露内部路径
□ description_short 在 100 个 Unicode 字符以内
□ 能力简介说明了“做什么”和“什么时候用”
□ Tool 的 JSON Schema 可以独立通过校验
□ Skill 的正文只描述流程，不伪造工具或权限
□ related_tools 都是真实已注册工具
□ 没有把密钥、用户数据或绝对路径写进 metadata/示例
□ 已运行本地注册校验和最小回归测试
```
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
[Phase 6] Capability RAG 使用该快照
```

能力快照按 `registry_generation` 标识。开发环境支持文件变更后重新加载，生产环境默认在进程启动时构建并缓存。

### 4.3 上下文组装流程

```text
用户消息 / 当前状态
        ↓
读取可授权的 Capability Snapshot
        ↓
静态 Prompt 末尾注入短描述目录
        ↓
固定 Provider tools：call_tool / use_skill / ask_user
        ↓
`use_skill` 首次调用后追加 skill-schema 与关联 tool-schema
        ↓
canonical history 跨 round / run 复用 Schema、调用和结果
        ↓
Agent Loop
        ├─ call_tool → registry.dispatch()
        ├─ use_skill → 加载 Skill 正文
        └─ tool result → 追加 canonical tool-result
```

Phase 5 之前的兼容模式仍可通过 `declare_tools` 动态更新 provider tools；迁移完成后由固定 Adapter Tool 取代这条路径。
Phase 6 才接入 Capability RAG：推荐只影响短描述目录顺序或提示，不改变固定 Provider tools，也不负责硬过滤授权工具。
任何 Skill 或业务工具 Schema 都不能写入静态 Snapshot；它们只能以 canonical history event 追加。

### 4.4 预算与收益指标

每轮分别统计：

| 指标 | 含义 |
|---|---|
| `snapshot_chars` | 静态 Snapshot 中短描述目录字符数 |
| `tail_chars` | 本轮推荐提示字符数；工具声明后不重复计入展示部分 |
| `schema_chars` | canonical tool-schema 或兼容模式动态 Schema 的字符数 |
| `skill_chars` | 动态候选中实际注入 Skill 正文字符数 |
| `selected_tools` | Runtime 声明并注入 Schema 的工具数量 |
| `loaded_skills` | 本轮通过 `use_skill` 显式加载的 Skill 数量 |
| `recommended_tools` | RAG 推荐工具数量；不代表工具可见性或授权集合大小 |
| `route_latency_ms` | Capability RAG 召回和结果适配耗时 |
| `schema_tokens_estimate` | Schema 估算 token 数 |
| `provider_input_tokens` | provider 返回的实际输入 token，若可用 |

Phase 4 验收目标：

- 注册快照、Skill 使用标记和 Provider Schema 适配不改变现有调用语义。
- 能记录静态目录、Schema 字符数、digest、provider input token 和 P95 延迟。
- 工具调用成功率、确认门拦截率和 mutation 行为不低于迁移前基线。

Phase 5 验收目标：

- Provider 每轮只注册固定 Adapter Tool，不因声明业务工具修改 provider tools 前缀。
- `skill-schema`、`tool-schema`、`tool-call`、`tool-result` 均使用 canonical 类型并可跨 round/run 复用。
- Skill 首次加载只追加一次正文和关联 Schema；后续不重复注入。
- OpenAI、Anthropic、DeepSeek 等 provider 可从同一 canonical history 重建合法消息。
- 工具调用、权限、确认门、压缩和重放回归通过；声明后的 Cache 前缀保持稳定。

Phase 6 验收目标：

- Capability RAG 召回和适配 P95 小于 5ms，不增加额外 LLM 请求。
- 推荐命中率、推荐为空率和安全回归可解释；推荐失败不影响授权工具调用。

### 4.5 缓存策略

- Capability metadata 按 `registry_generation` 缓存。
- 短目录按“能力集合 + 平台 + 权限视图”缓存。
- 工具 Schema 按“工具名 + provider 格式 + Schema digest”缓存序列化结果。
- Skill 正文按“slug + 正文 digest”缓存，开发环境支持文件 mtime 失效。
- 任何权限变化必须使 Capability RAG 推荐结果失效，不能复用旧的授权视图或推荐顺序。

### 4.6 错误处理

| 错误 | 行为 |
|---|---|
| 注册重名 | 启动期失败，明确报告来源和冲突名称 |
| 短描述缺失/超长 | 内置能力启动失败；外部插件拒绝加载 |
| related tool 不存在 | 能力快照构建失败或标记该 Skill 不可用，不静默注入残缺 Skill |
| Capability RAG 无推荐 | 保留完整短描述目录，记录诊断，不影响 Agent 声明授权工具 |
| 模型需要未声明工具 | 兼容模式通过 `declare_tools` 补充；Phase 5 通过 canonical `tool-schema` + 固定 `call_tool` 处理 |
| Skill 正文加载失败 | 返回结构化能力加载错误，不执行关联工具 |

---

## 5. 迁移计划

### Phase 1：协议和适配层

实施文件范围：`backend/agent/capabilities/`、`backend/agent/tools/base.py`、`backend/agent/skills/__init__.py`、`backend/agent/skills/*.md`、`backend/tests/`。

- ✅ 新增 `CapabilityMeta`、`CapabilitySnapshot`、`SelectedCapabilities` 和注册期错误模型。
- ✅ 新增 Tool adapter：从现有 `Tool` 读取 metadata，不复制 handler、Schema validator 或 dispatch。
- ✅ 能力层不维护集中工具清单，直接适配现有工具模块自注册结果。
- ✅ 保留 `backend/agent/tools/__init__.py` 的导入职责，但不再把它当作工具注册清单；导入模块只用于触发自注册。
- ✅ 给 `Tool` 增加 `description_short`、`category`、`permissions`、`platforms`、`source`、关联 Skill 字段。
- ✅ 89 个默认工具均已有不超过 100 字符的短描述来源（优先显式 `description_short`，否则使用已有短 `label`）；禁止从完整 description 截断生成正式文案。
- ✅ 为默认 Markdown Skill 增加 `description_short`，并排除 skills README 参与自动扫描。
- ✅ 按社区作者视角编写 `backend/agent/tools/README.md` 和 `backend/agent/skills/README.md`。
- ✅ Skill 长触发说明已迁移到 `description_long`；`description` / `when` 仅保留读取兼容，注册诊断会报告残留字段。
- ✅ 能力 adapter 扫描 `backend/agent/skills/*.md` frontmatter，不硬编码 Skill 名称。
- ✅ CapabilityIndex 构建不可变快照并校验短描述与关联；generation 在快照生成时递增。
- ✅ 已覆盖注册失败、Unicode 长度、旧字段诊断、89 工具/10 Skill 完整快照、关联校验和 adapter 基础契约；Provider Schema 等价性由现有工具契约回归继续守护。

完成标准：所有内置能力都有明确短描述，Capability 快照可以构建；现有 Agent Loop 的工具执行路径和 Schema 输出不变。

### Phase 2：能力目录基础设施（不接入每轮推荐）

- ✅ 提供 `selector.py` 的可替换接口和兼容 selector，不实现第二套 BM25/Embedding。
- ✅ 能力快照提供短描述、类别、平台、关联 Skill 等 RAG 所需元数据的来源接口。
- ✅ 能力开关启用时将短描述目录放入静态 Snapshot context block。
- ✅ selector 支持无候选时的兼容模式；当前不启用每轮 RAG 推荐。

完成标准：能力快照和注入接口可稳定构建，默认不改变现有工具集合和调用结果；Capability RAG 的召回解释不作为本阶段验收项。

### Phase 3：按需注入与工具声明

- ✅ `LLMRunner` 增加可选 CapabilityToolContext，区分授权快照与 selected tool names。
- ✅ Anthropic/OpenAI/Ollama 三个 Driver 支持按 selected tool names 更新原生 tools 参数，复用现有 Schema 转换。
- ✅ Run 内每次模型请求前刷新 selected tool names 和 provider tools 参数。
- ✅ 兼容模式下 Snapshot 常驻短简介目录；首轮只提供固定 `declare_tools` Schema。
- ✅ 兼容模式下 Runtime 校验模型声明的工具名，并在下一轮只注入声明工具 Schema；固定 Adapter Tool 迁移归 Phase 5。
- ✅ 工具候选 tail 的 RAG 推荐、排序和去重仍后置到 Phase 6，不影响 Phase 5 的固定 Adapter Tool 链路。
- ✅ 保留 Skill 正文的显式 `use_skill` 延迟加载路径，本轮注册改动不复制正文。
- ✅ 未加载工具不进入当前 provider tools；`dispatch()` 继续按全局 registry 执行权限、Schema、确认门。
- ✅ 提供完整 Schema emergency switch，异常时可恢复原始全量工具路径。

完成标准：兼容模式首轮不注入业务工具完整 Schema；声明后只注入已授权且已注册的工具 Schema；固定 Adapter Tool 与 canonical history 目标归 Phase 5 验收。

### Phase 4：迁移、观测与稳定化（基础稳定化完成）

- ✅ 删除旧 `description` / `when` 解析兼容；Skill 只读取 `description_short`、`description_long`。
- ✅ 收敛目录职责：Builder 负责 Skill 索引，Capability Injector 负责能力目录/工具目录，Runner 不再重复注入 Skill 目录。
- ✅ Admin 增加只读能力目录接口和页面，展示短描述、类别、权限、平台和关联关系，不暴露完整 Schema/正文。
- ✅ 补齐 Provider Schema parity、history/dispatch、Skill marker、权限和 emergency switch 回归。
- ✅ 增加能力目录数量/字符数、Schema 目录数量、digest、授权/选中数量等脱敏 LoopScope 诊断指标。
- ✅ OpenAI、Anthropic、Ollama、MiniMax、DeepSeek 继续复用同一 Tool contract；Provider 差异只保留在 Driver/适配器测试中。
- ✅ 写工具继续由 `mutates`、`destructive`、确认 token 和既有 dispatch 核验链负责，能力目录不改变执行语义。
- 🔲 生成迁移前后字符数、provider input tokens、cache ratio 和 P95 的独立基线报告；该项不阻塞当前非 RAG 能力注册迁移，后续与性能测试一起完成。

### Phase 5：固定 Adapter Tool 与 canonical history（新增主实施阶段）

**当前状态：✅ 已完成（2026-08-23）。** 正常能力注入路径已经切换到固定 Adapter；兼容模式仍作为明确的 emergency switch 保留。

- ✅ 定义 provider-neutral 的 Schema event 与工具发现 canonical 类型，统一存入 `content_json`。
- ✅ 新增稳定的 `call_tool` Adapter Tool；正常 Provider 请求只注册 `call_tool`、`use_skill`、`ask_user`。
- ✅ 业务工具名和参数由 Runtime 解析，继续复用 registry、权限、Schema、确认门、ownership 和 destructive 校验。
- ✅ 将 Skill 自动注入结果以 `tool-schema` / `skill-schema` event 追加到 Session history，不伪装成 provider 原生 tool result。
- ✅ `use_skill` 首次调用时追加关联工具 Schema；相同版本/digest 的 event 不重复追加，后续 round/run 从 history 复用。
- ✅ Schema 保存 `tool_name + schema_version + schema_digest`，版本变化追加新 event，不原地修改历史。
- ✅ OpenAI、Anthropic、Ollama 及其兼容 Provider 从同一 canonical history 渲染合法消息。
- ✅ 工具历史按 canonical 事件持久化，Provider wire format 只在 adapter 边界生成。
- ✅ 保留现有 tool-call/tool-result 原子历史和 compaction/replay 回归；新增 canonical event、跨 Provider 和固定入口测试。
- ✅ 固定入口前缀不随业务 Schema 变化；完整 Schema、参数和正文不写入可见诊断日志。
- ✅ 兼容模式保留为明确的 emergency switch；正常路径不再调用动态 `update_tools()`。

当前不需要新增数据库迁移：优先复用现有 `ConversationMessage.content_json` 保存 canonical history。只有确认该字段无法承载 Schema event、版本、digest 和重放所需信息时，才另行增加 migration；禁止为了 Phase 5 预先新增专用工具历史表。

完成标准：业务工具声明不再改变 Provider 原生 tools 前缀；Skill 和工具 Schema 可在同一 Session 的后续 round/run 通过 canonical history 复用；三类 Provider 能从同一内部格式重建合法请求，权限和执行语义不变。

### Phase 6：Capability RAG 与每轮软推荐（后置）

- 🔲 与 `PRD-RAG-1` 对齐索引字段和 Capability RAG 查询接口。
- 🔲 使用 `filter_tool_names()` 和 `_filter_shell_tool()` 生成 RAG 可用的授权视图；安全过滤仍由 Runtime 执行，不由 RAG 复制。
- 🔲 使用 BM25/Embedding 生成工具推荐；本 PRD 不复制检索算法。
- 🔲 将推荐结果作为短描述目录顺序或提示，不改变固定 Provider tools，也不硬过滤授权工具。
- 🔲 评估推荐命中率、推荐为空率、Schema 成本、P95 延迟和安全回归，完成灰度后再打开默认开关。
- 🔲 将推荐数量、召回耗时、推荐理由和能力注入指标纳入 LoopScope 性能报告及现有 prompt/cache 报告。
- 🔲 清理 shadow mode、临时 fallback 和迁移 warning；保留明确的 emergency switch。
- 🔲 完成全量后端 CI、工具契约检查、确认门检查、权限检查和关键 E2E。
- 🔲 更新 `docs/product/PRD/README.md`、`docs/agent/30-提示词优化指南.md`、技能文案规范和 Changelog。

完成标准：Capability RAG 只提供授权工具推荐，不改变固定 Adapter Tool 链路，不承担 Schema 生成、权限判断或工具执行。

### Phase 7：插件/社区能力（后续）

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
- selector 对图片、画布、工作区、IM 和 Web 场景保留完整授权工具，并将相关工具排在推荐优先位置。
- 选中工具的完整 Schema 注入；未选中工具不注入。
- Skill 正文只在命中后加载，并且关联工具正确展开。
- 未声明工具通过 `declare_tools` 正常补充 Schema，不依赖 RAG 候选扩展。
- 现有 `dispatch()` schema 校验、destructive 确认门和 mutates 行为不变。
- LoopScope 记录字符数、估算 token 和 digest，但不记录用户原文或完整 Schema。

### 6.2 对比测试场景

至少覆盖：

1. 简单天气查询：只命中天气 Skill 和天气工具。
2. 图片识别/以图搜图：命中图片 Skill、`image_search` 和必要的验证工具。
3. 思维画布批量操作：命中画布 Skill 和相关 CRUD 工具，不加载文件、日历、shell Schema。
4. 工作区 shell：无工作区时不展示可执行 shell 能力；绑定后才显示。
5. 多步骤任务：推荐工具跨多个类别时，验证不会因为推荐漏召回而丢失必要工具。
6. IM 群聊：按群权限过滤工具，并验证被过滤工具无法绕过 dispatch。
7. 无法识别请求：保留完整短描述目录，不注入无关完整 Schema，同时允许模型声明任意授权工具。

### 6.3 灰度和回滚

- Phase 6 使用 shadow mode，不改变实际工具推荐和固定 Adapter Tool 注入。
- Phase 6 完成后增加配置开关，支持按用户、平台或 provider 灰度。
- 出现工具成功率、确认门或上下文错误明显回归时，关闭按需注入开关即可恢复旧 Schema 注入路径。
- 回滚不删除注册 metadata；只切换 injector 策略，保证迁移可继续。

---

## 7. 风险与待确认问题

| 风险 | 影响 | 对策 |
|---|---|---|
| RAG 推荐漏召回必要工具 | 模型可能忽略相关能力 | 全量短描述目录持续可见；推荐只调整顺序；用 shadow mode 统计推荐命中，不做候选硬裁剪 |
| 短描述写得过于模糊 | 模型无法正确发现能力 | 注册期只校验长度，内容质量通过人工 review、命中率和失败案例持续修订 |
| Skill 与工具关联维护不一致 | Skill 加载后找不到工具 | registry generation 构建时校验孤儿引用，禁止静默降级 |
| 权限状态变化后复用旧缓存 | 用户看到或调用已禁用能力 | 权限视图进入缓存 key，权限变化主动失效 |
| 多 Provider Schema 格式差异 | 某个模型无法调用候选工具 | 继续复用现有 provider adapter，分别做 OpenAI/Anthropic parity 测试 |
| 插件带来不可信代码 | 数据、文件和系统安全风险 | Phase 7 前不开放远程代码加载；插件 manifest、签名和沙盒另立安全评审 |
| 首轮能力目录仍然偏大 | 节省效果不明显 | 按类别和上下文过滤；记录 `catalog_chars`；必要时分层目录，不恢复全量 Schema |

### 待确认

- ✅ `description_short` 的 100 字符限制按 Unicode code point 计算，建议使用 Python `len()`，不是 UTF-8 字节数。
- 🔲 首版 Capability RAG 是否只做 BM25：建议是，先不增加额外 LLM 请求，等 shadow mode 有数据后再评估 embedding 或轻量意图模型。
- ✅ 首版不引入能力版本字段；如果未来插件市场需要版本、兼容范围或升级策略，另立插件 manifest 设计，不混入当前内置能力注册协议。
- ✅ 允许一个工具属于多个 Skill；工具与 Skill 是多对多关联，关联只用于发现、按需注入和 Skill 正文加载，不改变工具执行权限、确认门或 ownership 校验。
