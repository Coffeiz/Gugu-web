# PRD-CLI-1：多端命令行与外部 Agent 接入

- 状态：规划中
- 日期：2026-11-19
- 适用版本：Gugu 2.0，按桌面端及共享 Core 的成熟度分阶段实施

## 一、背景与目标

用户希望从终端管理咕咕数据，并让具备 Shell 能力的 Codex、Claude Code 等外部 Agent 能安全、稳定地读取和操作项目、日历、笔记等资源。CLI 是独立的产品入口，复用共享 Core 或现有服务端 API，不复制业务规则。

目标：

1. 提供人类可读的命令和稳定的机器可读 JSON 输出。
2. 明确本地与远程操作目标，复用现有身份、授权、事务、Undo 与确认规则。
3. 随桌面应用打包，支持用户按需安装命令入口；后续允许远程控制场景独立发行。
4. 提供精简 `SKILL.md`，帮助支持技能机制的外部 Agent 按需发现和调用命令。

本 PRD 是目标设计，不代表 CLI、本地 Host 通信、独立发行或 MCP Server 已实现。命令以实际能力就绪为前提，不能以空实现冒充可用。

## 二、使用场景与各端交付

| 场景 | 操作路径 | 交付方式 |
| --- | --- | --- |
| 桌面用户或本机 Agent | 本地 CLI 调用桌面 Host 或授权的本地 Core | CLI 随 macOS、Windows、Linux 桌面应用打包 |
| 自部署用户 | CLI 经 Node Host API 操作对应用户数据 | Linux 自部署发行包提供 CLI；具体安装方式由发行方案确定 |
| 其他机器上的 Agent | CLI 经认证 API 连接指定服务 | 后续独立发行轻量远程 CLI |
| 移动用户 | 使用移动 UI 和未来的设备通信能力 | 不内置 CLI |

桌面安装包携带 CLI，但默认不自动加入系统 PATH。设置页面显示安装状态、版本及连接目标，由用户主动安装或移除系统命令入口。安装或移除须说明将修改的系统位置或用户配置，卸载入口不删除用户数据。升级时随应用更新 CLI；处理旧入口、路径变更及版本不匹配。各平台 PATH 修改和权限细节在实现设计中确定。

## 三、架构与连接目标

```text
apps/cli/                   命令、参数、终端输出和 Host 接入
  src/commands/             按资源组织的命令
  src/host/                 本地 Host / 远程 API 客户端
  skills/gugu/SKILL.md      外部 Agent 使用说明
apps/desktop/               桌面 Host
apps/web-host/              自部署 Web Host
packages/core/              共享业务规则、用例和数据契约
```

CLI 放在 `apps/cli`，可独立发布与目录位置无关。先不新增 CLI 专属共享包；未来 MCP 或其他客户端确有重复需求时，再提取通用 API 客户端。Core 保持业务事实源，Host 负责身份、平台能力、数据访问和生命周期。

CLI 支持命名连接目标（context）：本地桌面或远端服务。命令必须能明确显示实际目标；`--context` 仅覆盖单次调用，不能隐式切换默认目标。首次使用先显式选择或配置目标；没有可用目标时给出可操作错误，不猜测写入位置。远端通过用户授权 API，不直接连接服务端数据库。

本地模式有两个待评估方案：连接运行中的桌面 Host，或以受控方式直接调用 Core/SQLite。桌面 App 与 CLI 并发访问时必须验证锁、事务、索引更新和 UI 刷新；确定安全的资源所有者和关闭流程后再选择，不预设允许多进程直接打开生产库。文件按可信授权根和逻辑路径访问，本地 FS 为事实源，不引入 watcher 与数据库文件对账。

## 四、命令方案

采用 `gugu <资源> <操作>`。下表是目标能力，不意味着首版全部交付；命令可用性由当前端能力和授权决定。

