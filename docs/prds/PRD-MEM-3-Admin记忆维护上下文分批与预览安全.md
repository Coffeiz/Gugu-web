# Admin 记忆维护上下文分批与预览安全

> 状态：🟡 Phase 0～3 已完成，Phase 4 待实施
> 创建：2026-09-02
> 负责人：Agent 记忆领域
> 关联文档：[`【已完成】PRD-MEM-2-事件型长期记忆与压缩去重.md`](./【已完成】PRD-MEM-2-事件型长期记忆与压缩去重.md)、[`【已完成】PRD-IM-11-群成员长期记忆.md`](./【已完成】PRD-IM-11-群成员长期记忆.md)、[`PRD-AGENT-5-ContextBranch反思与压缩统一架构.md`](./【已完成】PRD-AGENT-5-ContextBranch反思与压缩统一架构.md)
> 目标：让 Admin 的普通记忆维护预览、IM 群组维护预览和 IM 成员维护预览都经过统一的上下文预算与分批流程，避免单个用户、群组或成员的历史数据全量进入模型导致上下文溢出、输出截断或维护计划不完整。

## 1. 背景与问题

Admin 页面当前有两类记忆维护入口：

1. **普通记忆维护**：对所有用户执行 pattern 复核、profile 拆分、profile 事件迁移、daily 格式迁移和遗留文件检查。
2. **IM 记忆维护**：统计 IM scope，并对群组和成员 scope 生成模型预览，确认后批量应用。

两类入口都实现了“按用户”或“按 scope”调度，但没有实现“按上下文预算切批”：

- 普通维护会把一个用户的完整 `pattern.json` 一次传给复核模型；复核和 profile 拆分还会对同一份列表重复调用多次。
- IM 模型预览会把一个 scope 的完整记忆 JSON 和消息范围内的全部消息拼接后一次传给模型。
- `max_tokens` 只限制模型输出，不限制输入上下文。
- 普通对话和 RAG 已有字符预算、RAG chunk 和召回上限，但 Admin 维护预览没有复用这些边界。
- 如果预览完成后源数据发生变化，现有计划缺少统一的版本校验，可能把旧预览结果应用到新数据上。

本 PRD 只解决 **Admin 记忆维护的输入预算、分批、合并和预览一致性**。不改变记忆类型定义、scope 权限、RAG 召回权限或普通对话的上下文策略。

## 2. 目标与非目标

### 2.1 目标

- 所有维护模型调用都有明确的输入 token 预算和输出 token 预算。
- 单条 profile、pattern 或消息不得被无提示地截断；超长单条内容按独立超长项处理并记录状态。
- 普通记忆维护按稳定条目 ID 分批，不再依赖全量数组下标。
- IM 群组和成员维护按消息边界分批，保留消息时间、平台用户 ID 和必要的主体信息。
- 分批结果可以安全合并为一次预览计划，确认应用时只应用预览对应的源版本。
- Admin 页面展示批次进度、失败批次、截断批次和待应用操作数量。
- 维护失败时保留旧记忆，不因单批失败覆盖或清空已有数据。

### 2.2 非目标

- 不把所有长期记忆全量改造成 RAG。
- 不改变 owner、group、platform-user 的权限边界。
- 不把群组记忆和成员记忆合并成一个 scope。
- 不修改普通对话中的历史消息窗口和 `ContextBudget` 触发规则。
- 不允许 Admin 预览绕过现有的确认门、删除保护和归属校验。

## 3. 当前实现基线

| 入口 | 当前行为 | 当前缺口 |
|---|---|---|
| `/api/v1/admin/config/memory-cleanup/preview` | 按用户后台执行 preview，结果存 Redis | 单用户 pattern 不切批；没有 token 输入预算；计划没有统一源版本 |
| `_review_patterns()` | 完整 pattern 列表调用 3 次复核 | 以数组下标作为模型输入引用，列表过大时容易超限或输出截断 |
| `_split_profile()` | 完整 pattern 列表调用 3 次分类 | 与复核重复发送同一大列表，未复用切批结果 |
| `/api/v1/admin/agent/memory/im-scopes/maintenance/preview` | 返回 scope 统计 | 这是统计预览，不调用模型，不承担内容预算 |
| `.../maintenance/model-preview` | 按 scope 逐个调用模型 | scope 内完整 memory JSON + 消息 payload 未切批 |
| `.../maintenance/apply` | 应用 Redis 中的模型计划 | 缺少源数据版本冲突检查 |
| 普通 RAG/上下文注入 | 已有 chunk、召回和字符限制 | 维护预览没有复用，不能直接视为维护安全边界 |

