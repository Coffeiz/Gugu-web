# PRD-KNOWLEDGE-2：knowledge 读取边界独立与 read_knowledge 工具

> 状态：全部待实施（方向已定稿：knowledge 域从 search_memory 中独立，精确读取走直读；未开始编码）
> 创建：2026-09-13
> 最近更新：2026-09-13
> 关联模块：`backend/agent/tools/memory.py`、`backend/agent/knowledge/store.py`、`backend/agent/rag/service.py`、`backend/agent/context/builder.py`、`backend/agent/knowledge/reflection.py`
> 背景参考：PRD-KNOWLEDGE-1（统一知识系统，已完成）；PRD-MEM-1（记忆召回工具与混合检索）

## 0. 实际状态

| 能力/结果 | 状态 | 说明 |
|---|---|---|
| knowledge 精确读取走索引（现状痛点） | 🟡 | `search_memory(source=knowledge)` 走 BM25 异步索引链，读己之写不一致：刚更新的知识立即搜可能拿到旧结果 |
| `read_knowledge` 直读工具 | 🔲 | 未实施 |
| `search_memory` 收窄为记忆专用 | 🔲 | 未实施（source 枚举仍含 knowledge） |
| knowledge 工具独立注册（脱离 MemorySkill） | 🔲 | save/update/delete_knowledge 仍在 `MemorySkill` |

## 1. 背景与目标

knowledge 的更新到 BM25 可查之间是异步链（RagIndexUpdated 事件 → `rag_index_jobs` 队列 → 投影推进 revision → 索引缓存失效/worker resync），读己之写没有一致性保证：咕咕同一轮里刚保存的知识立即搜索可能拿到旧结果。knowledge 本身是个人条目（几十到几百条量级），精确读取场景（列清单、按 id 取、看刚存的那条）根本不需要检索索引。

目标（边界定稿）：

- **knowledge 域独立**：新增 `read_knowledge` 工具直读 `KnowledgeStore`（写入即可读，强一致）；save/update/delete_knowledge 从 `MemorySkill` 拆出独立注册。
- **`search_memory` 收窄为记忆专用**：source 枚举移除 `knowledge`，只负责 profile/pattern/daily/memory；传 knowledge 返回人话错误并引导用 `read_knowledge`。
- **被动召回不动**：RAG 统一链的 knowledge 组、上下文自动注入、`agent.rag.service.search_memory`（反思链与内部调用方）保持原样——索引继续服务「模糊召回」场景，本 PRD 只切「精确读取」的边界。

明确不做：

- 不改 RAG 索引链、投影与 revision 机制（读己之写问题由绕开索引解决，不改异步链本身）。
- 不新增走索引的 `search_knowledge` 工具（模糊找知识由被动注入 + read_knowledge 列举覆盖；见待确认 1）。
- 不动 knowledge 的存储格式、scope 模型与向量缓存。

## 2. 功能需求

### FR-KN-1：read_knowledge 直读工具

- 新工具 `read_knowledge`（label：读取知识），直读 `KnowledgeStore`，不经过任何索引：
  - 传 `knowledge_id`：返回单条完整内容（含正文与元数据）；不存在或已停用返回人话提示。
  - 不传 `knowledge_id`：列举模式——返回该用户全部启用条目的清单（标题、摘要、scope、更新时间、id），支持可选 `scope` 过滤与可选 `keyword` 本地过滤（对标题+正文做包含匹配，大小写不敏感），默认上限 50 条、可配，超出提示缩小条件。
- 列举结果按更新时间倒序；输出体积受既有工具结果预算约束。
- 元数据：`source="builtin"`、`repeat_safe=True`（同参数只读、无副作用）、`mutates=False`、只读无需确认。

### FR-KN-2：search_memory 收窄为记忆专用

- `search_memory` 的 source 枚举收窄为 `all` / `profile` / `pattern` / `daily` / `memory`；`all` 语义变为「记忆相关全集」（不含 knowledge）。
- 入参 `source=knowledge` 不再执行检索，返回结构化错误并引导：「知识已独立，请用 read_knowledge 读取；模糊查找可稍后再试」——错误文案进入工具结果，模型可自行纠正。
- 工具 description 同步收窄：不再提及 knowledge。

### FR-KN-3：knowledge 工具独立注册

- `save_knowledge` / `update_knowledge` / `delete_knowledge` / `read_knowledge` 以独立 `KnowledgeSkill` 注册（新模块），从 `MemorySkill` 中移除；工具名与参数契约不变，模型侧无感。
- 记录 skill 分组变化：knowledge 相关工具的 `related_skills` 归属更新，capability 目录随之展示。

### FR-KN-4：提示词与内部调用同步

- 上下文被动注入知识块的引导文案（`context/builder.py` 的「需要全文时用 search_memory 检索」）改为引导 `read_knowledge`。
- 内部调用方不受影响：`agent.rag.service.search_memory(source=knowledge)`（反思链、memory_references）保留——工具层收窄只改 `agent/tools/` 的工具入参与枚举，service 层函数签名与语义不变。
- skills 技能文档、events 快照计数、capability 计数钉与实施提交同步落地（工具集变更的既有配套要求）。

