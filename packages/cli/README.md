# @gugu/cli

咕咕 Desktop 的本机命令行客户端。业务操作由正在运行的 Desktop 提供。

安装版启动后自动建立本机连接。macOS 首次启动尝试注册 `~/.local/bin/gugu`，若终端的 PATH 未包含该目录，可直接运行 `~/.local/bin/gugu --help`。Windows 安装器将安装目录下的 CLI 目录加入当前用户 PATH，打开新终端即可调用。CLI 使用安装包自带的 Node。

源码开发可以手动以环境变量 `GUGU_DESKTOP_CLI_PORT` 和 `GUGU_DESKTOP_CLI_TOKEN` 启动 Desktop，再向 CLI 注入相同变量。令牌至少使用 32 个随机 URL 安全字符。服务只监听 `127.0.0.1`，启用期间持有令牌的程序可以读写本机数据。

```sh
pnpm --filter @gugu/cli build
node packages/cli/dist/bin.js project list --json
node packages/cli/dist/bin.js canvas items 12
```

通过 `gugu --help` 查看总览，`gugu project --help` 查看对象命令，`gugu project update --help` 查看参数和示例。帮助可离线查看。

| 对象 | 命令 |
|---|---|
| `project` | list、get、create、update、delete、restore |
| `calendar` | list、create、update、delete |
| `note` | list、create、update、delete |
| `canvas` | list、create、update、delete、items、relations |
| `schedule` | list、get、create、update、delete |

新建和更新用 `--fields JSON` 提交桌面端业务字段。项目更新需要当前 `version`。笔记新建使用 `contentMd`，画布新建使用 `title`，日程新建使用 `title` 和 `date`。删除需要 `--yes`，日程删除还需用 `--fields '{"version":1}'` 传入当前版本。项目列表支持 `--archived` 或 `--deleted`，用响应中的 `nextOffset` 作为下一次的 `--offset`。

结果始终是 JSON，包含 `version`、`ok`、`data` 和 `error`。退出码 0 表示成功，1 表示请求失败，2 表示参数或配置无效，3 表示写入结果未确认。结果未确认时先查询当前状态。

- `src/help.ts` 维护命令目录、参数说明和示例。
- `src/bin.ts` 负责命令、参数和退出码。
- `src/client/desktop.ts` 负责本机传输。
- `apps/desktop/src/main/desktop-cli.ts` 负责本机服务、令牌验证和路由。
- [gugu-cli Skill](./skills/gugu-cli/SKILL.md) 提供给其他 Agent 的使用说明。
