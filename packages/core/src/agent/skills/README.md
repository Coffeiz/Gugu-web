# Skill 注册与开发规范

本目录对应旧 Python `agent/skills/` 的 Prompt Skill 能力，注册逻辑沿用 Markdown 头部元数据；实现迁到 Node/TypeScript，不改成手写技能名称或 ID 的注册清单。

## Markdown 格式

```markdown
---
name: 资料搜索
description: 用户需要查找或核对资料时使用。
category: search
related_tools: global_search, view_image
source: builtin
---

这里写需要时才加载的技能正文。
```

使用扁平 `key: value` frontmatter。内置技能只写一个 `description`，完整步骤放在正文。文件名去掉 `.md` 后作为稳定键。系统按文件名字符顺序生成连续的 `S1`、`S2` 等调用编号。

## 模块职责

| 模块 | 职责 | 不负责 |
| --- | --- | --- |
| `builtin.ts` | 读取 Core 打包的 Markdown 文档，解析头部、检查重复文件名、构造可注册定义，按需重读正文并计算摘要。 | 枚举任意宿主目录、从模型参数选择路径、伪造用户资源。 |
| `packages/core/scripts/build-skills.mjs` | 自动发现 `packages/core/resources/skills/*.md`，验证 frontmatter 并生成 bundled 文档模块；文件名决定稳定键和编号顺序，头部提供描述等元数据。 | 维护手写 manifest、扫描 Python 或 Host 目录、将 Skill 正文放入工具权限判断。 |
| `registry.ts` | `register/configure/catalog/load`，元数据快照、配置及授权；正文读取后重新检查可见性。 | 数据库写入、平台身份与授权事实、技能正文的编写。 |
| `runtime.ts` | 组合单个 Agent Run 的内置定义与 Host 提供的 owner 用户目录/正文端口；统一校验启用项、owner、来源与指纹。 | 查询数据库、生成平台身份/指纹、枚举文件系统或授予工具权限。 |
| `contracts.ts` | Skill 元数据、定义、加载结果、配置、可信 loader 和注册器契约。 | 工具执行或自动授予关联工具权限。 |
| `user-read.ts` | 组合Markdown head定义与owner限定用户元数据目录，含停用项并按casefold排序。 | 读取正文、授予关联工具权限、伪造用户资源或Schema升级。 |
| `index.ts` | 统一公共出口。 | 旧路径兼容转发。 |

内置 Prompt Skill 的 Markdown 源文件归 Core，放在 `packages/core/resources/skills/`。Core 构建脚本按文件名自动发现 `.md` 并打包；运行时 `createBuiltinSkillDefinitions` 读取 frontmatter 头部生成定义，再交 `createSkillRegistry` 注册。新增或移除 Markdown 文件无需同步编辑清单。启停配置和新回执使用稳定键。读取旧配置和历史回执时按升级前的固定编号映射解析，稳定键配置优先，历史记录保留原始内容。Web Host 消费 Core 导出的 bundled 文档，并按可信 owner 装配用户 Skill 读取端口，不扫描宿主目录。资源正文未读取成功时不造元数据假成功。`source` 字段不能建立身份或权限；用户 Skill 必须经可信的 owner-scoped 领域来源加载，不能只改 frontmatter 冒充内置资源。

`createAgentSkillRuntimePorts` 在 Core 按 Run owner 组合内置和用户技能；Host 只提供当前租约的 owner、用户 Skill 列表/正文读取和安全指纹端口。Core 再次检查 owner、已启用目录项、用户来源与加载时可见性，禁止模型参数或 Skill 正文选择其他 owner。

## 与工具注册器的关系

工具组注册独立于 Prompt Skill 注册。Skill 的 `related_tools` 是元数据，不是授权清单，不自动开放工具。`tools/meta.ts` 的 `use_skill` 通过可信 Skill 注册器按需加载正文；加载摘要和来源绑定进入运行上下文后才代表本轮使用过该技能。

Skill 创建、更新、删除应放在工具领域 `skill-management` 中，复用共享 Skill 生命周期服务和危险操作确认，不能绕过该服务直接写表。用户资源仍需可信的 owner-scoped 服务和生产装配，不用内置示例正文冒充用户数据。

## 安全与回归

loader 接收可信身份和取消信号；调用前后及正文发布前检查取消与可见性。相同 ID 不能跨 owner 或来源复用正文摘要，模型不能提交物理路径、owner 指纹或授权材料。读取失败和未知来源返回安全错误，不泄漏文档正文、凭据或原始异常。

注册器与 Markdown 行为测试放在 `tests/agent/skills/`，工具加载及上下文使用记录分别由工具和运行上下文测试保护。覆盖自动发现、头部解析、ID 重复、配置启停、撤权、取消、来源隔离、正文重读与摘要变化；登记元数据并保留 Python 基准。真实 PostgreSQL、用户领域服务及生产 Host Run 仍需独立验收。

`list_skills`复用此共享目录，与`registry.catalog`可加载能力不同：管理目录保留停用项，正文和摘要不参与查询。Host必须提供完整用户表能力及真实Markdown定义，未装配不开放；不能只列内置技能冒充全部目录。
