# RAG 三处优化核查报告

核查时间：2026-11-27 02:00
核查范围：packages/core/src/agent/rag/ 的三处改动
方法：源码比对 + 测试实跑 + 调用点全仓 grep

---

## 结论速览

| 改动 | 判断 | 遗留问题 |
|---|---|---|
| 删除 `patch()` 与指纹计算 | 成立 | 测试未同步，1 个用例失败 |
| 删除词频缓存 | 成立 | 无 |
| 修正预热绕过 5 万上限 | 成立 | 无 |

**总体：三处改动方向正确、实现正确，但 agent 的验证范围不完整——存在 2 个当前失败的测试，agent 未跑全量测试因此未发现。**

---

## 一、删除 `patch()` 与指纹计算 —— 成立，但漏改测试

### 源码核对

| 项 | 状态 |
|---|---|
| `State.fingerprints:Map` | 已删除 |
| `patchInMemory` 内的指纹比对段 | 已删除 |
| 导出的 `patch(owner, baseRevision, ...)` 方法 | 已删除 |
| `patchInMemory`（内部函数，第 43 行） | **保留** |

**保留 `patchInMemory` 是正确的，不是漏删。** 它是「只重建受影响词项」的增量实现，`synchronize()`（第 233 行）每次增量同步都走它。删掉会退化成全量重建。

### 调用点核查

全仓 `.patch(` 命中中绝大多数是 queue / HTTP API（preferences、calendar、byok、workspaces）。**词法索引的 `index.patch()` 在生产代码中零调用**，仅出现在测试文件。

agent「无生产调用」的判断成立。

### 遗留问题：测试未同步（当前失败）

```
packages/core/tests/unit/data/global-search-conversations.test.ts
  用例：迁入的词法索引支持版本化重建和增量更新，并隔离 owner 与 scope
  失败：expected [Function] to throw error including '索引版本不匹配'
        but got 'index.patch is not a function'
```

该测试文件有 **4 处** `index.patch(...)` 调用（第 604、606、611、620 行），全部未同步。

**该文件本轮的 diff 只有 import 路径修正**（`conversations.js` → `conversations/index.js`、`scheduled-tasks/task-list.js` → `tasks/task-list.js`），**完全没碰 patch 调用**。

### 需要决定

这 4 处调用测的是「版本化重建 + 增量更新 + owner/scope 隔离」这条链路的行为，现在因为 API 被删而无法覆盖。

两种处理：
- **A**：改用 `synchronize()` 等价路径重写这 4 处断言，保留行为覆盖
- **B**：删除这 4 处调用及用例的增量部分，接受覆盖缺口

倾向 A——`synchronize()` 是生产实际路径，用它覆盖比删掉更贴近真实。

---

## 二、删除词频缓存 —— 成立

### 源码核对

| 项 | 状态 |
|---|---|
| `createRagDocumentTermCache` | 已从源码删除 |
| `createRagLexicalIndex(owner, frequencyFor)` 第二参数 | 已删，签名回单参 |
| `addDocument` 的 `frequencyFor` 参数 | 已删，改为直接内部 `tokenizeDocument()` |
| `tokenizeDocument` 函数本身 | 保留（第 30 行，`addDocument` 在用） |
| 源码残留 | 无（`confidence.ts` 里的 `documentTerms` 是同名局部变量，无关） |

### 生产接线确认

`scoped-search.ts` 第 64 行：

```js
const index = ports.lexicalCorpus?.(owner, revision, documents) ?? createRagLexicalIndex(owner)
```

`createRagLexicalCorpusCache()` 走 `replace()` / `synchronize()`，内部直接调 `tokenizeDocument`，**不经过被删的缓存**。

agent 说的「生产 RAG 继续复用按 owner + scope 缓存的完整索引」属实——复用的是完整索引对象，不是词频缓存。

### 缓存命中率实测为 0

上轮调查已发现：缓存上限 2048 篇 vs 实际 12,319 篇，命中率 0。既然只由测试和基准接入，删除是对的。

---

## 三、修正预热绕过 5 万上限 —— 成立

### 当前实现（`createRagLexicalCorpusCache`）

```js
const maxDocuments = 50_000

// synchronize(): 同步路径
if (documents.length <= maxDocuments) retain(key, index, documents.length)
else retain(key, undefined, 0)          // 超限则不缓存索引

// warm(): 预热路径
if (unique.length > maxDocuments) {
  if (!recent.has(key)) retain(key, undefined, 0)
  return                                 // 超限直接返回，不建索引
}
```

**修正后的语义**：超限语料不进入常驻缓存，但**仍然可检索**——`synchronize()` 每次按查询构建用完即弃，索引不长期驻留。

这与 agent 的描述一致：「超限语料仍可搜索，索引按查询构建，不再长期留在缓存里。」

