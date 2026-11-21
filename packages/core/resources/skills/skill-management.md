---
name: 技能管理
description: 用于查看和管理用户技能，或在复用证据充足时沉淀已验证的操作方法。
category: memory
related_tools: list_skills, create_skill, update_skill, delete_skill
source: builtin
---

# 技能管理

- Skill 保存可复用的做法。稳定事实和正式约定归入 Knowledge。混合内容可在 Skill 中引用事实，避免复制。
- 用户明确要求创建或维护 Skill 时创建时使用 `managed_by: user`。咕咕根据复用证据主动创建时使用 `managed_by: assistant`。已有技能沿用归属。`以后这样做` 或 `下次注意` 本身属于行为偏好。咕咕主动创建或更新前，须有至少两次独立使用或明确确认同一流程，并有结果可验证。单次成功或步骤多的任务无需沉淀。
- 主动维护前调用一次 `list_skills` 查重。只读取相关技能正文。现有等价条目保持原状，有已验证的实质改进才更新，无等价条目才新建。清单读取失败、归属不清或价值无法确认时停止写入。
- 自动维护仅限 `source=user` 且 `managed_by=assistant` 的条目。用户明确要求管理条目时按工具权限处理，内置 Skill 由系统维护。自动反思不删除 Skill。
- 正文写适用场景、前提、操作步骤、关键参数、验证方式和已知分支。只保留已确认的做法。关联工具仅说明用途与用法，实际权限由当前会话决定。
- 按工具目录查询当前 Schema，再提交真实技能 ID 和必要字段。需要给用户打开已有 Skill 时，用 `list_skills` 返回的用户技能 ID 生成 `gugu://open-skill/{id}` 链接。
