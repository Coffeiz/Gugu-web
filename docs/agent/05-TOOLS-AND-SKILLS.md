# 工具与 Skill 架构

> 本文描述当前 Gugu Agent 的工具与 Skill 能力层。它记录模块关系、能力流转和安全边界；具体工具参数、字段约束和用户界面以代码、测试及对应 PRD 为准。

## 1. 架构定位

工具和 Skill 是 Agent 的能力层：

- **Tool** 是可以被 Agent 调用并产生真实副作用或查询结果的执行能力。
- **Skill** 是对任务处理方法、步骤和约束的说明，不直接执行代码，也不新增权限。
- **Capability Index** 将工具和 Skill 的注册信息合并为可查询的能力目录。
- **Capability Selector / Injector** 根据当前请求和已有授权选择要展示、加载或注入的能力。
- **Dispatch** 是执行前的最终边界，负责 Schema、归属、权限、确认和运行环境校验。

能力层不替代 Agent Loop。它回答“有哪些能力、当前可以看到什么、如何调用”，不决定完整任务计划，也不绕过 Agent Loop 的状态机。

## 2. 总体关系

```text
工具声明 ──────> ToolRegistry ───┐
                                  ├──> CapabilityIndex
Skill 元数据 ──> SkillRegistry ──┘          |
                                             v
                                 Selector / Injector
                                  |       |       |
                              目录信息  Schema   Skill 正文
                                  |       |       |
                                  +───────v───────+
                                      Agent Loop
                                             |
                                      Tool Dispatch
                                             |
                           业务服务 / sandboxd / canonical history
```

注册表负责声明和索引，注入器负责模型可见上下文，dispatch 负责真实执行。三者不能互相代替。

## 3. 注册表边界

### 3.1 ToolRegistry

工具注册的原子单位是单个工具，而不是领域工具组。工具声明至少包含：

- 稳定的工具名；
- 面向模型和管理界面的短描述；
- 当前源码中的规范 `input_schema`；
- 类别、来源和关联 Skill 等 metadata；
- 实际 handler 及其执行契约。

现有 `BaseSkill` 仍可用于 Python 模块内批量组织工具，但它只是导入和领域分组方式，不是模型侧的 Skill 能力。工具组或 Profile 只能作为筛选输入，不能替代单工具注册。

### 3.2 SkillRegistry

系统 Skill 主要来自 `backend/agent/skills/*.md`，通过 metadata 注册简介和关联工具，再由 `use_skill` 按需加载正文。用户 Skill 使用同一套字段和校验模型，但来源和 ownership 不同。

Skill 可以声明关联工具，用于发现和流程提示；关联关系不授予工具权限。Skill 正文也不能注册新的 handler、修改系统提示词或要求执行未授权工具。

### 3.3 CapabilityIndex

`CapabilityIndex` 只合并 ToolRegistry 和 SkillRegistry 的可发现信息，生成不可变的能力快照。它不复制：

- 工具 handler；
- Provider Schema；
- 用户权限判断；
- Skill 正文；
- canonical history。

快照可以被目录展示、selector、injector、Admin 和 LoopScope 使用；权限和执行判断仍回到 Runtime 的事实来源。

## 4. 能力快照与选择

能力选择大致经过以下边界：

```text
已注册能力
    -> 当前用户 / 平台 / 会话授权交集
    -> Capability Snapshot
    -> Selector（按请求选择或排序）
    -> Injector（生成目录或固定 Adapter 输入）
```

Selector 可以减少本轮需要介绍的能力，不能扩大授权范围。Capability RAG（如果启用）只提供推荐顺序或软提示，不负责授权、不直接执行工具，也不应复制权限逻辑。

工具注册表快照在进程内固定，工具新增或 Schema/metadata 修改必须重启 backend 才会进入新的快照；运行中不得静默追加或替换工具。用户 Skill 的目录 metadata 则固定在会话 snapshot 中，Skill 编辑不会改写当前 prompt，只有 `use_skill` 会按 owner 实时读取正文和最新 digest。用户权限、平台能力和确认门仍属于执行时事实，不能因为 snapshot 而放宽。

## 5. Tool Schema 与注入

当前工具 Schema 有两种产品模式，但共享同一份源码契约：

- **全量模式（默认）**：注入当前工具源码中的规范 Schema，适用于参数结构复杂、准确性优先的场景。
- **简介模式**：首轮提供全部已授权工具的用途、字段签名、类型和必填状态，并保留有限路由信息，控制首轮上下文成本。

按需场景通过固定的能力 Adapter 获取具体 Schema。Schema 是机器契约，负责表达类型、枚举、互斥字段、条件必填和边界；description 只补充无法结构化表达的简短语义。

Provider 不维护第二份业务 Schema，也不能用自己的 wire 格式重新定义工具语义。Provider 只负责把统一能力输入转换成 Anthropic、OpenAI-compatible 或 Ollama 所需的请求格式。

