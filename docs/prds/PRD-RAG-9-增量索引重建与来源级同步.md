# PRD-RAG-9：增量索引重建与来源级同步

> 状态：Draft
> 创建：2026-09-09
> 更新：2026-09-09
> 所属层：RAG / Source Projection / TypeScript Worker
> 前置 PRD：[`PRD-RAG-7-TS全链路检索分阶段迁移.md`](./PRD-RAG-7-TS全链路检索分阶段迁移.md)
> 关联规范：[`RAG 与 Knowledge 架构`](../agent/06-RAG-AND-KNOWLEDGE.md)
> 关联代码：`backend/agent/rag/`、`backend/agent/events/`、`backend/ts/workers/rag/`

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

1. 修改一个文档不应重新读取和重新投影整个来源。
2. 文档内容变化后，旧 chunk 必须被准确删除，不能只追加新 chunk。
3. 文件移动、项目归档、Knowledge 删除等非“新增”操作必须清理旧索引记录。
4. 连续变更不能启动多个同源全量任务，也不能因合并事件而丢掉最终状态。
5. TS worker 的 patch 必须绑定正确的 `base_revision`；revision 冲突不能静默覆盖其他 worker 的更新。
6. 事件是至少一次投递语义，索引失败或进程重启后必须有可恢复路径。
7. 当前轮的 session snapshot 继续保持稳定；增量索引不强制改写已经组装的上下文前缀。

## 2. 目标与非目标

### 2.1 目标

1. Knowledge 优先支持文档级增量重建。
2. 文件、项目、日历、画布、对话和 Memory 按各自稳定父文档粒度接入增量更新。
3. 只读取变更对象及其必要的旧投影，不扫描无关来源数据。
4. 只生成变化文档的 chunk，并计算 `upserts` 与 `deletes`。
5. 通过 TS worker `patch` 原子推进索引 revision。
6. 同一用户同一来源最多一个运行中的更新 worker；运行期间的新事件保留最后状态并在当前任务后再处理一次。
7. revision mismatch、worker 重启、索引损坏和事件丢失均有显式诊断和来源级回退。
8. 保留 owner/scope 权限边界、内容 hash、citation、chunk 稳定槽位和现有 RAG 排序契约。
9. 建立可量化的全量与增量性能基线。

### 2.2 非目标

- 不改变 BM25、hybrid、confidence、top-k 或现有排序算法。
- 不让 TS worker 访问数据库、文件库、Knowledge 存储、网络或用户凭据。
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
2. 运行任务时，新事件只更新 pending 状态和最后事件，不再启动并发来源重建。
3. 当前任务完成后，如果存在 pending，则重新读取当前主数据并再执行一次。
4. `upsert → delete` 最终按 delete 处理；`delete → upsert` 最终按当前主数据重新投影。
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
| knowledge | 单 Knowledge 条目 | 修改正文、关键词、来源或置信度时重建该条目全部 chunk |
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

MVP 可以继续使用进程内合并队列，但必须增加以下恢复机制之一：

- 持久化 dirty marker，记录 owner、source_type、source_id 和目标版本；或
- 使用可重放的索引 outbox，在业务事务提交后写入待处理事件。

进程启动时扫描未完成 dirty/outbox，按来源重放；不存在 durable marker 时，必须提供来源级定期校准任务，不能宣称事件丢失可自动恢复。

### 8.3 Worker 重启

TS worker 重启后优先从持久化索引恢复。恢复版本与数据库 projection revision 不一致时：

1. 禁止直接 patch；
2. 加载当前 projection；
3. 执行 replace；
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

- [ ] 实现 Knowledge 单条读取和单条 canonical projection。
- [ ] 实现单 `source_id` chunk projection 增量写入。
- [ ] 接入 TS worker patch，并保留 mismatch 来源级 replace 回退。
- [ ] 接入 Knowledge 向量 upsert/delete。
- [ ] `save_knowledge`、`delete_knowledge` 和自动反思统一使用该事件链。

