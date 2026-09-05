---
name: 工作区 Shell
description_short: 用户要在已授权 Shell 范围运行检查、构建或整理命令时使用。
description_long: 用户要求运行命令且系统提供 Shell 工具时使用
category: shell
related_tools: shell, run_script
---
# 工作区 Shell

## 使用边界

- 只在系统提示明确提供 `shell` 工具时使用。
- Shell 的可用范围、权限与确认要求由执行器决定；不要自行切换范围、猜测路径或扩大权限。工具不可用时直接说明并停止。

## 调用规则

- 不要传递 `session_id`；会话身份由执行器注入。`cwd` 只能是当前 Shell 范围内的相对路径。
- 沙盒容器的当前 workspace 挂载为 `/workspace`，当前用户完整项目文件库（含年月和项目目录）
  以只读方式挂载到 `/project`，当前用户的个人文件库以只读方式挂载到 `/personal`。
  沙盒用户的 home 是根目录 `/`；workspace 只改变 `/workspace` 的默认目录；
  不要尝试访问其他绝对路径。
- `/project/YYYY/MM/项目名` 是交互式终端中的人类可读路径，`cd` 会自动解析到内部的
  `项目名 #ID` 目录；唯一项目不需要输入 `#ID`，项目名含空格时也不需要额外转义。
  如果同一月份存在同名项目，Shell 会列出带 ID 的可复制路径，避免猜错项目。
- `cd` 不带参数会回到沙盒 home `/`；需要回到当前 workspace 时使用 `cd /workspace`。
- 一次只执行一条命令，不使用管道、重定向、命令替换或下载后执行。
- 运行用户明确指定的脚本使用 `run_script`，只传沙盒内相对 `script_path`；不要把脚本内容拼进 `shell`，也不要使用解释器的 inline/eval 参数。
- `run_script` 只支持 `python3`、`node`、`bash`；`personal`/`project` 脚本需要完整用户沙箱授权，脚本路径不能经过软链接或硬链接。

## 高风险操作与失败处理

- 删除、移动、提权、服务控制、覆盖性 Git 操作和数据库写入必须等待确认。
- 工具失败时如实说明；输出过长时说明已截断，不复述敏感信息。
