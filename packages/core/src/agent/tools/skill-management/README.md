# Agent 技能管理工具

Agent 的用户技能由 `<用户数据目录>/<用户 UUID>/.agent/skills/user/<slug>/SKILL.md` 和同目录下的附属文件组成；ClawHub 安装技能使用同级 `clawhub/<slug>/`。宿主提供可信用户身份、目录和事务能力，工具参数不能指定用户或宿主路径。技能正文保留 YAML frontmatter；`name`、`description` 必填，其他字段和配套文件在编辑时保留。

## 公开工具

- `list_skills`：读取当前用户可见的技能目录，包括名称、描述、启用状态和可供当前运行访问的目录位置。
- `create_skill`：接收名称、简短描述、正文、关联工具及管理者，可选分类和长描述；创建独立目录并登记文件历史。
- `update_skill`：使用目录 `id` 更新指定字段；未指定的正文、元数据和附属文件保持不变。
- `delete_skill`：使用目录 `id` 删除整个技能包。工具声明危险操作，确认绑定当前用户与完整目录摘要；提交后可以撤销和重做。

`use_skill` 由技能运行时提供，按需加载已启用技能正文。目录中的工具名称只用于描述，不授予工具权限。

## 目录职责

- `file-tools.ts`、`file-document.ts`：创建、更新的输入契约和文档字段处理。
- `file-port.ts`、`file-storage.ts`：创建、更新的授权复核、持久收据、文件日志及失败恢复。
- `file-delete.ts`、`file-delete-target.ts`：删除工具、确认目标和完整目录版本摘要。
- `file-delete-port.ts`、`file-delete-storage.ts`：一次性确认认领、操作收据、目录移动及恢复日志。
- `index.ts`：技能元数据读取工具；旧数据库工具仍待移除。

Web 使用数据库事务和技能目录锁登记撤销；桌面使用同一文件事务并同步到文件历史。提交结果未知时先按操作标识查收据并恢复，不能直接重复执行。具体宿主接入及迁移说明见 [技能目录 README](../../skills/README.md)。