## 6. Skill 正文加载

Skill 的常驻信息和正文分开处理：

```text
首轮：Skill 短描述目录
  -> Agent 判断需要某个 Skill
  -> use_skill 加载正文
  -> 内容指纹与使用标记进入当前 Run
  -> 后续 round 通过 history 复用，不重复注入正文
```

Skill 使用标记用于判断同一会话中是否已经加载过正文；它不是权限凭证。正文经过压缩或截断后，如果使用事实和正文一同消失，后续 Run 才可以重新加载。

## 7. 工具调用与执行链

```text
模型能力目录 / 已加载 Schema
        |
        v
解析 tool name 与 arguments
        |
Schema / 条件约束校验
        |
ownership / 用户、平台、会话权限校验
        |
destructive confirmation（如需要）
        |
业务 handler 或 sandboxd
        |
canonical Tool Result
        |
history、LoopScope 与渠道事件
```

工具成功和失败都必须形成结构化结果。没有真实执行回执时，Agent 不能把模型文字当成操作已完成。工具结果进入 canonical history 后，由不同渠道适配为各自展示格式。

## 8. 权限与安全边界

能力“可发现”、Schema“已注入”和工具“可执行”是三个不同状态：

1. 注册表确认能力存在且结构合法。
2. Selector / Injector 根据授权决定模型能否看到或加载。
3. Dispatch 在执行时再次检查用户归属、平台限制、会话状态和工具权限。
4. 破坏性操作进入确认门；Shell 操作进入 workspace、网络、配额和 sandboxd 边界。

隐藏目录不能作为安全措施。用户 Skill 不能通过正文恢复未授权工具、伪造系统来源、跨用户读取数据或修改注册表。公开资源查询也必须经过 ownership 校验。

## 9. Provider 与历史边界

工具和 Skill 的统一语义在 Provider 之前形成：

```text
Capability metadata / canonical tool event
        -> Provider adapter
        -> provider wire schema / messages
        -> model response
        -> canonical tool call / result / interaction
```

Provider adapter 可以改变字段包装和协议格式，但不能：

- 改变工具名、参数语义或结果归属；
- 删除工具调用与结果之间的关联；
- 把 Provider wire JSON 当作历史事实；
- 越过统一权限和确认门。

Skill 正文、工具调用、工具结果和交互状态的持久化边界由 Context 与 Agent Loop 负责，不由渠道或 Provider 私自维护。

## 10. 当前模块与职责

| 模块 | 职责 |
|---|---|
| `backend/agent/capabilities/models.py` | 能力 metadata、快照和选择结果结构 |
| `backend/agent/capabilities/tool_registry.py` | 从工具注册表生成工具能力目录 |
| `backend/agent/capabilities/skill_registry.py` | Skill 元数据、来源和用户 Skill 校验 |
| `backend/agent/capabilities/index.py` | 合并工具与 Skill 的能力索引 |
| `backend/agent/capabilities/selector.py` | 授权能力选择及可替换的推荐策略 |
| `backend/agent/capabilities/injector.py` | 目录、固定 Adapter 和按需 Schema 注入 |
| `backend/agent/tools/base.py` | Tool、BaseSkill、注册和 dispatch 基础契约 |
| `backend/agent/tools/` | 业务工具及其 handler |
| `backend/agent/skills/` | 系统 Skill 正文和 metadata |
| `backend/agent/providers/` | Provider 协议适配 |
| `backend/agent/context/canonical_tool_history.py` | canonical 工具事件及 Provider history 投影 |

## 11. 可观测性与测试

能力层诊断应区分：

- 注册能力数量；
- 授权能力数量；
- 本轮选择和省略的能力；
- 目录与 Schema 的字节/token 成本；
- Skill 加载、Schema 获取、工具调用和 dispatch 结果。

诊断只能记录脱敏 metadata、digest、状态和耗时，不能把用户正文、附件名、工具凭据或完整敏感参数写入普通日志。

当前主要回归覆盖：

- `test_capability_registry.py`：注册表与快照；
- `test_capability_selector.py`：授权选择；
- `test_capability_injection.py`：目录和 Schema 注入；
- `test_user_skills.py`：用户 Skill 来源、归属和校验；
- `test_tool_schema_validation.py`：工具 Schema 与 dispatch；
- `test_canonical_tool_history.py`：工具事件跨 Provider 历史投影。

## 12. 当前限制与后续方向

- Capability RAG 只负责软推荐，默认关闭或处于 shadow 观测时不改变授权目录。
- 当前不开放用户自定义可执行 Tool、任意第三方代码热加载或自动安装插件。
- 用户 Skill 可以复用已有工具，但不能提升工具权限或绕过确认门。
- 具体工具契约和 Provider parity 以源码规范 Schema、测试和 PRD-LLM-16 为准。
- 后续 06–10 文档分别补充 RAG/Knowledge、Memory/Reflection、渠道、消息协议和可靠性架构，不在本文重复展开。
