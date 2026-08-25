# PRD-RAG-5：文件、画布与对话统一召回

> 状态：规划中
> 创建：2026-08-25
> 所属层：Agent / Knowledge RAG / Source Adapter
> 关联文档：`docs/agent/RAG架构与检索链路.md`、`PRD-RAG-1-统一知识召回与索引.md`

## 1. 背景

当前统一 Knowledge RAG 已接入 Memory 和 Project 两类 Retriever。文件、画布和历史对话虽然已经具备部分索引构建基础，但运行时仍主要依赖专用工具：

- 文件通过文件搜索和读取工具访问。
- 画布通过 `mind_search_canvas`、`mind_get_canvas` 等工具访问。
- 历史对话通过 `search_conversations`、`read_conversation` 访问。

这保证了精确查询和权限边界，但无法在用户自然提问时自动补充相关内容。本 PRD 将三类来源接入统一 RAG，同时保留专用工具作为精确读取和写入入口。

## 2. 目标与非目标

### 2.1 目标

1. 文件、画布、对话统一转换为 `IndexDocument`。
2. 复用现有 Scope、Rust BM25、Python fallback、缓存、置信度和诊断链路。
3. 每类来源保留自己的归属校验和业务权限适配器。
4. 自动召回结果带有可追溯的来源引用。
5. 内容更新后可以增量失效和重建，不依赖每次查询全量扫描。
6. 召回失败不阻塞主 Agent，专用工具仍可正常使用。

### 2.2 非目标

- RAG 不直接执行文件、画布或对话工具。
- RAG 不绕过 owner、workspace、project、canvas、group 和成员权限。
- RAG 不把二进制文件、图片原文或全部聊天记录直接注入上下文。
- RAG 不替代 `read_file`、`mind_get_canvas`、`read_conversation` 等精确工具。
- 本阶段不做新的 Embedding 模型，不复制 BM25 实现。

## 3. 总体架构

```text
文件 / 画布 / 对话业务数据
          ↓
FileAdapter / CanvasAdapter / ConversationAdapter
          ↓
IndexDocument + Scope + version + content_hash
          ↓
knowledge_index_entries
          ↓
scope-first 业务权限过滤
          ↓
KnowledgeIndexCache
          ↓
Rust BM25（默认）/ Python BM25 fallback
          ↓
UnifiedRecallService
  ├─ 置信度
  ├─ 正文去重
  ├─ parent/source 限制
  ├─ 多样性
  └─ 3000 字符预算
          ↓
history 自动召回 / 显式搜索结果
```

三类来源共用检索基础设施，但不共用业务权限判断：

| 层 | 共用内容 | 来源独立内容 |
|---|---|---|
| 文档契约 | `IndexDocument`、`Scope`、version、hash | 文本抽取和 metadata |
| 索引 | 持久化表、Rust/Python lexical index | source type、更新事件 |
| 过滤 | scope-first、confidence、预算、去重 | 文件/画布/对话归属校验 |
| 输出 | 统一 public result、citation | 文件路径、节点位置、会话时间 |

## 4. 来源设计

### 4.1 文件来源

#### 索引内容

- 文件名和扩展名。
- 文件夹路径和项目路径。
- 文件类型、大小和更新时间。
- 可抽取正文的文件内容。
- Markdown、纯文本、代码、PDF 等格式的抽取摘要。
- 图片使用 OCR、标题和已有描述；不把原始二进制直接写入索引正文。

#### 文档结构

```text
source_type: file
source_id: file_id
title: 文件名
summary: 类型 + 路径 + 摘要
content: 抽取后的文本 chunk
metadata:
  folder_id
  project_id
  mime_type
  relative_path
```

#### 权限边界

- 文件必须属于当前用户。
- workspace/project/folder scope 必须与当前请求匹配。
- 回收站文件默认不进入自动召回。
- 删除或移动文件时同步失效旧文档。
- 召回只返回文件引用；读取正文仍由文件工具完成。

#### 结果形式

