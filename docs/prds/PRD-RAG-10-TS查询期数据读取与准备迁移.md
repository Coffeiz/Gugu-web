# PRD-RAG-10：TS 查询期数据读取与准备迁移

> 状态：进行中（Phase 1 代码实现完成，待 devserver 验证；Phase 2 尚未完成）
> 创建：2026-09-12
> 所属层：RAG / Query Runtime / Data Runtime
> 前置 PRD：[`PRD-RAG-7-TS全链路检索分阶段迁移`](./【已完成】PRD-RAG-7-TS全链路检索分阶段迁移.md)
> 索引写入关联：[`PRD-RAG-9-增量索引重建与来源级同步`](./PRD-RAG-9-增量索引重建与来源级同步.md)

## 1. 背景

新版 RAG 的超时探针显示，多来源同时停留在 `index_prepare`。需要把查询期的数据读取、缓存准备和 Memory 语料装载放在同一 TS runtime 内执行，减少 Python 与 worker 之间传输大批文档/向量的开销，并让各来源的准备耗时能被独立观测。

本 PRD 聚焦**查询期读取与准备**，不重复定义 PRD-RAG-9 的业务变更事件、索引投影写入和来源级增量重建。

## 2. 目标与边界

### 2.1 目标

1. TS Data Runtime/worker 读取查询所需的 canonical 索引文档、revision、持久向量和 Memory 数据。
2. TS 在 worker 内完成 Memory 过滤与准备、来源召回、hybrid 融合、去重、排序及结构化诊断。
3. Python 查询链不再加载或传输全量索引正文、Memory 文档或持久向量；只传递经 Python 授权后的 owner/scope、查询参数和必要的上下文水位。
4. Python 保留身份建立、scope 授权、最终 owner/scope 复核和 Agent 上下文注入。
5. 读取或准备失败必须显式报告，不得将错误伪装为空索引或成功完成。

### 2.2 本 PRD 不覆盖

- PRD-RAG-9 管理的索引写入事件、canonical source projection、数据库投影事务和增量 chunk 同步；这些流程现阶段仍由 Python 写侧驱动。
- Embedding provider 的配置解析、BYOK 凭据选择及 `/embeddings` 请求迁移。现阶段 Python 仍生成 query embedding；将其迁到 TS 前必须单独设计凭据传递、代理/出站安全和错误语义。
- 将 TS worker 暴露为网络服务，或让 worker 自行推导用户身份和业务授权。

因此，本 PRD 完成后代表“RAG 查询期数据读取与检索准备已迁到 TS”，不代表整个索引写生命周期或 embedding provider 已完全 TS 化。

## 3. 目标架构

```text
Python API / Agent
  ├─ 认证用户身份
  ├─ 解析并授权 owner / scope / 来源范围
  ├─ 提供 query、消息水位和检索预算
  └─ 最终 owner/scope 复核、引用组装与上下文注入
            │ 本机 JSONL；不传全量正文/向量
            ▼
TS RAG Worker + Data Runtime
  ├─ 按 owner 读取 canonical 索引文档与 revision（同一 DB 快照）
  ├─ 按 owner / model version 读取持久向量
  ├─ 读取 Memory 文件、scope 状态、tombstone 与快照内容
  ├─ 完成 Memory source filter / 去重 / transient corpus 装载
  └─ 完成召回、融合、排序、预算裁剪和阶段诊断
```

### 3.1 权限与存储安全

- Worker 只接受 Python 认证链路传入的 owner；每个 DB 查询都绑定 owner 条件。
- Memory scope 必须由 Python 先授权，worker 再校验 owner 一致、scope 结构合法并检查 tombstone。
- 本地存储 key 必须位于当前 owner 目录；拒绝路径穿越及跨 owner 符号链接。
- OSS 只读访问按 owner 前缀约束。凭据通过 worker 私有环境传入，不进入 argv、JSONL 业务载荷或日志。
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

Phase 1 本地验证记录（2026-09-12）：TS 全量测试 78 项通过，Python RAG 相关回归 54 项通过，typecheck、frozen lockfile 校验及 `git diff --check` 通过；临时构建 worker 的 `--version` 与 JSONL `ping` 冒烟通过。尚未在 devserver 对现有数据做运行时性能验证。

### Phase 2：收窄 Python 到身份与安全边界

- [ ] 设计并实现 query embedding 请求在 TS 的执行方式；先冻结 BYOK 凭据的短生命周期传递、出站 URL/代理策略、超时/取消和错误回退契约，再迁移调用。
- [ ] 审计查询路径 Python 残留，只保留身份、权限事实、最终安全复核、上下文注入及必要的受信任 provider 凭据绑定；移除重复的数据读取/准备状态。
- [ ] 用探针对比迁移前后的 `index_cache_get`、Memory 准备、query embedding、worker query 各阶段 P50/P95、超时率和文档/向量计数。
- [ ] 通过真实 owner/scope 数据验证无跨用户召回，且正常结果与当前 unified 基线一致。

## 5. 验收标准

1. 常规查询冷/热路径中，Python 不读取全量 RAG 文档正文、Memory 文件或持久向量。
2. TS 的 DB 文档和 revision 同快照；向量及 Memory cache 按 owner、scope、revision/model version 隔离。
3. 每个来源的准备状态和耗时可独立观察；一个来源失败不能伪装成所有来源成功或空结果。
4. 最终交付前经过 Python 权限复核；非法 owner/scope 请求无法从 TS worker 读取或返回其他 owner 数据。
5. Devserver 的性能结论基于固定数据、冷/热状态和可复现调用，不以单次成功或 `document_count` 增长替代验收。

## 6. 后续关联

- 查询期读取和准备：本 PRD（RAG-10）。
- 业务变更后的 source projection、增量索引写入与事件恢复：PRD-RAG-9。
- embedding provider / BYOK 的 API 调用迁移：完成 Phase 2 安全设计后再立项或更新本 PRD，不在当前实现中将凭据塞入 worker argv、日志或持久状态。
