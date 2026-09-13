# PRD-RAG-9：增量索引重建与来源级同步

> 状态：Phase 0–4 已有实现记录；Phase 5 待缺口收敛与验收
> 创建：2026-09-09
> 更新：2026-09-13（补记查询侧 delta sync 恢复层；Phase 5 清单对齐实现现状）
> 所属层：RAG / Source Projection / TypeScript Worker
> 前置 PRD：[`PRD-RAG-7-TS全链路检索分阶段迁移.md`](./PRD-RAG-7-TS全链路检索分阶段迁移.md)
> 关联规范：[`RAG 与 Knowledge 架构`](../agent/06-RAG-AND-KNOWLEDGE.md)
> 关联代码：`backend/agent/rag/`、`backend/agent/events/`、`backend/ts/workers/rag/`

> 架构边界（2026-09-13）：TS Data Runtime 已承担查询期数据库索引及已接入来源的只读加载，Memory/受限文件读取通过 `StorageReader`；Python 负责身份认证、授权校验与索引写侧编排。本 PRD 仅定义业务变更后的 source projection 持久化、增量写入和 worker patch/recovery，不约束或否定 RAG-10 的 TS 查询期取数能力。写侧 doc-patch 是常态主路径；查询侧 `sync_index_from_database`（按 chunk 表水位增量补差）是官方恢复层，职责划分见 §8.2，不因查询侧具备自愈能力而豁免写侧的合并正确性要求。

## 0. 一句话目标

业务对象发生新增、修改、移动或删除时，只重新投影受影响的文档和 chunk，并通过 TS worker 的 `patch` 原子更新索引；只有 revision 冲突、索引损坏或无法确定变化范围时，才回退到来源级全量重建。

## 1. 背景与问题

### 1.1 当前实现

当前链路已经具备部分增量能力：

```text
业务主数据变更
      ↓
RagIndexUpdated(user, source_type, source_id, operation)
      ↓
来源适配器重新读取来源数据
      ↓
生成当前来源的全部 source record / chunk
      ↓
knowledge_index_entries 来源级替换
      ↓
TS worker 根据前后文档差异执行 patch 或 replace
```

当前各层的实际语义不同：

| 层级 | 当前能力 | 是否真正增量 |
| --- | --- | ---: |
| 业务事件 | 已携带 `source_id` 和操作类型 | 是，但事件消费仍可合并优化 |
| Source adapter | 多数来源按来源读取全部对象 | 否 |
| `knowledge_index_entries` | 对来源内 chunk 做新增、更新和删除对比 | 部分是 |
| TS worker | 支持 `patch(upserts, deletes, base_revision)` | 是 |
| Memory 专用索引 | 仍按 Memory 语料整体重建 | 否 |

因此，单个 Knowledge 条目修改时，当前可能重新读取该用户全部 Knowledge；单个文件或项目修改时，也可能重新构建整个来源。数据量增大后，索引更新时间、数据库读取量、TS IPC payload 和向量同步成本都会随来源规模增长。

### 1.2 需要解决的问题

1. 修改一个文档不应重新读取和重新投影整个来源。本 PRD 描述的是索引写侧的来源 adapter 行为；查询期 TS Data Runtime 读取见 PRD-RAG-10。
2. 文档内容变化后，旧 chunk 必须被准确删除，不能只追加新 chunk。
3. 文件移动、项目归档、Knowledge 删除等非“新增”操作必须清理旧索引记录。
4. 连续变更不能启动多个同源全量任务，也不能因合并事件而丢掉最终状态。
5. TS worker 的 patch 必须绑定正确的 `base_revision`；revision 冲突不能静默覆盖其他 worker 的更新。
6. 事件是至少一次投递语义，索引失败或进程重启后必须有可恢复路径。
7. 当前轮的 session snapshot 继续保持稳定；增量索引不强制改写已经组装的上下文前缀。

## 2. 目标与非目标

### 2.1 目标

1. Knowledge 优先支持文档级增量重建。
2. 文件、项目、日历、画布接入文档级增量；Conversation 与 Memory 先保留现有来源级、watermark、瞬态槽或 snapshot 语义，是否纳入文档级增量由 Phase 5 明确产品范围和验收边界。
3. 只读取变更对象及其必要的旧投影，不扫描无关来源数据。
4. 只生成变化文档的 chunk，并计算 `upserts` 与 `deletes`。
5. 通过 TS worker `patch` 原子推进索引 revision。
6. 同一用户同一来源最多一个运行中的更新 worker；运行期间的新事件保留最后状态并在当前任务后再处理一次。
7. revision mismatch、worker 重启、索引损坏和事件丢失均有显式诊断和来源级回退。
8. 保留 owner/scope 权限边界、内容 hash、citation、chunk 稳定槽位和现有 RAG 排序契约。
9. 建立可量化的全量与增量性能基线。

