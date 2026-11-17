# Gugu 2.0 Agent 工具与技能注册机制

## 决策

2.0 的工具（Tools）和可加载正文的技能（Skills）均保持统一注册器方案。延续 Python 的声明、注册、发现、校验与受控调用职责，采用显式 `register()` 和 Host 装配，不使用模块导入副作用修改进程全局注册表，也不另建 Agent 或插件框架。

注册、配置启用、平台能力、用户权限和操作确认是不同边界。配置只能收紧已装配能力，不能提供凭据、扩大文件授权根、授予用户权限或代替确认。没有真实后端的工具不装配；已注册但被停用的条目不可发现，也不可通过记住名字绕过配置调用。

## 工具注册器

实现：`packages/core/src/agent/tools/{contracts,registry}.ts`；公开入口 `@gugu/core/tools`。

- `ToolDefinition` 定义名称、模型 Schema、参数校验、处理器、读写属性和危险操作标记。
- `createToolRegistry({tools?, groups?, configuration?, authorize})` 创建独立注册器；兼容已有 `tools` 数组装配。
- `register(tool)` 注册单个工具；`registerGroup({id,name,tools})` 注册领域工具分组。重名、空名和无效处理器拒绝；分组验证全部成功后才注册，失败不留下部分工具。
- `configure({tools?,groups?})` 原子替换启用配置。两个字段都是名称到 boolean 的映射；省略项默认启用。未知工具或分组、非 boolean、错误配置字段拒绝，保留旧配置。
- 领域分组停用时，即使单项设为 true 也不能启用。工具被单独停用时也不可用。
- `capabilities(identity)` 输出已启用且通过可信授权的 Schema 副本；`tools.dispatch` 在实际调用时重新检查配置、授权与参数。等待授权期间停用也会拒绝执行。
- 发现阶段保存身份副本；dispatch在等待前保存冻结的scope/身份、调用坐标及深拷贝的JSON参数。外部修改原对象不能切换实际owner、参数或取消signal。参数快照复用Harness的可持久JSON规则，访问器等非法值不执行；非法参数仍在授权通过后安全拒绝。

```ts
const registry = createToolRegistry({ authorize })
registry.registerGroup({
  id: 'clients', name: '联系人', tools: createClientTools(core),
})
registry.register(createTimeTool({ now, timezone }))
registry.configure({ groups: { clients: true }, tools: { update_client: false } })
// Host 将 registry.tools 注入既有 Harness，将 capabilities 接到工具发现端口。
```

工具分组对应 Python `BaseSkill` 的领域工具集合，不等同于技能正文。为避免混淆，工具集合使用 `Group` 命名。

当前注册器复用既有 ToolPort/Executor。危险工具在可信持久确认链接通前始终拒绝开放，即使配置设置 true。普通工具不接受模型伪造的交互确认；写入结果未知返回 unknown，不在恢复时重放。当前配置更新不强制中断已经启动的操作，执行中的取消继续遵循 Harness 的 signal 和资源清理契约。

已有输入兼容实际发生时，成功对象可带`input_adaptations`，只报告固定规则和可信Schema路径，不回显参数值。列表、字符串、错误、待确认及未知写入结果保持既有结构；反馈不影响授权、确认或工具启用配置。未知字段名及任意wrapper键的安全回显策略仍未完成，不能把修复回执视为Python全部输入协议已迁移。具体行为与真实SQLite回归见[输入兼容记录](../testing/node-agent-input-contract-parity.md)。

## 技能正文注册器

实现：`packages/core/src/agent/skills/{contracts,registry,index}.ts`；公开入口 `@gugu/core/skills`。

内置技能沿用 Python 的 Markdown 注册来源：可信 Host 提供文档，Core 读取文件头的 frontmatter（如 `id`、`name`、描述和 `related_tools`）生成定义，再显式注册到 SkillRegistry；正文在调用时按需读取。不能仅凭文件名或另维护一份硬编码目录冒充 Markdown 注册。现有 `createBuiltinSkillDefinitions` 已实现这一解析边界；生产 Host 文档来源及装配尚未完成，仍须按平台能力和授权控制可用技能。

- `SkillDefinition` 包含稳定 `id/name/description` 以及可信 `load(identity,signal)`；loader 从共享技能服务读取正文和 contentDigest，不接受模型传入 owner、物理路径或凭据。
- `createSkillRegistry({skills?,configuration?,authorize})` 创建独立注册器；`register(skill)` 显式注册。空 ID、重名及无效 loader 拒绝。
- `configure({skills:{[id]:boolean}})` 原子替换配置；省略项默认启用。未知 ID、非法类型或拼错配置字段拒绝，不覆盖旧配置。
- `catalog(identity)` 只返回通过配置和授权的目录元数据，不加载正文。
- `load(id,identity,signal)` 在读取前和交付正文前分别判权，返回 `id/name/content/contentDigest`；加载期间停用或撤销权限时不再发布正文。取消等待 loader 清理后传播；原始异常使用固定安全错误替代。
- 注册时保存元数据和 loader 快照，外部修改原对象不能替换已经注册的技能。正文不缓存为跨用户全局值。

```ts
const skills = createSkillRegistry({ authorize: authorizeSkill })
skills.register({
  id: 'S1', name: '项目计划', description: '整理目标和项目阶段',
  load: (identity, signal) => skillService.load(identity, 'S1', signal),
})
skills.configure({ skills: { S1: true } })
const index = await skills.catalog(identity)
const body = await skills.load('S1', identity, signal)
```

