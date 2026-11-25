# @gugu/cli

咕咕 monorepo 的命令行客户端，供终端和其他应用调用 Web 或 Desktop 的数据能力。

当前仅建立包和设计目录；命令、认证与两端服务接口尚未实现，下面的命令和协议均为规划，不能直接调用。

## 边界

- CLI 负责解析命令、连接目标、认证、输出和退出码；业务规则、用户身份和授权由目标 Host 执行。
- Web 接入经认证的服务接口；Desktop 需提供受保护的本机接口。复用各端应用服务与权限门，不直接访问数据库或绕过文件权限。
- CLI 凭据应可撤销并限制权限范围，不复用浏览器 Cookie，不写入命令参数、日志或版本控制。
- 操作结果未确认时明确报告未知状态；不得自动重试可能已执行的写操作。

## 首期命令规划

| 命令组 | 范围 | 示例（规划） |
|---|---|---|
| `project` | 项目查询、新建、更新及生命周期操作 | `gugu project list --json` |
| `calendar` | 日程查询、新建、更新和删除 | `gugu calendar list --json` |
| `note` | 笔记查询、新建、更新和删除 | `gugu note list --json` |
| `canvas` | 画布及节点、连线查询和编辑 | `gugu canvas list --json` |
| `schedule` | 定时任务查询、新建、更新、启停和删除 | `gugu schedule list --json` |

具体操作、参数、分页、确认方式和两端能力以实现时的版本化契约为准。

## 返回结果设计

机器调用使用版本化 JSON 信封，业务数据复用两端共享的领域结果；错误使用稳定错误码和退出码。Agent 工具的 `[工具结果]` 文本用于模型阅读，可能随提示词和展示调整，不作为机器接口契约。需要人类可读输出时，可在同一结构化结果上复用适用的格式化规则。

```json
{"version":1,"ok":true,"data":{},"error":null}
```

```json
{"version":1,"ok":false,"data":null,"error":{"code":"not_found","message":"未找到项目"}}
```

以上字段及错误码是设计草案，尚未实现或承诺稳定；输出不包含凭据和原始异常。CLI 仅在明确成功后返回成功退出码，参数、认证、权限、业务失败和结果未知应可区分。

## 目录与构建

当前只有包清单、README 和供其他 Agent 安装的 [gugu-cli Skill](./skills/gugu-cli/SKILL.md)。CLI 实现后可将该 Skill 目录分发到目标 Agent 的 Skill 发现路径；目前它明确标注命令尚不可用。以下是计划中的职责划分，尚未创建的目录不是可用接口：

```text
packages/cli/
├── README.md           包的职责、接口和使用说明
├── skills/gugu-cli/    供其他 Agent 安装的 Skill
│   └── SKILL.md        CLI 使用入口与约定
├── package.json        工作区包清单
└── src/                计划：命令行及 Node 客户端
    ├── bin.ts          计划：命令入口
    ├── index.ts        计划：Node 客户端入口
    ├── commands/       计划：五个业务域的命令和参数
    ├── client/         计划：Web 与 Desktop 传输适配
    ├── output/         计划：JSON、文本和退出码
    └── config/         计划：目标配置与凭据存取
```

共享请求及响应契约计划放在 `packages/api-contracts/`；Web 和 Desktop 各自在宿主中接入认证、授权及业务服务。实现后再补充 `bin`、构建、安装与实际命令说明。