### 2.2 非目标

- 不改变 BM25、hybrid、confidence、top-k 或现有排序算法。
- 本 PRD 的写路径不把数据库事务、文件/Knowledge 写入或凭据交给 TS worker；查询期 Data Runtime 的受限只读访问由 PRD-RAG-10 定义。
- 不在 TS worker 内实现 ownership、workspace、project、folder、group/member 权限判断。
- 不把增量更新变成当前轮实时刷新机制；当前轮已冻结的 snapshot 仍按既有生命周期工作。
- 不在业务写入事务中同步等待完整索引重建。
- 不为每种来源维护一套独立的 Python 分词或切块实现。
- 不把索引投影当作 Knowledge、文件或项目的事实来源。

## 3. 核心概念与粒度

### 3.1 三种“增量”

必须在实现和诊断中区分以下三种粒度：

```text
文档级增量：只读取变化的业务对象
      ↓
chunk 级增量：只生成变化文档的新增/修改/删除 chunk
      ↓
索引级增量：只向 TS worker 发送 upserts/deletes
```

只有三层都成立，才称为“真正的增量重建”。当前 `replace_source_documents()` 的来源内对比和 TS `patch` 不能单独代表文档级增量。

### 3.2 稳定文档键

所有来源必须定义稳定的父文档键和 chunk 槽位：

```text
parent_key = source_type + ":" + source_id
chunk_key  = source_type + ":" + parent_key + ":" + chunk_index
```

实现必须沿用当前 worker 的 `_worker_document_key()` 契约。内容变化时优先复用未变化 chunk 的槽位；chunk 数减少时，旧槽位必须进入 `deletes`。

文档版本变化不能单独导致全部 chunk 被视为新文档。比较依据至少包括：

- 稳定 chunk key；
- TS canonical projection 版本；
- chunk 内容 hash；
- scope、标题、摘要和必要元数据的规范化 hash。

## 4. 目标架构

```text
业务事务提交
      ↓
持久化 RagIndexUpdated / dirty marker
      ↓
用户 + source_type 合并队列
      ↓
读取 source_id 对应对象及旧 projection
      ↓
TS canonical projection / chunk
      ↓
计算 upserts + deletes
      ↓
knowledge_index_entries 增量写入
      ↓
TS worker patch(base_revision → revision)
      ↓
索引 ready
```

出现以下情况时回退：

```text
source_id 缺失或来源不支持单文档读取
      OR 旧投影无法确定
      OR TS revision mismatch
      OR worker 恢复失败/索引损坏
      ↓
来源级全量重建
```

回退必须是显式的 `rebuild_mode=source` 诊断状态，不得静默伪装成增量成功。

## 5. 事件与队列设计

### 5.1 事件字段

沿用 `RagIndexUpdated`，补齐以下约束：

```json
{
  "user_id": "owner identity",
  "source_type": "knowledge",
  "source_id": "business object id",
  "operation": "upsert | delete | refresh",
  "version": "optional source version"
}
```

事件正文、文件内容、附件、凭据和宿主机路径不得进入事件日志或诊断日志。

### 5.2 合并规则

合并键为：

```text
(owner_user_id, source_type)
```

规则：

1. 没有运行任务时，事件进入队列并启动 worker。
2. 运行任务时不启动并发 worker。来源级重建可以合并为一次刷新；文档级增量必须保留所有待处理的 `source_id`，不能只留下最后一个文档事件。
3. 当前任务完成后，按待处理文档 ID 重新读取当前主数据并逐项投影；遇到无 `source_id` 的 refresh 事件时，升级为来源级重建并清空已覆盖的文档级 pending 集合。
4. 每个文档的最终动作由当前主数据决定：对象存在则 upsert，不存在则 delete；不能只依据最后一条事件的 `operation` 推断最终状态。
5. 合并只减少重复工作，不能依据旧事件正文推断最终数据。
6. worker 成功完成后才推进 `completed_generation`；失败必须保留失败状态和回退原因。