## 4. 统一维护上下文模型

新增维护领域内部抽象 `MaintenanceBatch` 和 `MaintenanceContextBudget`。它们只服务于维护模型调用，不进入用户可见 API。

### 4.1 批次结构

```python
MaintenanceBatch(
    batch_id: str,
    scope_key: str,
    task_type: str,
    source_ids: list[str],
    content: str,
    estimated_input_tokens: int,
    has_oversized_item: bool,
    source_revision: str,
)
```

要求：

- `source_ids` 使用稳定的 pattern ID、message ID 或事件 ID，不使用批次内数组下标作为持久计划引用。
- `scope_key` 只能在后端内部使用，不能返回给 Admin 前端的汇总响应或可见日志。
- `source_revision` 必须由数据源内容计算，不能只使用任务创建时间。
- `content` 只包含该批次允许进入模型的内容，不允许切批器自行读取越权 scope。

### 4.2 默认预算

预算必须集中配置，不在普通维护、IM 维护和 Admin worker 中各写一套常量。初始建议值如下，实施时根据实际模型上下文能力配置化：

| 项目 | 默认值 | 说明 |
|---|---:|---|
| 维护输入总预算 | 8000 tokens | system prompt、已有记忆和新增数据合计 |
| 已有记忆预算 | 2500 tokens | 当前 scope 的 summary/profile/pattern/memory 摘要 |
| 新增数据预算 | 4500 tokens | pattern 条目或 IM 消息 |
| 维护输出预算 | 2500 tokens | 由 `BranchPolicy.max_tokens` 控制 |
| 单条超长项预算 | 3500 tokens | 超过后单独处理或安全截断，并标记 `truncated` |

实际切分必须优先使用项目已有 tokenizer/模型配置；没有 tokenizer 时才允许使用保守的字符估算，并在批次元数据中标明 `estimated`。

## 5. 普通记忆维护设计

### 5.1 pattern 复核

```text
读取 pattern.json
  ↓
按稳定 pattern.id 和输入预算切批
  ↓
每批执行 review 投票
  ↓
按 ID 合并 remove/merge 建议
  ↓
跨批候选去重和冲突复核
  ↓
生成一次性 preview plan
```

规则：

- 每批必须包含完整 pattern 条目，不能从中间截断 `text`。
- 每批只允许删除或合并本批 `source_ids`。
- 高置信条目继续由代码保护，不因分批而降低保护等级。
- 跨批合并先使用确定性相似度/哈希聚类；只有候选确实跨批冲突时，才调用小范围 consolidation。
- 3 次投票保持在批次级别。失败批次不能被当作“没有变化”。
- 任一批次解析失败时，预览整体标记为 `needs_review`，默认不可直接 apply。

### 5.2 profile 拆分

- 复用 pattern 切批结果，不重新把完整 pattern 列表发送给模型。
- 每批只输出本批 `source_ids` 中需要搬迁的 ID。
- 代码侧根据 ID 重新读取当前 pattern，生成 `profile_add` 和 `pattern_remove`。
- 如果同一条 pattern 同时出现在复核删除和 profile 搬迁结果中，按安全优先级保留原条目并标记冲突，不自动删除。

### 5.3 确定性迁移

profile 事件迁移、daily 格式迁移和遗留文件检查不需要进入模型切批流程，但仍必须：

- 记录每个用户的源 revision；
- 把变更纳入同一份 preview plan；
- apply 前重新确认源文件仍匹配预览时的 revision；
- 发生冲突时跳过该用户并要求重新生成预览。

## 6. IM 群组与成员维护设计

### 6.1 群组反思

群组维护只接收群级允许的数据：

- 当前群已有的 `summary/profile/memory` 摘要；
- 本批群消息；
- 消息时间、稳定平台用户 ID 和必要的显示名元数据。

切批规则：

- 以完整消息为边界切分，不在消息正文中间截断；
- 默认每批最多 30～50 条消息，同时受 token 预算约束；
- 一条超长消息单独成为超长批次，超过单条预算时只保留安全截断文本，并标记不可直接自动应用；
- 每批输出群级增量，代码侧按事件 ID、标题和内容哈希合并；
- 不把完整 `members.json` 作为群反思 prompt 输入，成员名单聚合继续由代码负责。

