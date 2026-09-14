# PRD-RAG-9 Phase 5 收敛：三个潜伏 bug 与一次「测试揭示缺陷」的完整闭环

> 日期：2026-09-13
> 关联：[PRD-RAG-9](../prds/PRD-RAG-9-增量索引重建与来源级同步.md)、[实施报告](../reports/2026-09-13-IMPLEMENT-PRD-RAG-9-Phase5收敛验收.md)
> 提交：`0f443278c`（Phase 5 实施）、`25b8efa19`（PRD 修订）、迁移 `20260914000001`

## 背景

Phase 5 的目标是把 PRD 行为承诺、实现责任和回归证据重新对齐，预期产出是测试。实际结果：产出测试 16 例的同时挖出 3 个潜伏 bug，其中一个是索引正确性级别的数据丢失。

## 过程

### 先核对，再动手

开工前先派探查代理把 PRD 与实现逐条对照，结论：doc-patch 主链未偏离，但 bus/outbox 合并丢 source_id（PRD 明确禁止）靠查询侧 delta sync 未记载地兜底着。据此先修 PRD（把隐式兜底写成官方恢复层、Phase 5 合并项改为「修代码（推荐）或锁定自愈承诺」二选一），用户拍板修代码。

### bug 1：部分编辑静默丢 chunk（P1）

写文件夹移动测试时 chunk 计数始终对不上。追下去发现不是测试问题：`update_document` 把 `delta.upserts`（只有变化的 chunk）传给 `apply_document_patch`，而后者是「父文档作用域 replace」语义——不在键集的既有行一律打墓碑。于是编辑 3 段文档中的 1 段，另外 2 段完好内容会被从索引里删掉，召回静默丢内容。

**修法**：DB 侧传当前全量 chunk 集（replace 语义正确收敛、未变化行保留），worker 侧维持 delta（增量语义不变）。两个消费方语义本来就不同，之前被同一个参数列表耦合了。

### bug 2：写路径诊断从未落过日志（P1）

给诊断七态写断言时 caplog 什么都没抓到。查 `diagnostics.py`：`record_index_update` 用了 `_log.info(json.dumps(...))`，但模块里**既没有 `import json` 也没有 logger 定义**——每次调用 NameError 被 `except Exception: pass` 吞掉。也就是说 PRD §9 的整条诊断链从上线起就是空转的，之前从没人发现，恰恰因为没人看过它的输出。

### bug 3：每次 patch 全量扫描索引的死代码（P2）

性能基线显示单文档修改 p50 高达 79ms（1000 条规模，理论上应是毫秒级）。查 `update_document`：`load_index_documents` 全量加载 owner 索引后赋值给一个从未使用的变量。删掉，p50 → 7.5ms。

### 实现合并定案时的次生坑

outbox 按 ID 集合重放，最初 `mark_result` 成功后把 job 置 `ready`——但集合里还有剩余 ID 时，`due_events` 只捞 queued/retrying/租约过期行，`ready` 的剩余 ID 永远不会被重放。自己的测试当场抓住：改成集合非空时保持 `queued`。

## 验证

- 全量后端 2795 passed；受影响模块复跑 85 passed。
- 性能：单文档修改 7.5ms vs 全量重建 785ms（≈100×），10 连发同源变更每轮 ~120ms 线性。
- 部署：迁移 `20260914000001` 需先 `alembic upgrade head` 再重启服务。

## 教训

1. **「测试揭示行为缺陷，先修实现再锁回归」不是空话**——本次最大的收获（丢 chunk）来自一条意外失败的断言，而不是计划中的任何测试项。
2. **`except: pass` 的可观测性代码必须验证过「真的输出了」**；诊断空转是最安静的一类 bug，因为它不影响任何功能。
3. **同一份数据喂给两个语义不同的消费方时要拆参数**：DB 的 replace 语义要全量，worker 的增量语义要 delta——为了省一次计算把 delta 同时给两边，是丢 chunk 的直接原因。
4. **性能基线先于优化**：死代码不是靠 review 发现的，是靠「这个数字不该这么慢」的直觉测出来的。
5. 修状态机时检查「每个状态在每张查询表里都可达」：`ready` 卡死剩余 ID 这类问题，画一张状态×查询矩阵就能当场看出来。
