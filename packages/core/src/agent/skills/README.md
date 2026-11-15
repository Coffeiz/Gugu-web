# Skill 注册与开发规范

本目录对应旧 Python `agent/skills/` 的 Prompt Skill 能力，注册逻辑沿用 Markdown 头部元数据；实现迁到 Node/TypeScript，不改成手写技能名称或 ID 的注册清单。

## Markdown 格式

```markdown
---
id: S1
name: 资料搜索
description_short: 用户需要查找或核对资料时使用。
description_long: 说明适用的问题和触发条件。
category: search
related_tools: global_search, read_file
source: builtin
---

这里写需要时才加载的技能正文。
```

沿用 Python 的扁平 `key: value` frontmatter，不扩展为完整 YAML。系统技能使用稳定且唯一的 `S#` ID；文件名只负责组织，身份由头部 ID 决定。`description_short` 作者需控制在 1–100 个 Unicode 字符，长说明使用 `description_long`，完整步骤写在正文；新文档不用旧 `description` / `when` 字段。不把完整工具 Schema 或运行时权限写入正文。

## 模块职责

| 模块 | 职责 | 不负责 |
| --- | --- | --- |
| `builtin.ts` | 读取可信 Host 提供的 Markdown 资源，解析头部、检查重复 ID、构造可注册定义，按需重读正文并计算摘要。 | 枚举任意宿主目录、从模型参数选择路径、伪造用户资源。 |
| `registry.ts` | `register/configure/catalog/load`，元数据快照、配置及授权；正文读取后重新检查可见性。 | 数据库写入、平台身份与授权事实、技能正文的编写。 |
| `contracts.ts` | Skill 元数据、定义、加载结果、配置、可信 loader 和注册器契约。 | 工具执行或自动授予关联工具权限。 |
| `user-read.ts` | 组合Markdown head定义与owner限定用户元数据目录，含停用项并按casefold排序。 | 读取正文、授予关联工具权限、伪造用户资源或Schema升级。 |
| `index.ts` | 统一公共出口。 | 旧路径兼容转发。 |

Host 负责扫描和打包实际 Markdown 资源，传入 `BuiltinSkillDocument` 后由 `createBuiltinSkillDefinitions` 读取头部生成定义，再交 `createSkillRegistry` 注册。资源正文未读取成功时不造元数据假成功。`source` 字段不能建立身份或权限；用户 Skill 必须经可信的 owner-scoped 领域来源加载，不能只改 frontmatter 冒充内置资源。

## 与工具注册器的关系

工具组注册独立于 Prompt Skill 注册。Skill 的 `related_tools` 是元数据，不是授权清单，不自动开放工具。`tools/meta.ts` 的 `use_skill` 通过可信 Skill 注册器按需加载正文；加载摘要和来源绑定进入运行上下文后才代表本轮使用过该技能。

Skill 创建、更新、删除应放在工具领域 `skill-management` 中，复用共享 Skill 生命周期服务和危险操作确认，不能绕过该服务直接写表。当前未就绪的用户资源、Host 扫描或生产装配保持依赖缺口，不用内置示例正文冒充已迁移。

## 安全与回归

loader 接收可信身份和取消信号；调用前后及正文发布前检查取消与可见性。相同 ID 不能跨 owner 或来源复用正文摘要，模型不能提交物理路径、owner 指纹或授权材料。读取失败和未知来源返回安全错误，不泄漏文档正文、凭据或原始异常。

注册器与 Markdown 行为测试放在 `tests/agent/skills/`，工具加载及上下文使用记录分别由工具和运行上下文测试保护。覆盖头部解析、ID 重复、配置启停、撤权、取消、来源隔离、正文重读与摘要变化；登记元数据并保留 Python 基准。真实资源打包、用户领域服务和生产 Host 接入需要独立验收。

`list_skills`复用此共享目录，与`registry.catalog`可加载能力不同：管理目录保留停用项，正文和摘要不参与查询。Host必须提供完整用户表能力及真实Markdown定义，未装配不开放；不能只列内置技能冒充全部目录。