### 5.3 至少一次与幂等

同一事件可能重复投递。重复事件在以下条件下必须是幂等的：

- 主数据没有变化时，`upserts=[]`、`deletes=[]`；
- projection revision 不变时，不重复写入相同内容；
- TS worker 已处于目标 revision 时，允许直接复用；
- 删除已不存在的对象不报业务错误，但必须保证旧 chunk 已清理。

## 6. 增量重建流程

### 6.1 文档级读取

每个 source adapter 增加明确的单对象入口：

```python
async def build_source_record(
    db, owner_user_id, source_type, source_id
) -> SourceRecord | None:
    ...
```

返回 `None` 表示对象已删除或不再满足可见条件。对于移动操作，必须同时处理旧 scope 和新 scope；不能只更新新目录而留下旧目录索引。

如果一个业务对象会派生多个父文档，adapter 必须返回受影响父文档集合；不能用一个 `source_id` 粗略覆盖无关对象。

### 6.2 chunk 差异

读取旧投影中同一 `source_id` 的所有 chunk，与当前 canonical projection 生成的 chunk 做差异：

```text
current = {chunk_key: document}
previous = {chunk_key: document}

upserts = current[key] 为空或 content_hash / metadata_hash 变化的项
deletes = previous 中不再出现在 current 的项
```

差异计算不得把正文写入日志。诊断只记录数量、版本、来源类型和耗时。

### 6.3 数据库投影

新增 `replace_document_chunks()` 或等价的来源适配接口，职责是：

1. 按 owner、source_type、source_id 读取旧 chunk。
2. 对变化 chunk 做 insert/update。
3. 删除当前文档已不存在的 chunk。
4. 保留未变化 chunk 的数据库 ID 和稳定字段。
5. 在同一数据库事务中提交 projection revision。
6. 主数据事务未成功时不得更新索引投影。

现有 `replace_source_documents()` 继续保留为来源级重建入口，用于回退、管理脚本和定期校准。

### 6.4 TS patch

数据库投影提交后，向 TS worker 发送：

```json
{
  "op": "patch",
  "base_revision": "revision-before-change",
  "revision": "revision-after-change",
  "upserts": ["changed canonical documents"],
  "deletes": ["stable chunk ids"]
}
```

要求：

- `base_revision` 不匹配时返回明确 `revision_mismatch`；
- patch 在 worker 内存和磁盘持久化中原子生效；
- patch 成功后才标记 index ready；
- patch 失败不得把数据库 projection 回滚成旧版本；
- mismatch 后由 Python 重新读取当前 projection 并执行来源级 replace。

### 6.5 向量同步

增量向量同步只处理变化文档：

- `upserts` 中生成或更新对应向量；
- `deletes` 中移除对应向量缓存；
- embedding 不可用时保持现有 BM25 行为，并显式记录未同步原因；
- 不因单条向量失败而删除已经可用的 lexical index。

Knowledge、Memory 和其他来源的向量缓存继续保持各自边界，不把向量生成职责迁入 TS worker。

## 7. 各来源实施边界

| 来源 | 首选增量粒度 | 特殊处理 |
| --- | --- | --- |
| knowledge | 单 Knowledge 条目 | 修改正文、关键词、描述、来源或置信度时重建该条目全部 chunk；关键词与描述参与 document_version 戳（`{version}:k{hash}`） |
| file | 单文件；文件夹移动需处理旧/新父目录 | 文件删除、覆盖、重命名和移动必须清理旧 chunk |
| project | 单项目或单阶段 | 项目状态、阶段和待办变化可能影响同一项目父文档 |
| calendar | 单事件 | 重复事件按稳定业务 ID 去重 |
| canvas/note | 单节点及受影响关系摘要 | 节点关系变化时声明受影响节点集合 |
| conversation | 单消息或单 batch | 保留 conversation watermark，不能召回当前消息之后的内容 |
| memory | profile/pattern 单条，daily 按日期段 | 保留 Memory 专用 snapshot 和向量缓存语义 |

第一阶段只要求 Knowledge 达到真正文档级增量；其他来源先统一事件和差异协议，再按来源逐步接入。

## 8. 一致性、恢复与快照边界

### 8.1 主数据优先

索引是派生投影，任何索引失败都不能回滚已提交的 Knowledge、文件、项目或 Memory 主数据。下一次事件或校准任务必须能够从主数据重建索引。

### 8.2 事件丢失