### 6.2 成员批量反思

成员批量反思仍允许一次模型输出多个成员，但输入按消息批次切分，输出必须满足：

- `platform_user_id` 必须出现在该批消息中；
- 只能写入本批明确归属的成员；
- 每个成员在同一批最多产生一份增量结果；
- 成员 `profile/pattern/summary/memory` 在代码侧分别合并；
- 某一成员落库失败不影响同批其他成员，但该成员计划标记失败并禁止静默丢失。

如果一个成员跨多个批次出现，先按批次生成增量，再由代码侧合并。只有同一字段产生冲突时，才进行小范围最终整理，不把整个群的所有消息重新送回模型。

### 6.3 IM Admin 模型预览

Admin 的 `model-preview` 必须复用普通反思的批次选择和权限逻辑：

- `maintenance/preview` 继续只返回匿名统计，不返回 scope 标识和正文；
- `model-preview` 按 scope 和批次执行，保存批次汇总状态；
- Redis 计划只保存必要的内部计划数据和 revision，不把原始消息或记忆正文返回前端；
- 任何失败、超长、版本冲突都必须显示在汇总状态中；
- 只有全部必需批次成功，且 plan revision 仍有效时才允许 apply。

## 7. 预览计划与并发一致性

预览计划至少包含：

```json
{
  "plan_version": "...",
  "source_revision": "...",
  "batch_count": 8,
  "completed_batches": 8,
  "failed_batches": 0,
  "truncated_batches": 0,
  "operations": 12,
  "requires_review": false
}
```

要求：

1. preview 结束后 apply 前，重新计算 scope/source revision。
2. revision 不一致时拒绝 apply，提示重新生成预览。
3. apply 使用稳定 ID 和确定性操作，不重新调用模型。
4. 删除、搬迁和覆盖操作继续使用现有确认门和保护规则。
5. Redis 计划设置 TTL；过期后只能重新生成，不能继续应用旧计划。
6. 计划状态只记录计数、类型、ID 哈希和错误类型，不记录用户正文、原始消息、token、密钥或 scope 可识别信息。

## 8. Admin 页面交互

普通记忆维护和 IM 记忆维护都显示：

- 总 scope/用户数；
- 已完成批次 / 总批次；
- 正在处理的 scope 数；
- 失败批次；
- 超长或截断批次；
- 待应用操作数；
- 是否存在 revision 冲突；
- 只有 `done && !requires_review && revision_valid` 时启用应用按钮。

前端不展示用户正文、群号、成员 ID 或内部 scope key。详细错误只显示脱敏后的错误类型和重试建议，原始异常进入诊断日志。

## 9. 安全与权限

- 切批器必须在已经完成 scope 权限解析后运行，不能通过批次合并扩大可见范围。
- group prompt 不得包含 owner 私人记忆或其他群的成员记忆。
- member prompt 只允许当前平台、当前 Bot、当前成员范围内的数据。
- Admin preview 不能绕过 apply 确认门，也不能把 preview 结果当作已执行。
- 不在日志和前端响应中记录原始消息、pattern 文本、scope ID、用户 ID 或模型 token 内容。
- 任何 batch 失败都必须可重试、可追踪，不能用“空结果”覆盖已有记忆。

## 10. 文件树与修改范围

```text
docs/prds/
└── PRD-MEM-3-Admin记忆维护上下文分批与预览安全.md   # 本 PRD

backend/agent/memory/
├── maintenance_batches.py                           # 新建：统一预算、估算和切批
├── maintenance_plan.py                              # 新建：revision、计划合并和 apply 校验
├── im_reflection.py                                  # 修改：复用 IM 消息切批和增量合并
├── reflection_jobs.py                                # 修改：暴露稳定消息范围和批次元数据
└── store.py                                          # 修改：提供稳定 memory/profile/pattern revision

backend/scripts/refresh_memory.py                    # 修改：普通 pattern 维护接入 batcher
backend/app/api/v1/config.py                         # 修改：普通维护 preview/apply 使用批次计划
backend/app/api/v1/agent_admin.py                   # 修改：IM model-preview 使用批次计划和状态

frontend/src/views/Admin/Agent/memory/
├── useMemoryMaintenance.ts                           # 修改：展示普通维护批次状态
├── useImMemoryMaintenance.ts                         # 修改：展示 IM 批次状态
└── components/                                       # 修改：补充批次、失败和 revision 状态

backend/tests/
├── test_memory_maintenance_batches.py                # 新建：普通记忆切批与合并
├── test_im_memory_maintenance_batches.py             # 新建：群组/成员消息切批
└── test_memory_maintenance_plan.py                   # 新建：revision、失败和 apply 安全
```