验收：1000 条 Knowledge 中修改 1 条时，只读取和 patch 该条；正文修改、关键词修改、删除和恢复均无旧 chunk 残留。

### Phase 2：文件与项目增量

- [ ] 文件覆盖、重命名、移动、删除接入单文件/受影响目录增量。
- [ ] 项目字段、阶段和待办变化接入项目级增量。
- [ ] 明确文件夹和项目父文档变化时的受影响集合。
- [ ] 增加文件库、项目 UI 可见性与 RAG 召回一致性回归。

验收：单文件或单项目变更不会扫描无关对象；移动后旧目录/旧项目 scope 不再召回。

### Phase 3：剩余来源与 durable recovery

- [ ] Calendar、Canvas、Note、Conversation、Memory 接入统一 delta contract。
- [ ] 引入 dirty marker 或索引 outbox。
- [ ] 启动恢复、失败重放和定期来源校准落地。
- [ ] 统一事件合并、取消、重试和状态查询。

验收：重启、重复事件、事件丢失模拟后，索引最终与主数据一致；无法恢复时有明确管理诊断。

### Phase 4：性能优化与旧路径清理

- [ ] 对比来源级 replace、chunk diff、TS patch 的 P50/P95。
- [ ] 校准批量事件合并窗口，避免过短导致重复 patch、过长导致明显延迟。
- [ ] 确认所有来源默认走增量；只保留明确的来源级重建和管理校准入口。
- [ ] 清理重复差异实现、旧 shadow 路径和仅用于迁移的测试。

验收：生产默认更新路径不再因单文档变化触发来源级全量重建；全量回退仍可手动执行并有测试覆盖。

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

## 12. 文件修改目录树

预计目录变化如下，实际实现时不得为了增量能力复制一套 tokenizer 或权限逻辑：

```text
docs/
├── agent/
│   └── 06-RAG-AND-KNOWLEDGE.md                  # 更新索引生命周期与增量边界
├── devlog/
│   └── YYYY-MM-DD-RAG增量索引实施.md             # 记录真实验证和回退案例
└── prds/
    └── PRD-RAG-9-增量索引重建与来源级同步.md      # 本 PRD

backend/agent/
├── events/
│   ├── bus.py                                    # 合并队列、重试和状态
│   └── types.py                                  # 事件字段/版本
├── rag/
│   ├── delta.py                                  # 通用 parent/chunk diff
│   ├── index_builder.py                          # 单对象 source record / projection
│   ├── persistent_store.py                       # 文档级 projection 增量写入
│   ├── pipeline.py                               # patch、replace 回退和恢复
│   ├── index_cache.py                            # revision 与 patch 前后缓存
│   ├── vector_cache.py                           # 变化文档向量同步
│   └── adapters/
│       ├── knowledge.py                          # Knowledge 单条读取
│       ├── indexed_sources.py                    # file/canvas/note 单对象读取
│       ├── projects.py                            # project 单对象读取
│       └── conversations.py                      # conversation watermark 增量
└── tools/
    └── memory.py                                 # save/delete Knowledge 事件状态

backend/ts/
├── packages/contracts/src/rag.ts                 # delta/patch 契约
└── workers/rag/
    ├── src/index.ts                              # patch 原子更新
    └── test/worker.protocol.test.ts              # patch/revision 回归

backend/tests/
├── test_rag_delta.py                             # 通用 chunk diff
├── test_rag_incremental_knowledge.py             # Knowledge 文档级增量
├── test_rag_incremental_sources.py               # file/project 等来源
├── test_rag_index_recovery.py                    # mismatch/restart/replay
└── test_rag_event_coalescing.py                  # 同源事件竞态
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
4. 同源并发更新不会重复启动来源级任务，也不会丢最终状态。
5. 索引失败不会影响业务主数据提交，且能通过重放或来源级重建恢复。
6. 当前 session snapshot、权限校验、排序分数和上下文前缀行为保持不变。
7. 诊断和日志不包含正文、附件、凭据或宿主机路径。
8. 完成全量与增量性能对比，并记录在对应 devlog 中。