MVP 使用进程内合并队列 + durable outbox。**已知的实现现状（2026-09-13 核对）**：内存队列与 outbox 对同一 `(owner, source_type)` 都只保留最后一条事件的 `source_id`，被覆盖的中间文档 ID 不会走写侧 doc-patch。

该现状由**查询侧增量自同步**兜底（官方恢复层，非隐式行为）：TS worker 的 `sync_index_from_database` 按 `knowledge_index_entries` 的 chunk 表水位（watermark）只读取变更行并 patch 内存/磁盘索引，查询路径发现 revision 落后于 DB projection 时先同步再检索；水位缺失或超出墓碑视界时回退全量装载（`fallback_full`）。因此被合并丢弃的文档 ID 的最坏后果是「写侧少推一次 patch」，最终一致性由查询前自愈保证，不产生用户可见陈旧。

写侧与查询侧的分工：

```text
写侧 doc-patch（主路径）：事件驱动、低延迟，把变更推到 worker
查询侧 delta sync（恢复层）：冷启动/重启/事件丢失后的 revision 漂移自愈
```

恢复机制仍须满足以下之一（现状为 durable outbox）：

- 持久化 dirty marker，记录 owner、source_type、source_id 和目标版本；或
- 使用可重放的索引 outbox，在业务事务提交后写入待处理事件。

进程启动时扫描未完成 dirty/outbox，按来源重放；不存在 durable marker 时，必须提供来源级定期校准任务，不能宣称事件丢失可自动恢复。Phase 5 需对「合并丢 ID → 查询前 delta sync 收敛」补显式回归（见 §10 Phase 5）。

### 8.3 Worker 重启

TS worker 重启后优先从持久化索引恢复。恢复版本与数据库 projection revision 不一致时：

1. 禁止直接 patch；
2. 加载当前 projection——优先走查询侧 delta sync 按水位增量补差；
3. 水位缺失或不可信时执行来源级 replace（`fallback_full`）；
4. 成功后清除恢复错误状态。

### 8.4 Session snapshot

增量索引完成不主动改写当前 session snapshot，也不把新 Knowledge 强行插入当前轮 history。下一轮按现有 snapshot/baseline 生命周期读取新 revision；同一轮重复搜索的行为由提示词约束，不通过破坏稳定前缀解决。

## 9. 诊断与指标

只记录安全元数据：

```json
{
  "source_type": "knowledge",
  "mode": "document_patch | source_replace",
  "event_generation": 8,
  "upsert_count": 1,
  "delete_count": 0,
  "projection_ms": 12,
  "patch_ms": 8,
  "base_revision_match": true,
  "status": "ready | queued | failed"
}
```

禁止记录：

- Knowledge/文件/项目正文；
- 查询原文、附件名和用户输入；
- 宿主机路径、容器路径和工作区绝对路径；
- Token、密钥、凭据和 URL 中的敏感参数；
- 未经脱敏的异常堆栈。

必须能够区分：

- `document_patch`；
- `source_replace`；
- `revision_mismatch`；
- `worker_unavailable`；
- `projection_failed`；
- `event_replayed`；
- `no_change`。

## 10. 分阶段实施计划

### Phase 0：契约、基线与差异工具

- [x] 冻结 `parent_key`、`chunk_key`、content hash 和 projection revision 契约。
- [x] 为现有来源级重建增加 `mode`、upsert/delete 数量和耗时诊断。
- [x] 抽出通用 chunk diff 工具，不复制 tokenizer 或切块逻辑。
- [x] 补齐重复事件、删除、无变化和 revision mismatch fixture。
- [x] 记录 Knowledge、file、project 在不同规模下的全量基线。

验收：同一输入下 diff 结果确定；正文不进入可见日志；旧来源级重建行为不变。

### Phase 1：Knowledge 文档级增量

- [x] 实现 Knowledge 单条读取和单条 canonical projection。
- [x] 实现单 `source_id` chunk projection 增量写入。
- [x] 接入 TS worker patch，并保留 mismatch 来源级 replace 回退。
- [x] 接入 Knowledge 向量 upsert/delete。
- [x] `save_knowledge`、`delete_knowledge` 和自动反思统一使用该事件链。

验收：1000 条 Knowledge 中修改 1 条时，只读取和 patch 该条；正文修改、关键词修改、删除和恢复均无旧 chunk 残留。

### 阶段责任边界