返回文件名、文件类型、路径、命中片段和 `file_id`。不返回内部存储路径、用户目录 UUID 或未授权文件信息。

### 4.2 画布来源

#### 索引内容

- 画布名称和描述。
- 便签标题、正文和节点类型。
- 分组名称和层级路径。
- 节点的 `node_id`、`canvas_id` 和更新时间。
- 连接关系摘要，例如“节点 A 连接到节点 B”。
- 节点位置作为 metadata，不作为主要全文内容。

#### 文档结构

```text
source_type: canvas
source_id: canvas_id 或 node_id
title: 便签标题 / 画布名称
summary: 节点类型 + 分组路径
content: 便签正文或画布摘要
metadata:
  canvas_id
  node_id
  node_type
  group_path
  x
  y
  relation_ids
```

#### 权限边界

- 画布必须属于当前用户或当前允许的共享 scope。
- 群聊场景叠加 group/member scope，不因用户拥有某个画布 ID 就扩大读取范围。
- 已删除节点、隐藏节点和无效关系不得继续被召回。
- RAG 不能自行解释或修改画布关系。

#### 结果形式

返回画布名、节点标题、正文片段、节点类型、分组路径和 `canvas_id/node_id` 引用。用户需要移动、连接、修改时，仍由画布工具完成确认和写入。

### 4.3 对话来源

#### 索引内容

优先使用低敏感、稳定的可检索材料：

- 会话标题和摘要。
- 压缩后的 session summary。
- 用户消息与助手回复的短片段。
- 工具结果的结构化摘要，不默认保存完整原始回执。
- 时间、平台和会话标识作为 metadata。

不默认把所有历史消息全文放入自动召回索引；完整读取仍由 `read_conversation` 完成。

#### 文档结构

```text
source_type: conversation
source_id: session_id
title: 会话标题或生成摘要
summary: 时间 + 平台 + 会话摘要
content: 摘要或切片消息
metadata:
  session_id
  platform
  bot_id
  chat_id
  message_start
  message_end
```

#### 权限边界

- Web 只允许查询当前用户自己的会话。
- 私聊按 owner scope 查询。
- 群聊按 group scope 查询；成员记忆按 member scope 查询。
- 不因消息中出现其他用户名称而扩大可见范围。
- 会话删除、隐藏或权限变化时立即失效对应索引。

#### 结果形式

返回会话标题、时间、平台、摘要或短片段和 `session_id`。需要完整上下文时调用 `read_conversation`，不把 RAG 片段当作完整会话事实。

## 5. 统一过滤与排序

所有来源都必须执行以下顺序：

1. 生成已完成身份校验的 Scope。
2. 来源 Adapter 做归属和业务权限过滤。
3. Retriever 做 source type 过滤。
4. Rust BM25 或 Python fallback 召回候选。
5. 统一 scope 二次校验，防止新 Adapter 漏过滤。
6. 置信度过滤：硬下限 0.35，优先阈值 0.55。
7. 正文 hash 去重。
8. parent 最多 3 个 chunk、单来源最多 3 条。
9. token Jaccard 相似度达到 0.85 时抑制重复候选。
10. 最终输出最多 10 条，正文总预算 3000 字符。

来源优先级沿用统一服务：

```text
memory 0
project 10
file 20
journal 30
canvas 40
conversation 50
```

来源优先级只作为稳定同分排序依据，不得覆盖 confidence 和权限结果。

## 6. 更新与索引生命周期

### 6.1 增量更新

下列事件应触发来源级 upsert/invalidate：

| 来源 | 更新事件 |
|---|---|
| 文件 | 创建、上传、编辑、重命名、移动、删除、恢复、正文抽取完成 |
| 画布 | 创建/修改便签、移动节点、删除节点、修改关系、修改分组 |
| 对话 | 新消息完成、summary 更新、会话删除、会话权限变化 |

更新事件只负责让索引最终一致；查询时仍必须执行实时 scope 过滤。

### 6.2 失败与重建

