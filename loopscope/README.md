# LoopScope 0.1

LoopScope 是 Gugu monorepo 中暂存的独立 AgentLoop 开发工具。它拥有自己的 frontend、backend、SQLite 和依赖边界，未来可以直接搬到独立仓库。

## 启动

### Backend

```bash
cd loopscope/backend
python -m venv .venv
source .venv/bin/activate
pip install -e .
loopscope
```

默认监听 `127.0.0.1:4320`，数据库默认在 `../data/loopscope.db`。

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

这仍是两个独立进程：frontend `4319`、backend `4320`，SQLite 放在独立 volume。

若 Gugu backend 也在 Docker 网络里运行，把 `LOOPSCOPE_ENDPOINT` 指到该网络中的 LoopScope backend（例如 `http://loopscope:4320`）；宿主机开发继续用 `http://127.0.0.1:4320`。

## 独立边界

LoopScope 内没有任何 `../../frontend`、`../../backend` source import。设计令牌是从 Gugu 当前 token 值复制出的本地快照，后续由 LoopScope 自己维护。