目录进入 Harness 的现有 catalog/会话快照边界；正文按需加载。用户技能的 owner 校验、访问范围、内容摘要、持久化与版本由共享服务负责，注册器不复制数据库逻辑。模型获得 Skill 正文不会因此获得任何 Tool 权限，正文也不得注入当前用户的运行时权限事实。

## 当前实现与验收边界

两种注册器都已提供显式注册、配置启停和调用时权限校验。配置入口是可信 Host 的内存 API，不会读取或改写用户运行配置；配置持久化、管理 UI、热更新广播和各 Host 的配置来源尚待接线，不视为已经实现。

Tool 的领域切片状态见 [工具迁移清单](../testing/node-agent-tools-parity.md)。Skill 注册器不等同于 Python `use_skill`、内置技能资源、用户技能 CRUD、当前上下文去重及 contentDigest 标记已全部迁移；这些真实调用方与服务仍须分别接入和验收。

行为回归位于 `packages/core/tests/agent/tools/registry.test.ts` 和 `packages/core/tests/agent/skills/registry.test.ts`，保护注册失败原子性、配置启停、撤权、可信身份、错误脱敏与取消。注册器通过不代表任一领域后端或生产 Host 已完成迁移。

### 本轮验证

Node 26：`vitest run tests/agent/tools tests/agent/skills`，6 文件67项通过，0失败/跳过；源码与测试类型检查通过。工具注册器10项、技能注册器18项，覆盖上述配置和安全边界；其余为已迁移领域工具。Skill loader 为受控测试替身，不证明真实技能存储、use_skill 或生产 Host 已接通。整树质量检查存在其他并行 Provider 变更的阻断，不能据此宣称全仓质量门通过；本轮未修改这些文件。

Python 最近邻串行基准：`test_capability_registry.py`、`test_skill_id_migration.py`、`test_project_agent_context.py` 共17通过、0失败/跳过；新增配置接口为2.0明确新增能力，不把这些Python测试当配置等价覆盖。

后续定向复验：工具与技能两个`registry.test.ts`合计39项通过，0失败/跳过，继续保护显式注册、配置启停与调用时授权。该结果不升级生产Host装配或配置持久化状态。

## 内置 Markdown 技能资源适配

`createBuiltinSkillDefinitions(documents, signal)` 将可信 Host 提供的 `{name,read(signal)}` 文档转换为 SkillDefinition。Core 构建脚本 `scripts/build-skills.mjs` 自动发现 `packages/core/resources/skills/` 下全部 Markdown（README除外），再沿用 Python 扁平 frontmatter 读取 `id`、名称、短/长描述、分类、emoji、来源和关联工具；不使用 `manifest.json` 或手写 ID/文件注册清单。SkillRegistry 对元数据保存独立快照，正文每次加载重读，UTF-8 SHA256前16位与Python摘要一致；重复ID拒绝，加载时ID漂移拒绝。文件操作、定时任务和 Shell 正文仍未复制到 Node 资源目录，因此不会被自动发现或提前启用。

当前 Core 资源目录中的 Markdown 由构建脚本自动发现，并打包到 `@gugu/core/skills/bundled`；Host 将打包文档交给 `createBuiltinSkillDefinitions` 生成定义，再传给 SkillRegistry 显式注册。Web Host 当前用这些定义生成共享能力目录，但 Agent Run 的 `use_skill` 注册器端口仍未接通。注册后的目录名称/描述固定，正文与摘要可更新；修改目录元数据需重新装配注册器，避免热编辑改变已冻结目录。来源字段限定builtin/user，是相对旧Python任意source字符串的明确收紧。

### 注册期声明校验

注册时检查公开工具envelope与输入Schema的区别：function.name必须与注册名一致，parameters或input_schema根必须为object；read/write属性、validate/execute处理器必须合法。当前公开声明的常用关键字（type、properties、required、items、组合、计数及数值界限等）使用现有Zod做形状校验，循环或非JSON值拒绝；无效分组不留下工具或成员关系。

该检查不是完整Draft 2020-12元Schema验证，也不替代工具实例参数validator；未覆盖的关键字/引用解析与公开Schema和validator完整一致性仍需继续迁移。raw输入Schema不能被误当完整公开工具envelope注册。行为回归包含所有当前真实工具工厂的声明可注册，但不调用其后端，不作为领域功能完成证据。

### 同轮工具调度

注册器直接生成既有 Harness 的 ToolPlan，不另造调度器。默认并发上限为5，可信Host可通过`maxConcurrency`设为1–128的整数；该选项不接受模型输入。同一轮的普通读写调用均可并行，不依据read/write标记推测业务冲突。未知、停用、协议解析失败、非对象输入以及`ask_user`、`manage_mcp_servers`或声明`requiresInteraction`的调用分流串行；参数是否合法仍由每项实际dispatch决定，单项非法参数不阻断其他调用。

`requiresInteraction`仅为调度声明，不授予交互或确认权限。目前危险工具仍不开放并保守分流串行，不能据此声称已等价支持Python可用危险工具的并发资格。实际执行继续逐项重新授权、校验配置和参数；取消等待handler清理，写入状态不明继续返回unknown而不自动重放。技能加载和工具调度均复用Harness已有上下文边界，不新增跨用户共享的加载状态。

`ToolDefinition.strictArrayFields`由可信注册代码声明，按叶字段名限制数组的item/block包装和顶层拍平修复；注册器保存冻结副本，模型参数和外部数组后续修改不能解除限制。JSON数组文本仍按既有规则解析并进入原validator。该策略是参数兼容边界，不是工具启用配置，也不提供任何权限。
