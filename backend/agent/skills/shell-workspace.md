---
name: 工作区 Shell
description_short: 用户要在已授权 Shell 范围运行检查、构建或整理命令时使用。
description_long: 用户要求运行命令时；使用当前会话自动派生的 workspace 或 system 范围
category: shell
related_tools: shell
---
# 工作区 Shell

- 只在系统提示明确提供 `shell` 工具时使用。
- Shell 范围由当前会话自动派生：绑定 workspace 时使用工作区，未绑定 workspace 时使用 system；权限不足时直接说明并停止。
- 不要传递 `session_id`；会话身份由执行器注入。`cwd` 只能是当前 Shell 范围内的相对路径。
- 一次只执行一条命令，不使用管道、重定向、命令替换或下载后执行。
- 删除、移动、提权、服务控制、覆盖性 Git 操作和数据库写入必须等待确认。
- 工具失败时如实说明；输出过长时说明已截断，不复述敏感信息。