以下按代码责任域划分，不预设人员负责人。阶段验收由对应模块和测试共同负责；跨模块事项由表中列出的主责模块协调，不以接口存在代替端到端验收。

| 阶段 | 主责模块 | 责任边界与交付证据 |
| --- | --- | --- |
| Phase 0 | `backend/agent/rag/delta.py`、`persistent_store.py`、TS RAG contracts | 稳定键、digest、diff 和 revision 契约；纯函数测试与旧路径回归。 |
| Phase 1 | Knowledge adapter/store、`pipeline.py`、Knowledge vector cache、Knowledge 写入事件 | 单条读/投影/写库/向量/patch 的完整文档生命周期；Knowledge 专项测试。 |
| Phase 2 | file/project adapters 与写入事件发布层、`index_builder.py` | 文件和项目变化的受影响集合、scope 清理及界面可见性；真实 scope 与召回回归。 |
| Phase 3 | Calendar/Note/Canvas adapters、`events/bus.py`、`rag/index_jobs.py`、应用 lifespan | 剩余来源适配与 durable recovery；区分文档级来源和保留来源级/瞬态语义的例外。 |
| Phase 4 | RAG benchmark、TS worker protocol、旧路径清理 | 性能场景与 worker 原子性/恢复证据；报告与实际跑过的场景一致。 |
| Phase 5 | `events/bus.py`、`rag/index_jobs.py`、`pipeline.py`、来源回归测试和本 PRD/devlog | 收敛本轮审计缺口；队列/outbox 不丢不同文档 ID，补齐恢复、scope、来源例外测试，并同步状态、责任边界和测试报告。 |

### Phase 2：文件与项目增量

- [x] 文件覆盖、重命名、移动、删除接入单文件/受影响目录增量。
- [x] 项目字段、阶段和待办变化接入项目级增量。
- [x] 明确文件夹和项目父文档变化时的受影响集合。
- [ ] 增加文件库、项目 UI 可见性与 RAG 召回一致性端到端回归（列入 Phase 5）。

验收：单文件或单项目变更不会扫描无关对象；移动后旧目录/旧项目 scope 不再召回。

### Phase 3：剩余来源与 durable recovery

- [x] Calendar、Canvas、Note 接入文档级更新入口。
- [ ] Conversation、Memory 的增量边界尚未按本 PRD 粒度落地：当前保留 conversation 来源级重建和 watermark 语义、Memory 瞬态槽/专用 snapshot 语义；Phase 5 补足兼容性测试并确认是否维持例外，不默认要求改成文档级 patch。
- [x] 引入 dirty marker 或索引 outbox。
- [x] 启动恢复和失败重放通过 durable outbox 落地。
- [ ] 定期来源校准入口未实现；outbox 满足基础恢复路径，管理端校准作为独立运维能力延后。
- [ ] 文档级事件合并需保留同源多个 `source_id`，由 Phase 5 修复并验证（现状与兜底见 §8.2）。
- [x] 事件重试和来源状态查询已接入；文档级合并正确性仍待 Phase 5 验收。

验收：重启、重复事件、事件丢失模拟后，索引最终与主数据一致；无法恢复时有明确管理诊断。

### Phase 4：性能优化与旧路径清理

- [x] 记录 1000/3000 条规模下单文档增量与来源级重建的 P50/P95；chunk diff/TS patch 的独立分段耗时未单独报告。
- [ ] 批量事件合并策略尚未完成校准；先由 Phase 5 保证多 `source_id` 不丢，再依据重复 patch 与延迟测量确定是否需要合并窗口。
- [x] 已接入的六个可单文档投影来源默认走增量；Conversation、Memory 按 Phase 3 所述保留专用语义。
- [x] 清理重复差异实现、旧 shadow 路径和仅用于迁移的测试。

验收：已接入文档级增量的来源不因单文档变化触发来源级全量重建；全量回退仍可手动执行并有测试覆盖。性能报告不得将未测场景标记为已验证。

### Phase 5：测试缺口收敛与阶段责任验收

目标：把 PRD 的行为承诺、实现责任和真实回归证据重新对齐。此阶段不以增加测试数量为唯一目标；若测试揭示行为缺陷，应先修实现，再以回归测试锁定。

