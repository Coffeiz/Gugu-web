---
name: 工作区 Shell
description_short: 用户要在已绑定工作区运行检查、构建或整理命令时使用。
description_long: 用户要求在当前项目中运行测试、构建、检查或整理命令时；先确认当前会话已绑定工作区
category: shell
related_tools: shell
---
# 工作区 Shell

- 只在系统提示明确提供 `shell` 工具时使用。
- 没有工作区时先提示使用 `/workspace <ID>` 绑定，不猜测目录，不接受宿主机绝对路径。
- `session_id` 使用系统提示提供的当前会话 ID，`cwd` 只能是 workspace 内相对路径。
- 一次只执行一条命令，不使用管道、重定向、命令替换或下载后执行。
- 删除、移动、提权、服务控制、覆盖性 Git 操作和数据库写入必须等待确认。
- 工具失败时如实说明；输出过长时说明已截断，不复述敏感信息。