### 测试覆盖

`packages/core/tests/agent/rag/scoped-search.test.ts:250`

```
it('预热超限语料后仍允许检索，当前快照缩小后可复用索引', async () => { ... })
```

覆盖了「超限 → 仍可检索」和「快照缩小 → 恢复复用」两个状态转换。这个测试是本轮新增的。

### 一处观察

`retain()` 的淘汰条件：

```js
while (recent.size > 1 && (recent.size > 4 || total > maxDocuments))
```

注意 `recent.size > 1`——**至少保留 1 个 scope**。若唯一那个 scope 本身超限，`retain(key, undefined, 0)` 已把它的 index 置为 undefined、size 记 0，所以不会占用内存额度。逻辑自洽。

---

## 四、agent 报告的两处数据需要修正

### 4.1 整数 ID 的内存对比

agent 说：「字符串引用增加 20.68 MiB 堆，整数加映射增加 20.96 MiB，没有复现所称的 12.6 MB 节省。」

**这个修正成立，我上轮的 12.6 MB 说法有误。** 上轮那个数字来自我的隔离进程对比，口径不严谨（没有控制 V8 堆碎片和 GC 时机）。agent 用 12,323 个文档 ID + 40,756 个词项做的对照更可信。

结论：**整数 ID 无收益，维持字符串。** agent 已据此不改动，正确。

### 4.2 A/B 基准结果

agent 报告：

| 指标（中位数） | 改动前 | 改动后 |
|---|---|---|
| 冷建索引 | 867 ms | 652 ms |
| 36 次查询 + 1 次增量同步 | 184 ms | 137 ms |
| 构建后 GC 的已用堆 | 32.7 MiB | 32.6 MiB |
| 构建后 GC 的 RSS | 201.9 MiB | 203.4 MiB |

**关键判读：RSS 没有下降（201.9 → 203.4 MiB），耗时下降明显（-25% / -26%）。**

agent 自己也说了：「单份索引没有测到 RSS 下降。这轮确定的收益是移除无用路径、堵住超限语料长期驻留，以及保持检索结果一致。」

**这个自我判断是准确的，与实测一致。** 上一轮我提出的「term 缓存命中率 0 所以内存不降」的预期是对的——删掉一个命中率 0 的缓存不会省下内存，只会省一次无用查找。

**一处口径提醒**：agent 也标注了「耗时是本地合成数据测量，尚未在真实 Web Host 复测」。合成语料的词频分布与真实对话差异大，冷建 -25% 这个数字不宜直接外推到生产。

---

## 五、必须处理：2 个当前失败的测试

agent 报告「RAG 85 项测试、Core 构建和类型检查均通过」——**这句成立但不完整**。

85 项是 `packages/core/tests/agent/rag/` 目录的测试。失败的两个在 `packages/core/tests/unit/data/`，**不在 agent 的验证范围内**。

实跑结果：

```
packages/core/tests/unit/data/global-search-conversations.test.ts
  Test Files  1 failed (1)
  Tests       2 failed | 40 passed (42)

  × 迁入的词法索引支持版本化重建和增量更新，并隔离 owner 与 scope
    → index.patch is not a function                      ← 本轮改动直接引起

  × 持久 RAG 查询限制授权范围并在 embedding 中撤权时拒绝返回
    → expected true to be false（vectorsRead）              ← 见下
```

### 5.1 第一条：patch 遗留（见第一节）

### 5.2 第二条：向量读取时机与旧测试语义冲突

**断言内容**（第 669-671 行）：

```js
const unavailableEmbedding = createScopedRagSearch({
  index: ...,
  vectors: { version:'model-v1',
             source: async () => { vectorsRead = true; return async () => null },
             embed: async () => [] }          // 无 embedding 可用
})
const lexicalFallback = await unavailableEmbedding(ownerId, scope, 'alpha', options)
expect(lexicalFallback.fusion).toBe('bm25')
expect(vectorsRead).toBe(false)               // ← 期望：根本没去读向量
```

**当前实现**（`scoped-search.ts` 第 78-99 行）：

```js
const vectors = ports.vectors
if (!vectors?.version) return lexicalOnly
...
const source = await vectors.source(owner, signal)          // ← 先读向量源
const vectorMap = await readRagDocumentVectors(hits, vectors.version, source, signal, owner)
...
if (!vectorMap.size) { fallbackReason = 'no_matching_document_vectors'; ... }
try { queryVector = await vectors.embed(owner, query, signal) } catch { ... }
```

**旧语义**：先试 embedding，embedding 不可用就直接退回纯 BM25，**完全不碰向量存储**。
**新语义**：先读向量源，确认候选确实有向量后，才去请求 embedding。

两者直接冲突。

**注意**：这个向量流程重写**不属于本轮三处改动**（本轮只动了 scoped-search 的词频缓存接线），是更大范围未提交迁移的一部分。但：

