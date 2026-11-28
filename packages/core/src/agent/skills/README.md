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
| `user-read.ts` | 从 Markdown head 定义内置技能的管理元数据；用户技能元数据由 `bundle-store.ts` 从当前用户文件目录读取。 | 读取技能正文、授予关联工具权限、查询旧技能表。 |
| `index.ts` | 统一公共出口。 | 旧路径兼容转发。 |

内置 Prompt Skill 的 Markdown 源文件归 Core，放在 `packages/core/resources/skills/`。Core 构建脚本按文件名自动发现 `.md` 并打包；运行时 `createBuiltinSkillDefinitions` 读取 frontmatter 头部生成定义，再交 `createSkillRegistry` 注册。新增或移除 Markdown 文件无需同步编辑清单。启停配置和新回执使用稳定键。读取旧配置和历史回执时按升级前的固定编号映射解析，稳定键配置优先，历史记录保留原始内容。Web Host 消费 Core 导出的 bundled 文档，并按可信 owner 装配用户 Skill 读取端口，不扫描宿主目录。资源正文未读取成功时不造元数据假成功。`source` 字段不能建立身份或权限；用户 Skill 必须经可信的 owner-scoped 领域来源加载，不能只改 frontmatter 冒充内置资源。

`createAgentSkillRuntimePorts` 在 Core 按 Run owner 组合内置和用户技能；Host 只提供当前租约的 owner、用户 Skill 列表/正文读取和安全指纹端口。Core 再次检查 owner、已启用目录项、用户来源与加载时可见性，禁止模型参数或 Skill 正文选择其他 owner。用户目录只从文件技能包发现，不从 SQL 技能表回退或合并。

## 与工具注册器的关系

工具组注册独立于 Prompt Skill 注册。Skill 的 `related_tools` 是元数据，不是授权清单，不自动开放工具。`tools/meta.ts` 的 `use_skill` 通过可信 Skill 注册器按需加载正文；加载摘要和来源绑定进入运行上下文后才代表本轮使用过该技能。

Skill 创建、更新、删除应放在工具领域 `skill-management` 中，复用共享 Skill 生命周期服务和危险操作确认，不能绕过该服务直接写表。`file-tools.ts` 定义文件技能创建和更新的共享参数，`file-document.ts` 统一文档字段校验，`file-port.ts` 统一授权复核和持久收据，`file-storage.ts` 负责文件变更日志与恢复。Web、IM 和桌面 Agent 的创建、更新工具使用文件事务并登记技能 Undo 记录；桌面通过宿主锁与文件操作串行，具体场景仍受权限策略限制。Agent 删除使用 `file-delete.ts` 确认完整目录摘要，`file-delete-port.ts` 在持久事务中认领确认，`file-delete-storage.ts` 记录移动日志并在失败后恢复；桌面提交后将删除登记到文件历史。旧 SQL 技能表仅由启动切换过程读取，运行时和管理路径不回退到旧表。

## 安全与回归

loader 接收可信身份和取消信号；调用前后及正文发布前检查取消与可见性。相同 ID 不能跨 owner 或来源复用正文摘要，模型不能提交物理路径、owner 指纹或授权材料。读取失败和未知来源返回安全错误，不泄漏文档正文、凭据或原始异常。

注册器与 Markdown 行为测试放在 `tests/agent/skills/`，工具加载及上下文使用记录分别由工具和运行上下文测试保护。覆盖自动发现、头部解析、ID 重复、配置启停、撤权、取消、来源隔离、正文重读与摘要变化；登记元数据并保留 Python 基准。文件技能按 owner 根目录隔离，启动切换及生产 Host Run 由对应宿主集成测试验证。

`list_skills`复用此共享目录，与`registry.catalog`可加载能力不同：管理目录保留停用项，正文和摘要不参与查询。Host必须提供当前 owner 的文件技能目录及真实 Markdown 定义，未装配不开放；不能只列内置技能冒充完整目录。

## 用户技能包迁移约定