- 索引更新失败记录受限诊断并有限重试。
- 查询发现 revision 不一致时重建对应 owner/source index。
- Rust sidecar 失败只退回 Python BM25，不改变业务结果权限。
- 文本抽取失败时保留标题和 metadata，但不伪造正文命中。
- 召回超时只跳过当前来源，不阻塞其他来源和主 Agent。

## 7. 自动召回与显式工具

### 自动召回

自动召回只注入低成本、已过滤的摘要/片段：

- 每个 scope 最多等待 3 秒。
- 共享统一 3000 字符预算。
- 使用 content hash 避免与已有 history/snapshot 重复。
- 进入稳定 conversation/history 边界，不写入不稳定的动态提示区域。
- 失败不阻塞主流程。

### 显式工具

以下场景仍应优先使用专用工具：

- 用户要求完整文件正文、下载或移动文件。
- 用户要求读取完整画布、修改节点或连接关系。
- 用户要求完整历史对话或精确时间段。

RAG 负责“找到可能相关的来源”，专用工具负责“读取完整内容或执行动作”。

## 8. 实施阶段

### Phase 1：文件来源

- 新增 `FileAdapter` 和文件文本抽取边界。
- 接入 file scope、项目/folder scope 和回收站过滤。
- 建立文件更新事件和来源级索引回归。
- 验证自动召回不暴露内部路径和未授权文件。

### Phase 2：画布来源

- 新增 `CanvasAdapter`。
- 索引画布、便签、节点类型、分组和关系摘要。
- 接入 canvas ownership、共享 scope 和删除失效。
- 验证召回不会直接执行画布写操作。

### Phase 3：对话来源

- 新增 `ConversationAdapter`。
- 优先索引 summary 和稳定消息切片。
- 接入 owner/group/member scope。
- 验证删除、压缩和权限变化后的索引失效。

### Phase 4：统一自动召回与评估

- 为三类来源增加独立 LoopScope source diagnostics。
- 进行 shadow mode，暂不改变专用工具行为。
- 评估命中率、误召回率、平均延迟、P95 延迟和上下文成本。
- 通过后再按来源打开自动召回开关。

## 9. 验收标准

### 正确性

- 文件、画布、对话均能转换成合法 `IndexDocument`。
- 同一正文重复来源只占一份上下文预算。
- 更新、删除和权限变化能使旧索引失效。

### 安全

- 任意来源都不能越过 owner/group/member scope。
- RAG 结果不包含内部路径、密钥、完整二进制或未授权正文。
- RAG 不能直接调用写工具，也不能绕过确认门。

### 性能

- Rust lexical 为默认后端，Python 仅作为可验证 fallback。
- 索引缓存沿用 30 分钟 TTL、单 owner 32 MiB、全局 512 MiB。
- 自动召回单 scope 等待不超过 3 秒。
- 召回结果总正文不超过 3000 字符。

### 可观测性

LoopScope 至少能区分：

- source type、scope type、candidate/hit/accepted 数量。
- engine、cache hit、cache miss reason、耗时。
- confidence、重复、parent、来源和多样性拒绝数量。
- 是否实际注入上下文。

## 10. 代码与测试规划

预计新增或修改：

```text
backend/agent/rag/adapters/files.py
backend/agent/rag/adapters/canvas.py
backend/agent/rag/adapters/conversations.py
backend/agent/rag/index_builder.py
backend/agent/rag/service.py
backend/agent/rag/injection.py
backend/agent/rag/diagnostics.py
backend/tests/test_rag_files.py
backend/tests/test_rag_canvas.py
backend/tests/test_rag_conversations.py
```

测试必须覆盖：

- source adapter 文档结构和版本稳定性。
- owner/group/member scope 越权回归。
- Rust/Python 后端结果契约一致。
- 增量更新、删除和缓存失效。
- 正文去重、parent/source 限制和 3000 字符预算。
- 自动召回超时不阻塞主 Agent。
- 专用工具仍能读取完整来源并执行确认门。