不修改用户运行配置、数据库结构或记忆 scope 命名；如实现阶段确认需要持久化批次状态，必须另行补充迁移设计，不把 Redis 计划直接迁成数据库字段。

## 11. 实施阶段

### Phase 0：基线与契约

- [x] 固定普通维护、IM 维护和 RAG 注入的边界，不混用权限和数据源。
- [x] 定义 `MaintenanceBatch`、`MaintenanceContextBudget`、`source_revision` 和错误状态。
- [x] 补充大 pattern、大 scope、大消息的合成测试夹具。

### Phase 1：统一切批器

- [x] 新建统一维护切批模块，当前使用保守字符估算，后续可替换为模型 tokenizer。
- [x] 实现完整条目边界、超长项标记和批次计数；IM 完整消息边界留在 Phase 2。
- [x] 普通 pattern review、profile split 接入同一批次结果。
- [x] 增加输入预算、无静默截断和批次数量回归测试。

### Phase 2：IM 群组与成员预览

- [x] Admin 群组和 member scope 预览按完整消息边界切批。
- [x] 保持成员主体校验、scope 隔离和成员级失败隔离；失败/超长 scope 不进入可执行计划。
- [x] Admin model-preview 使用受限已有记忆视图、批次输出合并和批次状态。
- [x] 增加跨批 pattern 稳定 ID、超长条目和批次预算回归测试；IM 多成员专项真实数据测试留在 Phase 4。

### Phase 3：计划一致性与前端状态

- [x] 普通记忆和 IM 预览生成并校验 source revision。
- [x] apply 拒绝过期、失败或超长计划，并在 IM apply 前完成全量预校验。
- [x] Admin 展示普通记忆与 IM 的批次进度、失败和超长状态。
- [x] preview 与 apply 使用同一份稳定 ID/版本计划；跨批 IM 输出在后端合并。

### Phase 4：真实环境验收

- [ ] 使用合成大数据在本地运行完整 preview/apply。
- [ ] 在 devserver 使用脱敏测试 scope 验证真实模型上下文不溢出。
- [ ] 验证普通用户、IM 群组、IM 成员记忆未发生越权或相互污染。
- [ ] 更新 `docs/agent/07-MEMORY-AND-REFLECTION.md` 和英文文档。

## 12. 验收标准

### 上下文预算

- [ ] 任一维护模型调用都能记录 input budget、estimated tokens、batch ID 和是否超长；日志只记录哈希和计数。
- [ ] 正常批次不超过配置的输入 token 预算。
- [ ] 单条超长数据不会与其他数据拼接后静默突破预算。
- [ ] 模型输入不会包含完整未切分的 pattern 列表、完整 scope JSON 或无上限消息 payload。

### 普通记忆维护

- [ ] 300 条 pattern 可以拆成多个批次完成预览，不依赖数组下标跨批引用。
- [ ] review 与 profile split 不重复发送完整列表。
- [ ] 某批失败时不会生成可直接执行的完整计划。
- [ ] preview 和 apply 的稳定 ID 集合一致。

### IM 群组与成员维护

- [ ] 群消息按消息边界切批，成员 ID 只能来自当前批消息。
- [ ] 成员跨批出现时，增量结果能够正确合并，不覆盖其他成员。
- [ ] 群记忆不会写入成员个人事实，成员记忆不会写入群级事实。
- [ ] 单批或单成员失败不会清空已有记忆，也不会阻塞无关成员。

### 一致性与安全

- [ ] 预览后源数据变化时 apply 被拒绝。
- [ ] apply 不重新调用模型，实际操作与预览计划一致。
- [ ] Admin 前端不显示正文、用户 ID、群 ID、成员 ID 或内部 scope key。
- [ ] 普通记忆、群组记忆、成员记忆的权限回归测试全部通过。

## 13. 唯一执行 TODO

- [ ] **完成 Phase 0～4：实现统一维护上下文切批、接入普通记忆与 IM 群组/成员两个 Admin 模型预览，补齐 revision/apply 安全校验、前端状态、自动化测试和 devserver 验收；全部验收通过后将本 PRD 标记为【已完成】。**
