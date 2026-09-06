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
- 沙盒容器的当前工作目录统一是 `/workspace`。它在 local 存储且本轮明确绑定
  workspace 时才对应绑定目录；否则对应用户独立的 Shell 持久目录。
- `/personal` 和 `/project` 不是固定存在的挂载点，只在本轮动态权限状态明确声明可用时
  才能访问。没有该声明时不得尝试访问、猜测路径或要求用户继续授权。
- OSS 存储模式只提供独立 Shell 沙盒：workspace 绑定、`/personal`、`/project`、OSS
  对象挂载、materialize/cache、自动同步和自动上传均不可用。文件库操作必须走明确的文件 API。
- `cd` 不带参数会回到沙盒 home `/`；需要回到当前 workspace 时使用 `cd /workspace`。
- 一次只执行一条命令，不使用管道、重定向、命令替换或下载后执行。
- 运行用户明确指定的脚本使用 `run_script`，只传沙盒内相对 `script_path`；不要把脚本内容拼进 `shell`，也不要使用解释器的 inline/eval 参数。
- `run_script` 只支持 `python3`、`node`、`bash`；脚本根和是否可用以本轮动态权限状态及
  工具 Schema 为准，脚本路径不能经过软链接或硬链接。网络由后台沙盒配置自动决定，
  不要向工具传递 `network` 参数。
- `run_script` 不接受 positional `args` 数组；脚本应读取执行器注入的环境变量：
  `GUGU_SCRIPT_ROOT`、`GUGU_SCRIPT_PATH`、`GUGU_WORKSPACE`，以及权限允许时的
  `GUGU_PERSONAL`、`GUGU_PROJECT`。这些变量只描述本轮可见挂载点，不包含密钥。
- Autopilot 开启且执行器判定当前沙盒权限满足时，`run_script` 可跳过交互确认；这不扩大
  沙盒范围，也不绕过脚本路径、解释器、配额、审计和执行器校验。未满足条件时仍需确认。

## 高风险操作与失败处理

- 删除、移动、提权、服务控制、覆盖性 Git 操作和数据库写入必须等待确认。
- 工具失败时如实说明；输出过长时说明已截断，不复述敏感信息。
