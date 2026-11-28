# LoopScope 0.3

LoopScope 是 Gugu monorepo 中暂存的独立 AgentLoop 开发工具。它拥有自己的 frontend、backend、SQLite 和依赖边界，未来可以直接搬到独立仓库。

0.3 的核心是 **Context & Usage Provenance**：不仅能看到 Agent 做了什么，还能从 Span 追到源码位置、上下文来源、具体 Prompt/Memory/DB 数据，以及每轮真实 token / cache usage。当前版本还支持首个输入变化点对比、Schema 错误诊断和 Run 导出。

## 主要能力

| 能力 | 说明 |
| --- | --- |
| Conversation | 通过 Gugu 当前 Web AgentLoop 发送真实消息，支持普通/详细显示模式和实时工具事件 |
| Monitor | 在同一 Session 内查看 Run 列表、Run 状态和完整 AgentLoop，不需要跳转独立页面 |
| Run / Span | 按 Run 查看 LLM Round、Tool、Guard、Context、Memory、Database、Output 等 Span 及父子关系 |
| Context Provenance | 查看 Prompt、Memory、RAG、DB loader、能力目录和最终 Provider 输入的来源、内容与 token 影响 |
| Input / Assembly | 查看实际 Provider 输入、system 位置、消息数量、canonical layout 和上下文组装信息 |
| Prefix Diff | 对比相邻 Round 或上一 Run，定位 Provider 输入最早发生变化的消息和变化原因 |
| Token / Cache | 查看 input、output、cache read/write、fresh input、total、缓存率及 Provider usage 来源 |
| Tool / Schema | 查看工具参数形状、结果、Schema digest、Schema 错误、模型看到的 Schema 和恢复信息 |
| Skill | 查看 Skill 索引、正文是否首次加载或复用、正文长度及关联工具注入 |
| Code Provenance | 定位源码文件、module、function、qualname 和行号 |
| Export | 多选或单独导出完整 Run，包含按 Round 整理的 `loopscope-run-export` v2 JSON |
| 本地工具页 | `/tokens` 查看设计 Token，`/changelog` 查看变更，`/settings` 保存当前标签页的开发连接配置 |

Trace 正文属于受控开发诊断数据，LoopScope 允许在 Context、Input、Output 和 Tool 面板查看真实内容；凭据、登录 Token、Provider API Key 和数据库密码不得写入 Trace。

## 启动

### Backend（TypeScript Collector）

```bash
cd loopscope
pnpm install
pnpm --filter @loopscope/collector dev
```

默认监听 `127.0.0.1:4320`，数据库默认在 `data/loopscope.db`。启动时会幂等补齐 0.3 schema。

### Frontend

```bash
cd loopscope/frontend
pnpm install --frozen-lockfile
pnpm dev
```

默认监听 `127.0.0.1:4319`。 `/gugu-api` 默认代理到 Node Web Host 的 `127.0.0.1:9595`；需要其他后端地址时通过 `GUGU_API_TARGET` 指定。

打开前端后，左侧可以选择 Session；进入 Session 后可在 `Conversation` 和 `Monitor` 间切换。Monitor 会按需加载 Run 和 Span，Run 列表和 Span 列表都支持分页；选中多个 Run 后可以导出 JSON。

### Gugu trace

启动 Node Web Host 或桌面应用前，在其启动环境中设置：

```bash
export LOOPSCOPE_ENABLED=true
export LOOPSCOPE_ENDPOINT=http://127.0.0.1:4320
```

Web Host 和桌面应用的地址指向同一 Collector 时，可以在同一个 Monitor 中查看两端的 Run。桌面应用重启后读取环境变量，上报来源为 `desktop`。桌面没有 Web Host 的请求排队阶段。

Web 入口位于 Gugu 的 `/dev` 页面。该页面通过 `postMessage` 提供 API 地址，Gugu API 使用同站 HttpOnly Cookie。桌面 trace 从 Collector 的 Session 列表进入。本机只运行桌面和 Collector 时，在前端目录用 `VITE_LOOPSCOPE_LOCAL_DESKTOP=true pnpm dev --strictPort` 启动，然后打开 `http://127.0.0.1:4319/`。此模式通过本机 Vite 只读转发到 `127.0.0.1:4320`。仅在受控开发环境开启采集，跨机器访问时由部署层限制来源并提供独立认证。

### Docker

```bash
cd loopscope
docker compose up --build
```

frontend `4319`、TypeScript Collector `4320` 仍是独立进程，SQLite 放在独立 volume。

若 Node Web Host 也在 Docker 网络里运行，把 `LOOPSCOPE_ENDPOINT` 指到该网络中的 LoopScope backend；宿主机开发继续用 `http://127.0.0.1:4320`。

## 独立边界

LoopScope 不 source-import Gugu 应用源码。Gugu 侧只保留开发期开关控制的 trace bridge；设计令牌是本地快照，后续由 LoopScope 自己维护。

## Trace 数据流

```text
Gugu Agent / IM / Web
        |
        | POST /api/collector/runs
        v
TypeScript Collector
        |
        v
SQLite（sessions / runs / spans / usage / context fragments / artifacts）
        |
        | Gugu /api/v1/dev/loopscope/*（用户会话鉴权后代理只读查询）
        v
LoopScope Web
```

Collector 保存 Run、Span、usage、Context Fragment 和 Prompt Artifact。LoopScope Web 通过 Gugu 的用户鉴权入口读取分页数据；未登录时接口返回 401，前端清除诊断视图并提示从咕咕登录。Collector 只读端口应保持本机绑定，不直接暴露给浏览器或外部网络。重新加载页面后，历史 Run 仍从 SQLite 恢复。Collector 不可用时，Gugu trace bridge 应静默失败，不阻塞 Agent 主链路。

## 诊断入口

在 Gugu 中先登录，进入 `/dev`，再点击 LoopScope。这样会通过 `postMessage` 完成当前账号的 API bootstrap；直接打开 Collector 或 LoopScope 前端地址不会自动获得 Gugu 账号上下文。

常用面板：

- **Assembly**：确认 system、snapshot、history、batch 和 dynamic tail 的实际组装。
- **Input**：查看 Provider 实际输入，并定位 Prefix Diff 的最早变化点。
- **Schema**：查看模型实际看到的工具 Schema、校验错误和 Schema digest。
- **Diagnostics**：查看 canonical event、Adapter call 和上下文统计。
- **Content / Output / Source**：分别查看注入正文、模型输出和代码来源。

## Changelog

见 [`CHANGELOG.md`](./CHANGELOG.md)；应用内也可打开 `/changelog`。
