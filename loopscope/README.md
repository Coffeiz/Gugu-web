# LoopScope 0.2

LoopScope 是 Gugu monorepo 中暂存的独立 AgentLoop 开发工具。它拥有自己的 frontend、backend、SQLite 和依赖边界，未来可以直接搬到独立仓库。

0.2 的核心是 **Context & Usage Provenance**：不仅能看到 Agent 做了什么，还能从 Span 追到 Python 源码位置、上下文来源、具体 Prompt/Memory/DB 数据，以及每轮真实 token / cache usage。

## 主要能力

- 多 Session 连续真实对话，普通 / 详细模式。
- Monitor 是 Session 内布局模式，不再跳独立页面。
- Run → Span 完整 AgentLoop；每个 Span 的 Content / Input / Output / Source / Attributes 可分别展开。
- Code Provenance：Python 文件、module、function、line。
- Context Provenance：DB loader、Memory、Prompt Markdown、最终渲染上下文、cache stable/dynamic 边界。
- Token Usage：Run + 每个 LLM Span 的 input / output / cache read / fresh input；Context / Tool 显示估算 token impact。
- 独立 `/tokens` 与 `/changelog` 页面。

## 启动

### Backend

```bash
cd loopscope/backend
python -m venv .venv
source .venv/bin/activate
pip install -e .
loopscope
```

默认监听 `127.0.0.1:4320`，数据库默认在 `../data/loopscope.db`。0.1 数据库会自动原地升级到 0.2 schema。

### Frontend

```bash
cd loopscope/frontend
npm install
npm run dev
```

默认监听 `127.0.0.1:4319`。

### Gugu trace

启动 Gugu backend 前：

```bash
export LOOPSCOPE_ENABLED=true
export LOOPSCOPE_ENDPOINT=http://127.0.0.1:4320
```

然后从 Gugu `/dev` 点击 LoopScope。`/dev` 使用 `postMessage` 把当前开发登录的 token 和 API 地址传给新窗口；不会把 token 写入 URL 或 LoopScope SQLite。

### Docker

```bash
cd loopscope
docker compose up --build
```

frontend `4319`、backend `4320` 仍是独立进程，SQLite 放在独立 volume。

若 Gugu backend 也在 Docker 网络里运行，把 `LOOPSCOPE_ENDPOINT` 指到该网络中的 LoopScope backend；宿主机开发继续用 `http://127.0.0.1:4320`。

## 独立边界

LoopScope 不 source-import Gugu `frontend/` / `backend/`。Gugu 侧只保留开发期开关控制的 trace bridge；设计令牌是本地快照，后续由 LoopScope 自己维护。

## Changelog

见 [`CHANGELOG.md`](./CHANGELOG.md)；应用内也可打开 `/changelog`。
