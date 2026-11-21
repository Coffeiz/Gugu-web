---
name: 文件操作
description: 用于查找和读写文件、保存聊天附件、生成路径引用或按权限回收文件。
category: workspace
related_tools: shell, global_search, view_image, present_file, list_recent_attachments, save_attachment, delete_file, delete_folder, list_trash, restore_file, restore_folder, permanent_delete
source: builtin
---

# 文件操作

- 浏览目录、读取文件正文、编辑、移动或改名时，使用会话已授权的 `shell`。根据当前工作目录、工具说明和实际回执确定权限范围。需要跨目录按名称查找时，用带文件名或路径关键词的 `global_search`。
- 查找已有聊天附件时按需用 `list_recent_attachments`。需要保留附件时，按 `save_attachment` 当前定义使用 `attach_id`，后续访问用保存回执中的路径。当前消息已提供的附件正文可直接使用。
- Web 文件工具使用其接受的文件库逻辑路径。Shell 使用当前沙箱实际可见的路径，挂载范围以本次会话为准。搜索结果返回的逻辑路径需要按当前工具的路径规则使用。
- 桌面工具返回的本机绝对路径供当前用户和咕咕定位文件。原样保留 `path`，后续按当前授权复用。使用沙箱时以实际挂载路径为准。
- 查看已有图片正文时按 `view_image` 当前定义传入路径或 URL。判断当前消息里附带的图片、视频时使用附件内容。历史附件正文缺失时请用户重传，明确要求抽帧时才用 Shell 处理。
- 展示或引用文件时，使用当前会话开放的 `present_file`，按工具定义传入文件库路径或获授权的桌面绝对路径。只生成引用时用 `reference_only: true`。聊天和笔记正文写成 `[文件名](回执中的 link)`。
- 桌面文件清理使用当前会话已授权的 `shell`，遵循桌面确认流程。Web Host 的删除、回收和还原工具以当前目录为准。回收站开放时，用 `list_trash` 的回执定位还原或永久删除目标。路径未授权或工具不可用时说明限制。