## 3. 技术方案

### 3.1 核心决策

- **直读而非改索引**：读己之写不一致的根因是「写走异步索引链、读也走同一条」；knowledge 量级小，直读 `KnowledgeStore.get/list` 即天然强一致，不为精确读取去改造异步链。
- **分层切边界**：`agent/tools/` 层收窄工具枚举与注册；`agent/rag/service.py` 的 `search_memory` 函数保留 knowledge 能力供内部调用（反思链依赖它做候选召回）。工具语义与 service 函数语义从此解耦。
- **列举即兜底**：read_knowledge 无 query 参数、只做本地包含过滤——不引入第二套检索，模糊召回职责留在被动注入。

### 3.2 文件树

```text
backend/
├── agent/
│   ├── tools/
│   │   ├── knowledge.py                 【新增】KnowledgeSkill：read_knowledge + save/update/delete_knowledge 迁入
│   │   ├── memory.py                    【修改】移除 knowledge 工具与 search_memory 的 knowledge 枚举，错误引导
│   │   └── __init__.py                  【修改】注册 KnowledgeSkill
│   ├── knowledge/
│   │   └── store.py                     【不改】get/list 已满足直读需求
│   ├── context/
│   │   └── builder.py                   【修改】知识块引导文案改指 read_knowledge
│   └── rag/
│       └── service.py                   【不改】service.search_memory 保留 knowledge 供内部调用
├── tests/
│   ├── test_read_knowledge_tool.py      【新增】直读、过滤、上限、停用条目
│   └── test_search_memory_boundary.py   【新增】source=knowledge 拒绝并引导、记忆源不受影响
```

关键边界：

- `agent/knowledge/store.py`、投影与索引链**明确不改**。
- `agent/rag/service.py::search_memory` **不改签名**——反思链（`knowledge/reflection.py`）与 `memory_references` 继续用它做 knowledge 召回。
- 前端 `toolNames.ts` 的工具展示名按新工具补充 i18n。

### 3.3 数据与隐私边界

- read_knowledge 只读当前用户自己的 knowledge（`KnowledgeStore` 天然按 user 隔离）；无新表、无迁移。

## 4. 验证与上线

- 单测：`PYTHONPATH=. .venv/bin/pytest tests/test_read_knowledge_tool.py tests/test_search_memory_boundary.py`——覆盖：id 精确读、列举、scope/keyword 过滤、上限、停用条目不出现；`source=knowledge` 被拒且文案引导 read_knowledge；其余 source 行为不变；跨用户不可见。
- 计数钉：capability 工具计数钉与实施提交同行 +1（KN2-003 验收内含）。
- 回归：`tests/test_capability_registry.py`、knowledge 相关既有测试全绿；devserver 实测「保存知识 → read_knowledge 立即可见」与「search_memory 不再返回知识」两条路径。
- 回滚：纯工具层改动，revert 即回滚，无迁移。

## 5. 风险与待确认问题

| 风险 | 影响 | 对策 |
|---|---|---|
| 模型习惯迁移期仍对知识调 search_memory | 一次无效调用 | 拒绝文案明确引导 read_knowledge，模型下一轮自行纠正；description 收窄降低误用概率 |
| 模糊找知识失去工具入口（被动注入未命中时） | 找不到旧知识 | 列举模式 + keyword 过滤覆盖绝大多数量级；若实测不足再评估走索引的 search_knowledge（待确认 1） |
| 工具集变更漏配套（计数钉/技能文档/快照计数） | 测试红、文档漂移 | KN2-003 把配套列入同一条验收 |

待确认：

1. 是否需要保留走索引的模糊搜知识工具（`search_knowledge`）：本稿按不加，被动注入 + 列举覆盖；实测不够再加。
2. read_knowledge 列举默认上限 50 条是否合适。
3. `search_memory` 拒绝 knowledge 时是否顺带返回该用户 knowledge 条数（帮模型判断该不该转 read_knowledge）。

## 6. 唯一实施 TODO

### Phase 1：边界切换（一次交付）

- [ ] `KN2-001` 新增 `agent/tools/knowledge.py`：`read_knowledge`（id 精确读 + 列举/scope/keyword 过滤/上限）并将 save/update/delete_knowledge 迁入独立 `KnowledgeSkill` 注册；验收：`test_read_knowledge_tool.py` 全绿，工具名与参数契约不变，跨用户不可见。
- [ ] `KN2-002` `search_memory` 收窄：source 枚举移除 knowledge、description 同步、拒绝文案引导 read_knowledge；`context/builder.py` 引导文案改指 read_knowledge；验收：`test_search_memory_boundary.py` 全绿，其余 source 行为与被动注入不受影响。
- [ ] `KN2-003` 配套同步：capability 计数钉 +1、skills 技能文档中 knowledge 检索描述更新、events 快照计数、i18n `toolNames.ts`；验收：capability 全量测试绿（计数钉与本提交同行），技能文档无残留的「search_memory 搜知识」表述。
- [ ] `KN2-004` devserver 实测两条路径：「保存知识 → read_knowledge 立即可见」「search_memory(source=knowledge) 返回引导文案」；验收：5173 实测通过，结论记录 devlog。
