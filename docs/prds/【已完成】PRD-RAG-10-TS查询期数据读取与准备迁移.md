# PRD-RAG-10：TS 查询期数据读取与准备迁移

> 状态：Phase 1/2 本地实现与回归完成；devserver 冷/热查询及真实数据验收待完成
> 创建：2026-09-12
> 所属层：RAG / Query Runtime / Data Runtime
> 前置 PRD：[`PRD-RAG-7-TS全链路检索分阶段迁移`](./【已完成】PRD-RAG-7-TS全链路检索分阶段迁移.md)
> 索引写入关联：[`PRD-RAG-9-增量索引重建与来源级同步`](./PRD-RAG-9-增量索引重建与来源级同步.md)

## 1. 背景

新版 RAG 的超时探针显示，多来源同时停留在 `index_prepare`。需要把查询期的数据读取、缓存准备和 Memory 语料装载放在同一 TS runtime 内执行，减少 Python 与 worker 之间传输大批文档/向量的开销，并让各来源的准备耗时能被独立观测。

本 PRD 聚焦**查询期读取与准备**，不重复定义 PRD-RAG-9 的业务变更事件、索引投影写入和来源级增量重建。

## 2. 目标与边界

### 2.1 目标

1. TS Data Runtime/worker 读取查询所需的 canonical 索引文档、revision、持久向量和 Memory 数据；Data Runtime 也提供 project、file metadata、conversation、knowledge、canvas 等 owner 绑定 source reader，文件正文/Memory 内容经 `StorageReader` 受控读取。
2. TS 在 worker 内完成 Memory 过滤与准备、query embedding provider 请求、来源召回、hybrid 融合、去重、排序及结构化诊断。
3. Python 查询链不再加载或传输全量索引正文、Memory 文档、持久向量或 query vector；只传递经 Python 授权后的 owner/scope、查询参数和必要的上下文水位。
4. Python 保留身份建立、scope 授权、BYOK 凭据解密/有效配置选择、最终 owner/scope 复核和 Agent 上下文注入。
5. 读取或准备失败必须显式报告，不得将错误伪装为空索引或成功完成。

### 2.2 本 PRD 不覆盖

- PRD-RAG-9 管理的索引写入事件、canonical source projection、数据库投影事务和增量 chunk 同步；这些流程现阶段仍由 Python 写侧驱动。
- 写侧文档/Memory 向量生成及持久化仍使用共享 Python embedding 原语；Agent 直接上下文 Memory 超预算挑选及离线诊断回放仍可使用 Python embedding。本 PRD 只迁移统一 RAG 查询时的 query embedding provider 请求与向量生成。
- 将 TS worker 暴露为网络服务，或让 worker 自行推导用户身份和业务授权。

因此，本 PRD 完成后代表“RAG 查询期取数、准备、query embedding 与 unified retrieval 已迁到 TS”；Python 仍负责认证授权、BYOK 凭据解析及最终结果边界。本 PRD 不代表索引写侧或文档向量生成生命周期已迁 TS。

## 3. 目标架构

```text
Python API / Agent
  ├─ 认证用户身份
  ├─ 解析并授权 owner / scope / 来源范围
  ├─ 提供 query、消息水位、检索预算和已授权的 embedding 配置
  │    └─ API key 只走 owner-bound 专用 IPC，不记录、不持久化、不回显
  └─ 最终 owner/scope 复核、引用组装与上下文注入
            │ 本机 JSONL；不传全量正文/向量
            ▼
TS RAG Worker + Data Runtime
  ├─ 按 owner 读取 canonical 索引文档与 revision（同一 DB 快照）
  ├─ 按需直接读取已接入的 source records（owner 条件查询）
  ├─ 按 owner / model version 读取持久向量
  ├─ 读取 Memory 文件、scope 状态、tombstone 与快照内容
  ├─ 完成 Memory source filter / 去重 / transient corpus 装载
  ├─ 在 TS 发起 query embedding 请求并生成 query vector
  └─ 完成召回、融合、排序、预算裁剪和阶段诊断
```

### 3.1 权限与存储安全