- 本轮 agent 动了 `scoped-search.ts`，属于相邻改动
- agent 新增的测试 `scoped-search.test.ts:137`「只为词法候选读取向量，候选没有匹配向量时不请求 embedding」**明确断言了新语义**（`expect(source.mock.calls).toEqual([['memory', undefined]])` 且 `expect(embed).not.toHaveBeenCalled()`）

**所以这不是 bug，是两条设计主张的冲突，需要人来裁决。**

**新语义的优势**：候选没有向量时**不请求 embedding**，省掉一次付费 API 调用——这正是本轮新增测试想锁定的行为。

**旧测试的顾虑**：embedding 不可用时不该白读一遍向量文件。

**倾向**：保留新语义（省 embedding 调用是实打实的成本节省），更新旧测试的断言——把 `expect(vectorsRead).toBe(false)` 改为 `expect(vectorsRead).toBe(true)` 并补充 `expect(fallbackReason).toBe('no_matching_document_vectors')`，与新测试的意图对齐。

但这需要你确认，因为它改的是一个**授权/降级语义**的断言。

---

## 六、桌面端构建产物需重建

`apps/desktop/resources/core-sidecar/host/` 是 **gitignored 的构建产物**，当前 bundle 里仍是旧代码（含已删除的 `createRagDocumentTermCache`、含 `patch()` 的旧实现）。

**不重建不影响测试通过**（测试跑源码），但**会影响桌面端实际运行行为**——包括预热上限修正不生效、超限语料仍长期驻留。

需要跑桌面端 sidecar 构建。

---

## 七、其他核查项

### 7.1 仓库状态

本轮涉及的文件（相对 HEAD 都是 M，但仓库整体有 947 行未提交改动，其中大部分是本轮之前就有的迁移工作）：

```
 M packages/core/src/agent/rag/lexical-index.ts
 M packages/core/src/agent/rag/scoped-search.ts
 M packages/core/src/agent/rag/context-builder.ts
 M packages/core/src/agent/rag/README.md
 M packages/core/src/agent/rag/index.ts
 M packages/core/src/agent/rag/persistent-index.ts
 M packages/core/src/agent/rag/persistent-writer.ts
 M packages/core/src/agent/rag/scheduled-task-source.ts
 M packages/core/src/agent/rag/vector-reader.ts
 M packages/core/tests/agent/rag/scoped-search.test.ts
 M packages/core/tests/agent/rag/context-builder.test.ts
 M packages/core/tests/agent/rag/memory-search.test.ts
 M packages/core/tests/unit/data/global-search-conversations.test.ts
?? packages/core/scripts/bench-rag-corpus.mjs
?? packages/core/scripts/bench-rag-retrieval.mjs
?? packages/core/scripts/bench-rag-sqlite.mjs
?? packages/core/src/agent/rag/automatic-corpus.ts
?? packages/core/src/agent/rag/scheduled-task-index-job.ts
```

**注意**：`bench-rag-sqlite.mjs`、`automatic-corpus.ts`、`scheduled-task-index-job.ts` 三个新文件**不在 agent 的改动清单里**。前两个是 RAG 侧的新增能力（自动语料、SQLite 基准），第三个是定时任务索引作业。需要确认这些是否也是本轮产物、以及是否该进本轮交付。

### 7.2 死代码确认

`createRagDocumentTermCache` 在源码中已无残留引用（含导出符号）。`packages/core/src/agent/rag/index.ts` 的导出列表已同步更新。

---

## 八、待你决定的事项

| # | 事项 | 建议 |
|---|---|---|
| 1 | 4 处 `index.patch()` 测试调用 | 改用 `synchronize()` 重写，保留行为覆盖 |
| 2 | `vectorsRead` 断言与新语义冲突 | 保留新语义（省 embedding 调用），更新旧断言 |
| 3 | 桌面端 sidecar 重建 | 需要做，否则修正不生效 |
| 4 | 3 个不在清单里的新文件 | 确认归属：是否本轮产物、是否进本轮交付 |
| 5 | 基准数字是否在真实 Web Host 复测 | 合成数据的 -25% 不宜外推 |

---

## 附：实测方法说明

- **patch 调用点**：全仓 grep `.patch(` + 逐个判定是否为词法索引调用
- **测试失败**：实跑 `npx vitest run tests/unit/data/global-search-conversations.test.ts`
- **预热上限**：读 `createRagLexicalCorpusCache` 的 `warm()` / `synchronize()` / `retain()` 三处实现
- **内存对比**：agent 用 12,323 文档 ID + 40,756 词项做独立对照
- **基准**：agent 用 `bench-rag-corpus.mjs` / `bench-rag-retrieval.mjs`，3 个独立进程取中位数