- [ ] 修复内存事件队列与 durable outbox 的同源多文档合并：不同 `source_id` 必须全部保留（或使用等价的 dirty-ID 集合）；refresh/来源级事件须有明确的覆盖语义。**现状（2026-09-13 核对）**：bus `_rag_pending` 与 outbox 均只留最后一条 source_id，当前靠查询侧 delta sync（§8.2）兜底；定案二选一——① 修代码摘掉隐性耦合（bus pending 改集合、outbox 存 ID 集合，改动小，推荐）；② 若接受现状，须以测试锁定「合并丢 ID 后查询前自愈收敛」为设计承诺，不得维持 PRD 禁止 + 实现违反 + 无兜底记载的状态。
- [ ] 修正 revision mismatch 回退来源级 replace 后的诊断标注：`mode` 仍为 `document_patch`、只体现 `base_revision_match=False`，改为显式 `mode=source_replace`（对齐 §4「回退不得静默伪装成增量成功」）。
- [ ] 新增并发与重启回归：阻塞文档 A 的 patch 时连续提交 B/C，验证每个最终主数据变更都进入索引（若选择保留合并语义，则断言 B/C 在下一次查询前经 delta sync 收敛）；重启后从 outbox 重放同一批 ID，验证最终 DB projection、worker revision 和查询结果一致。
- [ ] 补齐来源真实变更测试：文件夹移动断言旧 scope 不再召回、新 scope 可召回；项目 UI/索引一致；Calendar/Note 删除清理；Canvas 关系变更更新所有受影响端点。
- [ ] 补齐 Knowledge 与故障边界测试：仅关键词/描述变化、删除后恢复、projection 事务失败、worker 不可用后的真实查询自愈、向量部分失败不破坏 lexical patch、owner/project/folder/group-member scope 隔离。
- [ ] 对诊断模式与日志做 RAG 写路径专属脱敏断言；覆盖 `document_patch`、`source_replace`、`revision_mismatch`、`worker_unavailable`、`projection_failed`、`event_replayed` 和 `no_change`。
- [ ] 完成性能计划中的单文档删除、连续 10 次同源多文档变更、worker 重启恢复测量；分开记录文档读取、chunk 投影、DB 写入、TS patch 与端到端耗时。
- [ ] 明确 Conversation/Memory 的产品范围：若维持当前特殊路径，补 watermark、snapshot、瞬态槽与重复事件回归，并同步 §2、§7、Phase 3 和完成标准；若改为文档级增量，先补独立设计与受影响集合定义。
- [ ] 更新 Phase 0–5 完成状态与实施报告；只有行为、测试和性能证据都齐全的条目才能标记完成。

验收：同一用户同一来源的一批不同文档 ID 不会被事件合并或 outbox 覆盖；重启后最终索引与主数据一致；各阶段责任模块、来源例外和测试报告描述一致。

## 11. 测试计划

### 后端

- 单文档新增、修改、关键词变化、版本变化、删除和恢复；
- chunk 数增加、减少和内容前后移动；
- 同源事件并发合并，验证“首事件 + 最终状态”且无丢更新；
- 重复事件幂等和 no-op；
- projection 事务失败、TS patch 失败、revision mismatch、worker 重启；
- owner、project、folder、group/member scope 隔离；
- 事件和诊断日志脱敏回归；
- 向量部分失败不影响 lexical patch。

### TypeScript worker

- patch 只更新 upserts 并删除 deletes；
- patch revision 原子推进；
- base revision 不匹配拒绝写入；
- 空 patch、重复 patch、删除不存在文档；
- patch 持久化后重启恢复；
- 并发 patch/search 不出现撕裂状态。

### 性能

固定同一 owner、同一来源和同一 revision，分别测：

| 场景 | 指标 |
| --- | --- |
| 1 条文档修改 | 文档读取数、chunk 生成数、upsert/delete 数、端到端耗时 |
| 1 条文档删除 | 旧 chunk 清理数、patch 耗时 |
| 连续 10 次同源变更 | 实际重建次数、最终 revision、队列等待 |
| 全量来源重建 | 作为回退基线 |
| worker 重启后恢复 | 恢复耗时、是否触发 replace |

第一阶段目标不是承诺固定毫秒数，而是证明单文档变更的成本不再随来源总文档数线性增长；具体阈值在 Phase 0 基线后冻结。

## 12. 责任模块与相关目录

本节按当前代码边界区分 RAG-9 写路径和 RAG-10 查询读路径。目录表示责任模块及测试落点，不表示每个文件都需要在同一阶段新增；实际完成状态以 Phase 0–5 和验证记录为准。不得为增量能力复制 tokenizer 或权限逻辑。