- Worker 只接受 Python 认证链路传入的 owner；每个 DB 查询都绑定 owner 条件。
- Memory scope 必须由 Python 先授权，worker 再校验 owner 一致、scope 结构合法并检查 tombstone。
- 本地存储 key 必须位于当前 owner 目录；拒绝路径穿越及跨 owner 符号链接。
- OSS 只读访问按 owner 前缀约束。凭据通过 worker 私有环境传入，不进入 argv、JSONL 业务载荷或日志。
- Embedding 凭据只允许通过 owner-bound `unified_query_with_embedding` 本机 IPC 短暂传递；不进入普通查询 op、日志、argv、磁盘索引或响应。Worker 校验 owner 与进程绑定 owner 一致，查询结束后不保留配置。
- 公网 provider URL 复用 Python `resolve_pinned_ip()` 校验并将目标 IP 随请求传入，直连时由 TS 固定 socket 目的 IP；仅显式 `local`/`ollama` provider 可使用私网推理端点，并同样固定解析结果。HTTP(S) 重定向不自动跟随。
- TS worker 复用 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` 环境策略；Node 22.21+ 的内置 HTTP(S) proxy agent 执行代理路由。配置代理时代理必须是部署方授权且可信的出站代理。
- Provider 请求设置独立短超时、限制响应体大小；超时、HTTP 错误、非法响应只返回聚合探针状态并按词法检索降级，不记录端点、key、provider 错误正文。
- Worker 继续是同机子进程，不接受外部网络请求；TS 校验是纵深防护，不替代 Python 权限事实来源。
- 返回 Python 的只包括被选中的结果和用于最终复核的标识，不回传全量文档集合。

## 4. 分阶段实施与 TODO

### Phase 1：查询期取数与准备迁移

- [x] 新增 TS Data Runtime DB reader，按 owner 读取 canonical chunks 与 revision，并保证两者来自同一 SQL 快照。
- [x] TS worker 冷恢复索引时直接调用 Data Runtime；Python 不再将完整索引正文搬进 sidecar。
- [x] TS 从 owner 存储读取持久向量缓存，并按当前索引文档键及模型版本装载。
- [x] TS Memory loader 读取 owner Memory index/profile/pattern/daily 文件及向量缓存。
- [x] TS Memory loader 校验 scope owner、尊重 tombstone，并在 TS 内执行 source filter、快照合并/去重及 transient corpus 准备。
- [x] Python 查询链改为传授权 scope 与检索参数，不传 Memory 正文或向量；保留最终 owner/scope 复核。
- [x] unified query 在 TS worker 内完成召回、融合、排序、去重和输出诊断。
- [x] 补齐本地 StorageReader 越权、路径穿越、符号链接、Memory scope/tombstone、向量版本及 worker 原子装载回归。
- [x] 本地验证：TS typecheck、TS 全量测试、Python RAG 回归、worker bundle 启动与 JSONL ping。
- [ ] 在 devserver 验证本地/OSS 配置、真实索引冷启动与 warm query；对比每来源阶段耗时、超时率和结果一致性。

Phase 1 本地验证记录（2026-09-12）：TS 全量测试 78 项通过，Python RAG 相关回归 54 项通过，typecheck、frozen lockfile 校验及 `git diff --check` 通过；临时构建 worker 的 `--version` 与 JSONL `ping` 冒烟通过。尚未在 devserver 对现有数据做运行时性能验证，因此 devserver 项保持未完成。

### Phase 2：完成查询链路剩余迁移与责任收敛

- [x] 将统一 RAG query embedding 请求从 Python 移入 TS；冻结 BYOK 凭据传递、出站 URL/DNS pin、代理、4 秒请求超时、响应大小、重定向和错误退化契约。超时会销毁进行中的 HTTP 请求；当前 JSONL IPC 不提供独立的协作式取消消息。
- [x] 审计统一 RAG 查询路径 Python 残留：身份/权限、有效 provider 配置解密、URL 安全校验和 DNS pin、最终 owner/scope 复核、引用组装与上下文注入保留；query vector、来源准备和检索计算归 TS。共享 Python `embed()` 保留给写侧向量、非 RAG 的 Agent 上下文 Memory 超预算挑选和离线诊断回放；Python `hybrid_results` 仅保留为离线诊断参考实现。
- [x] 本地阶段探针记录 `query_embedding_config`、worker `query_embedding`、provider outcome/status、向量维度及 worker query 耗时；TS 本地代理模拟与 provider mock 均验证通过。
- [x] 使用隔离 owner/scope fixture 验证 query embedding owner 绑定、scope 过滤、向量融合及错误退化；非法 owner 在访问 provider 前拒绝。
- [ ] 在 devserver 现有数据上采集至少两轮冷/热查询的 `index_cache_get`、Memory 准备、query embedding、worker query P50/P95、超时率和文档/向量计数，并与统一查询基线核对。记录运行环境、索引 revision 与数据集。

Phase 2 本地验证记录（2026-09-13）：Python RAG/embedding 相关回归 93 项通过，TS 全量测试 86 项通过，`git diff --check` 通过。TS typecheck 仍被当前工作树中既有 RAG-9 契约漂移阻断（`watermark`、`fallback_full`、`probe`、`applied_upserts` 字段）；本次改动未引入新增 typecheck 报错。devserver 真实数据验收仍待部署运行实例后采样。

## 5. 验收标准

1. 常规查询冷/热路径中，Python 不读取全量 RAG 文档正文、Memory 文件或持久向量。
2. TS 的 DB 文档和 revision 同快照；向量及 Memory cache 按 owner、scope、revision/model version 隔离。
3. 每个来源的准备状态和耗时可独立观察；一个来源失败不能伪装成所有来源成功或空结果。
4. 最终交付前经过 Python 权限复核；非法 owner/scope 请求无法从 TS worker 读取或返回其他 owner 数据。
5. Devserver 的性能结论基于固定数据、冷/热状态和可复现调用，不以单次成功或 `document_count` 增长替代验收。

## 6. 后续关联

- 查询期读取和准备：本 PRD（RAG-10）。
- 业务变更后的 source projection、增量索引写入与事件恢复：PRD-RAG-9。
- embedding provider / BYOK 查询 API：统一 RAG 查询已在 Phase 2 迁入 TS；写侧向量生成与非 RAG 上下文 Memory 挑选继续使用共享 Python embedding 原语。