| 命令 | 作用 | 阶段 |
| --- | --- | --- |
| `gugu version`、`status`、`help [command]` | 版本、当前目标与能力状态、帮助 | 首版 |
| `gugu context list`、`use <name>` | 查看和切换连接目标 | 首版 |
| `gugu project list`、`get <id>`、`create`、`update <id>`、`archive <id>`、`delete <id>` | 项目管理 | 首版 |
| `gugu calendar list`、`get <id>`、`create`、`update <id>`、`delete <id>` | 日程管理 | 首版 |
| `gugu note list`、`search <query>`、`get <id>`、`create`、`update <id>`、`delete <id>` | 笔记管理 | 首版 |
| `gugu search <query>` | 跨业务资源搜索 | 首版 |
| `gugu canvas list`、`get <id>`、`create`；`gugu canvas node add/update/remove` | 画布与节点 | 后续 |
| `gugu workspace list`、`get <id>` | 工作区和绑定关系 | 后续 |
| `gugu schedule list`、`get <id>`、`create`、`update <id>`、`enable <id>`、`disable <id>`、`delete <id>` | 定时任务 | 后续 |
| `gugu contact list`、`get <id>`、`create`、`update <id>`、`delete <id>` | 联系人 | 后续 |
| `gugu file list/read/write/move/delete` | 在授权根内按路径管理文件 | 后续，依赖 FS 端口 |
| `gugu skill list`、`get <id>` | 查看技能及说明 | 后续 |
| `gugu agent run`、`gugu agent run get <run-id>`、`gugu agent run cancel <run-id>` | 提交任务、查看及请求取消 | 后续，依赖 Run 生命周期稳定 |

命令名和具体参数在实现时基于真实 Core/Host 接口定稿；首版中尚未接线的操作明确不可用，不能静默返回伪成功。

## 五、调用协议与安全

| 参数 | 契约 |
| --- | --- |
| `--json` | stdout 仅输出机器可读 JSON；进度、诊断写 stderr，不能混入正文 |
| `--context <name>` | 指定本次操作目标，不修改默认目标 |
| `--limit <n>`、`--cursor <cursor>` | 支持分页的列表操作使用 |
| `--input <file>` | 复杂输入从 JSON 文件读取；`-` 表示标准输入 |
| `--dry-run` | 仅在底层真实支持预览的操作提供，不执行写入 |
| `--help` | 输出命令用途、参数和示例 |

```bash
gugu project list --context desktop --json
gugu note create --input - --json <<'JSON'
{"title":"会议记录","content":"讨论桌面端方案"}
JSON
gugu calendar list --from 2026-11-23 --to 2026-11-29 --json
```

JSON 输出应有可版本化的成功结果、稳定错误码及可供程序判断的失败信息，退出码能区分成功与失败；最终 envelope、错误分类及分页协议在实施前固定并测试。不得输出凭据或未授权数据，不能要求 Agent 从中文表格解析结果。

所有调用复用 Core/Host 的 owner、权限、事务及用户可见行为。删除、覆盖等危险操作复用现有确认门；无交互终端返回结构化“需要确认”，不得自动确认或绕过授权。确认的具体参数与现有交互契约对齐后定义。认证凭据使用系统安全存储或受控交互，不放命令行参数、URL、输出或日志。

## 六、Agent Skill 与后续 MCP

提供精简 `SKILL.md`：说明适用场景、目标选择、常用命令、`--json`、确认和安全边界；参数详情以 CLI `--help` 为准。不同 Agent 的安装目录和发现方式可能不同，提供相应安装说明，不让 CLI 依赖单一 Agent 产品。支持技能的 Agent 按需读取；其他 Agent 可直接使用 `--help`，Skill 不是使用 CLI 的必要条件。

未来可以提供 MCP Server，供需要结构化工具发现或不能执行 Shell 的 Agent 使用。它应调用相同 Core 用例或远程 API，复用权限、确认和行为契约；MCP 不属于首版必交项。

## 七、阶段与验收

1. **首版 CLI**：连接目标、帮助/版本/状态、项目、日历、笔记和全局搜索；先完成已有 Web API 可复用的远程路径，再根据桌面 Core/Host 进度接入本地。仅交付已有真实实现的命令。
2. **桌面集成**：随包交付、设置中安装/移除入口、版本状态、本地连接和并发访问验收。
3. **扩展能力**：按对应 Core/Host 能力逐步开放画布、工作区、定时任务、联系人、文件与技能；Agent Run 在生命周期和取消机制稳定后接入。
4. **独立发行与 MCP**：根据需求提供远程 CLI 独立安装、可复用客户端和 MCP 入口。

验收覆盖：命令和帮助一致；JSON、退出码、分页与错误可被外部程序解析；目标未配置或不可用时拒绝误写；远程认证与跨用户隔离；写入后的读取及失败处理；危险操作确认和取消；敏感信息不出现在输出；与旧 Python 用户可见行为及现有回归对照。桌面安装、升级、卸载在各支持平台实测；本地模式另测 App/CLI 并发、进程重启、持久化及界面刷新。回归默认在 devserver 或适合的平台隔离环境执行，不以 Docker 为本 PRD 的测试目标。