### 12.1 本 PRD：索引写入、事件和恢复

```text
docs/
├── agent/06-RAG-AND-KNOWLEDGE.md                 # 维护统一读写架构与索引生命周期
├── devlog/YYYY-MM-DD-RAG增量索引实施.md           # 记录真实验证、缺口和回退案例
└── prds/PRD-RAG-9-增量索引重建与来源级同步.md    # 本 PRD 与 Phase 0–5 验收状态

backend/
├── app/core/events.py                            # 业务资源写入后的 RAG 来源事件映射
├── agent/events/
│   ├── bus.py                                    # 写侧队列、串行消费、重试与恢复调度
│   └── types.py                                  # RagIndexUpdated 事件契约
├── agent/rag/
│   ├── adapters/                                 # Python 写侧来源读取/授权范围投影
│   ├── delta.py                                  # 通用 parent/chunk 差异契约
│   ├── index_builder.py                          # 来源 source record 与 TS canonical projection 调用
│   ├── index_jobs.py                             # durable outbox、重试与状态
│   ├── persistent_store.py                       # KnowledgeIndexEntry 事务性增量写入
│   ├── pipeline.py                               # 单文档 patch、来源 replace 与恢复编排
│   └── vector_cache.py                           # 写侧向量同步
├── agent/tools/memory.py                         # Knowledge 工具写入事件
├── tests/
│   ├── test_rag_delta.py
│   ├── test_rag_knowledge_delta_index.py
│   ├── test_rag_file_project_delta.py
│   ├── test_rag_remaining_sources_delta.py
│   ├── test_rag_index_jobs.py
│   └── test_event_bus.py                         # 现有覆盖；Phase 5 在对应测试中补并发/多 ID/重启回归
└── ts/
    ├── packages/contracts/src/rag.ts             # projection、replace、patch 协议
    └── workers/rag/
        ├── src/index.ts                          # worker patch/replace 与 revision 处理
        ├── src/index-builder.ts                  # TS canonical source projection / chunk
        ├── src/adapters/                         # TS 来源投影适配器
        └── test/worker.protocol.test.ts          # patch/revision 协议回归
```

### 12.2 关联但不属于本 PRD 写路径迁移：TS 查询期只读数据层

以下模块由 RAG-10 定义其查询期责任。它们读取 canonical 索引、revision 和接入的 source 数据；不负责 RAG-9 的业务事件、持久索引写事务或向量写入。

```text
backend/ts/packages/data-runtime/src/
├── runtime.ts                                    # owner 绑定的只读 SQL/source reader
├── rag-loader.ts                                 # source batch/cache 与 Memory 读取入口
├── storage-reader.ts                             # 文件正文/Memory 的受控存储读取
└── contracts.ts                                  # DataAccessContext / StorageReader 契约

backend/ts/workers/rag/src/
├── index.ts                                      # 查询期 DB index load/delta sync 与 worker 调度
└── memory-loader.ts                              # Memory scope、快照及瞬态语料准备
```

## 13. 回滚策略

- 保留来源级 `replace` 管理入口，不删除全量重建能力。
- 增量 patch 失败时只回退索引投影，不回滚业务主数据。
- 发现 chunk key、revision 或权限边界不一致时，关闭该来源增量开关并执行来源级校准。
- 回滚期间仍记录 `mode=source_replace` 和固定失败原因，禁止静默降级。
- 确认增量路径通过生产数据校准后，再清理仅用于迁移的旧实现和测试。

## 14. 完成标准

本 PRD 完成必须同时满足：

1. Knowledge 单文档变更不再读取整个 Knowledge 来源。
2. 修改、删除、移动后的旧 chunk 和旧 scope 均能清理。
3. TS patch 的 revision mismatch、重启和重复事件均有回归测试。
4. 同源并发更新不会重复启动来源级任务，且多个不同 `source_id` 不会在内存合并或 durable outbox 中丢失。
5. 索引失败不会影响业务主数据提交，且能通过重放或来源级重建恢复。
6. 当前 session snapshot、权限校验、排序分数和上下文前缀行为保持不变。
7. 诊断和日志不包含正文、附件、凭据或宿主机路径。
8. 完成全量与增量性能对比，并记录在对应 devlog 中。
9. Conversation/Memory 等保留专用路径的来源例外已被明确记录并有相应回归测试；阶段责任与完成状态和实际证据一致。
