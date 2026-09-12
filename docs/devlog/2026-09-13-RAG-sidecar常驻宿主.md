# RAG sidecar 常驻宿主：worker 从「每进程自启」改为「socket 共享」

## 背景与根因回顾

2026-09-12 排查「对话 RAG 几乎每轮超时」：单 owner 索引长到 ~56MB（1.9 万持久文档），
超过 Python 缓存 32MB 准入线 → wrapper 永不留条目；叠加 uvicorn `--workers 2` 下
sidecar/缓存都是进程本地，请求落到冷进程就要全量 DB 装载 4.5–9.4s，打穿搜索超时。
（评审修正：32MB 只是放大器，决定性因素是「请求所在进程的 sidecar 有没有当前 revision」。）

临时止血：`PER_OWNER_CACHE_BYTES` 32→128MB（e290c5d01），超时消失。根治方案（本篇）：
把 TS worker 抽成独立常驻服务，多个 Python 进程共享一份热索引，后端重启不再冷装载。

## 实现（三提交）

1. **2520e5f22 传输层模板化 + SocketSidecarClient**
   - `_request` 改为模板方法：锁/probe 外壳共享，`_prepare_for_send` / `_transact` /
     `_absorb_state` 三个覆写点。基类 stdio 行为不变，既有测试打桩（monkeypatch
     `_request`/`_ensure_process`/`_request_unlocked`）全部继续有效。
   - `SocketSidecarClient`：unix socket 传输（行分界 JSON 信封
     `{v,req_id,owner,timeout_ms,payload}` → `{req_id,payload,state}`）；
     **状态归属权移交宿主**——revision/瞬态指纹/进程代数以宿主下发的 state 镜像为准；
     `reuse_if_current` 与 `replace_transient` 的短路判定在宿主侧执行（判定依据是
     宿主内真实 worker 进程状态，跨进程读不到）。payload 构造与基类共用一份，防漂移。
   - 工厂按 `search.ts_sidecar_socket`（空=关闭）分流；socket 不可达自动回退进程内
     spawn 并记警告。rank 通道固定 owner `__rank__` 共享一个无状态 worker。
2. **1d27ba8ec 宿主 + 部署接线**
   - `agent/rag/sidecar_host.py`：宿主持有真实 `TsSidecarClient`（spawn/ping/磁盘
     恢复/空闲回收全部复用），按 owner 路由；worker 侧错误转信封级
     `TsSidecarUnavailable(code)`，上游自愈逻辑（revision_mismatch 重试、
     worker_unavailable 懒同步）原样生效；SIGTERM 优雅关闭。
   - `gugu-rag-sidecar.service` 单元（照 backend 模板风格）；backend/worker/gateway
     模板加 `Wants/After` 软依赖 + 注入 `SEARCH__TS_SIDECAR_SOCKET`；start.sh
     SYSTEMD_SERVICES、Makefile uninstall、docker-entrypoint（embedded supervisord
     `[program:rag-sidecar]` + 单容器 monitored_pids，`GUGU_ENABLE_RAG_SIDECAR=0` 可关）。
3. **devserver 启用**：unit 安装 + `config.override.json` 加
   `search.ts_sidecar_socket=/run/user/1000/gugu-rag-sidecar.sock` 单键
   （备份 `config.override.json.bak-sidecar-20260913-003310`）。

## devserver 落地踩坑

- **ReadWritePaths 路径不存在 → 226/NAMESPACE**：devserver 存储真根在仓库内
  `Gugu-web/Gugu-data/users`（start.sh 取 `../Gugu-data`），不是 `~/文档/Workspace/Gugu-data/users`。
  systemd 226 报错只会给一行 namespace 失败，路径核对要去机器上看。
- **启动限流**：连续失败 5 次后 `systemctl restart` 会被 "Start request repeated too
  quickly" 拒绝，必须先 `systemctl reset-failed`。
- **共享脏文件提交**：ts_sidecar.py/start.sh/Makefile/deploy.md 都有并行会话未提交
  改动，全部用「HEAD 基线 + 本任务精确替换 → hash-object 暂存」方式隔离提交；
  中途 `git update-index --chmod=+x <path>` 把工作区整文件重新带进暂存（该命令对已
  跟踪文件等于重新 add），改为 `--cacheinfo 100755,<blob>,<path>` 一次带模式写入。

## 验证

- 本地：`test_rag_sidecar_socket.py` 13 例（信封收发/镜像回填/宿主判定/错误映射/
  工厂回退/真 socket 全链路宿主路由）；sidecar 全家族 82 例全绿。
  注：test_rag_batch_protocol/ts_projection/batch_retriever 当下红，是并行会话
  未提交的 TS worker/batch_retriever 半成品（strip-types 语法、`_load_memory` 移除），
  与本改动无关。
- devserver：宿主 `active`，socket `/run/user/1000/gugu-rag-sidecar.sock` 0600；
  冒烟 `SocketSidecarClient → reuse_if_current` 打通真 TS worker（False/空索引为预期）；
  重启 backend/worker/gateway 后无「sidecar socket 不可达」回退警告。
- 待真实流量确认：下一次对话查询应命中宿主热索引（`index_cache_get` 从 ~5s 降为
  毫秒级，后端重启后首查不再出现 `rag_probe_late_completion`）。

## 回滚

`config.override.json` 移除 `ts_sidecar_socket` 单键（或恢复备份）并重启 backend/
worker/gateway 即回到进程内 spawn；`systemctl disable --now gugu-rag-sidecar` 可选。