用户技能包采用单目录入口 `SKILL.md`。用户技能目录为
`<用户数据父目录>/<用户 UUID>/.agent/skills/user/<slug>/SKILL.md`，ClawHub 安装包位于同级 `clawhub/<slug>/SKILL.md`。
数据父目录由可信宿主提供，用户技能目录通过 `userSkillDirectory` 解析。旧数据一次性迁移在写入前检查全部目标；已有不同内容或不完整目录时报告冲突，保留原文件。`cutoverLegacySkillBundles` 在事务中锁定旧记录、写入并复核文件，将当前用户的消息、待发送队列和笔记正文中的旧技能引用转换为目录标识，再将旧行标为 `migrated`。笔记代码区和转义文字不参与转换；数据库回滚时引用和旧行保持原状，重试复用完全相同的文件。桌面宿主及 Web 宿主在接收请求前执行一次切换；桌面导入旧技能时持有目录锁并在导入后执行切换。迁移完成后，运行时、目录、搜索、管理和删除只使用文件包，不保留旧 SQL 读写路径。
`bundle.ts` 负责校验技能入口、解析 YAML，并保留导入文档原文。
`patchSkillDocument` 仅更新指定的名称、描述、正文或 `metadata.gugu` 字段，保留其他厂商的 frontmatter 与未修改的正文；遇到无法安全合并的元数据结构时返回冲突，不覆盖原内容。
技能包保留 YAML frontmatter 的 `name`、`description` 及其他字段，以及
`references/`、`assets/` 等相对路径资源。新建技能通过共享校验生成 `SKILL.md`，
启用状态和咕咕扩展字段保存在 `metadata.gugu`；新建与安装都进入文件撤销/重做历史。

`clawhub.ts` 调用 ClawHub 搜索接口，并通过 `sort=trending` 提供热门技能目录；热门列表请求排除标记可疑的条目。搜索结果只保留当前安装器支持的 ClawHub 来源；其他市场的混合结果不作为可安装技能展示。两条路径都经过宿主提供的受限网络传输。

`clawhub-download.ts` 使用 ClawHub 的公开下载接口获取 ZIP，验证入口文档、相对路径、文件类型和大小限制后返回完整文件集合。它不执行脚本，也不写入用户目录；宿主必须将文件集合交给经过授权且支持撤销重做的安装事务。ClawHub 返回 GitHub 来源交接信息时，目前会明确报告不支持，不能把该响应当成成功安装。

`package-stage.ts` 将校验后的完整文件集合暂存在用户 UUID 下的 `.agent/.skill-staging/`，并把暂存目录和目标目录交给宿主的 `commit` 端口；暂存失败或事务返回后清理暂存目录。该端口本身不提交安装、登记启用状态或创建撤销记录，生产宿主必须在事务中完成这些操作。

模型目录项含 `id`、`name`、`description`，并在宿主已提供本轮可读取的目录时附带
`path`。模型按需加载正文，目录位置从可信运行适配器获取；用户技能没有 SQL 正文读取回退。
Web Shell 将 `<用户 UUID>/.agent/skills/` 只读挂载到容器根目录 `/skills`；Agent 注入的用户技能路径为 `/skills/user/<slug>`，ClawHub 技能路径为 `/skills/clawhub/<slug>`，与 `/personal`、`/project` 同属容器根目录。Desktop 使用 `<数据目录>/<用户 UUID>/.agent/skills/user/` 与 `clawhub/` 的实际路径。IM 私聊 owner 可加载文件技能，群聊不会加载 owner 文件技能。定时任务可以调用文件技能，但没有 Shell 时不公布不可访问的目录路径。技能目录不是工具权限声明，访问配套文件仍受各宿主的 Shell 授权限制。

ClawHub 安装与技能的修改、移除按技能包目录或文档提交变更，并登记文件撤销/重做记录；内容摘要用于拒绝覆盖后续修改。依赖安装和脚本执行沿用现有权限流程。
