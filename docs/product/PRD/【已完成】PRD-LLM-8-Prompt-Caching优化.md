# Prompt Caching 优化 PRD

> 状态：🚧 Phase 2 实施中（上下文压缩策略）
> 创建：2026-08-19
> 最近更新：2026-08-21
> 所属层：LLM / Prompt 缓存
> 关联模块：`backend/agent/context/builder.py`、`backend/agent/runner.py`、`backend/agent/loop_drivers.py`
> 关联文档：[[../../reports/INVEST-Cross-Call-Prompt-Caching.md]]、[[../../reports/OPT-Cache-Strategy-Aggressive.md]]

---

## 1. 背景与目标

### 背景

当前咕咕的 LLM 调用存在 prompt 缓存率低的问题：
- MiniMax 全天缓存率：72.2%
- Qwen-paw 历史缓存率：98.7%
- **差距：26.5%**，每天约 130 万 tokens 的浪费

通过对比分析发现：
1. dsh（DeepSeek Harness）在 MiniMax 上实现 50% 跨 call 缓存率
2. dsh 的 system prompt **完全静态**（不含时间/记忆/项目等动态内容）
3. 我们的 system prompt 包含动态内容，导致跨 call 时前缀变化，缓存无法命中

### 目标

1. **第一轮**（本次）：将动态内容从 system 移到 messages，实现跨 call 缓存
2. **第二轮**：实现内容变化检测和增量缓存
3. **第三轮**：多段缓存断点优化

### 预期效果

- system prefix 跨 call 完全一致
- MiniMax 跨 call 缓存命中率：0% → 90%+
- 全天缓存率：72.2% → 95%+
- API 成本降低约 30%

---

## 2. 现状分析

### 2.1 System Prompt 当前结构

```
system = {
  static: 人格 + 政策 + 工具定义 + 风格偏好
  dynamic: 记忆 + 项目状态 + 文件概览 + 当前时间
}
```

### 2.2 缓存机制

MiniMax 缓存策略：
- **前缀精确匹配**（tools → system → messages）
- 任何内容变化都会导致整个缓存失效
- 支持 `cache_control: {type: "ephemeral"}` 标记缓存断点
- 最多支持 4 个缓存断点

### 2.3 问题根因

每次 LLM 调用时，system prompt 中的动态内容（时间、记忆、项目状态）都会变化，导致：
- system prefix 在 call 之间不一致
- MiniMax 无法匹配缓存前缀
- 每次都需要重新计算整个 system prompt

---

## 3. 方案设计

### 3.0 当前验证结果（2026-08-21）

OpenAI 兼容路径已接入 conversation 末尾缓存断点。实测结果：

- Qwen 连续三轮测试中，后两轮缓存命中率达到 98%+；
- Kimi 多数轮次达到 94%+，偶发轮次会暂时落到约 52%，随后恢复到 84%+ / 94%+；
- 偶发低命中轮的消息顺序、时间格式和动态尾部结构均未发现业务侧异常。

当前判断：Qwen 的优化已达到预期；Kimi 的偶发低命中更像服务端缓存分块预热或缓存块续接行为，不再继续扩大业务侧改动。

### 3.0.1 可选后续：Session baseline 与 conversation 分段缓存

这是观察项，不作为当前合并前置条件。

目标是将缓存边界进一步拆成两段：

```text
system + session baseline [cache boundary A]
history + current message [cache boundary B]
dynamic stance + summary + time
```

预期收益：

- baseline 不随历史消息增长而重新计算；
- conversation 增长时只追加新的历史前缀；
- 动态尾部变化不影响前两段缓存。

实施前置条件：

1. 分别确认 Qwen、Kimi、MiniMax 对多个 `cache_control` 断点的支持和计费口径；
2. 在 LoopScope 中记录每个断点的命中范围，不能只看总 `cache_read`；
3. 增加“历史消息增长 + 动态尾部变化”的连续多轮回归测试；
4. 若服务端只保留最后一个有效断点，则维持当前单 conversation 断点方案，不做多断点改造。

### 3.1 第一轮：静态/动态内容分离

#### 目标
将 system prompt 分为两部分：
- **静态部分**：完全不变的内容（人格/政策/工具定义）
- **动态部分**：可能变化的内容（记忆/项目/文件/时间）

#### 架构变更

**当前架构**：
```python
# builder.py
system_text = static + CACHE_BREAK + dynamic
# runner.py
messages = [system_message, ...]
```

**优化后架构**：
```python
# builder.py
system_text = static  # 只有完全静态的内容

# runner.py
messages = [
    {"role": "system", "content": static_text},  # 静态 system
    {"role": "user", "content": dynamic_context},  # 动态上下文注入
    ...历史消息...
    {"role": "user", "content": current_message},  # 用户当前消息
]
```

#### 动态内容范围

| 内容 | 变化频率 | 处理方式 |
|------|---------|---------|
| 人格/政策 | 不变 | system prompt |
| 工具定义 | 不变 | system prompt |
| 风格偏好 | 不变 | system prompt |
| 记忆摘要 | 偶发（天级） | messages[0] |
| 项目概览 | 偶发（天级） | messages[0] |
| 文件概览 | 偶发（天级） | messages[0] |
| 当前时间 | 每分钟 | messages[0] |
| IM 频道状态 | 每轮 | messages[0] |

#### 缓存策略

```python
# system 块加 cache_control（稳定前缀）
system = [{"type": "text", "text": static_text, "cache_control": {"type": "ephemeral"}}]

# messages[0] 不加 cache_control（动态内容，每次变化）
# 最后一条用户消息加 cache_control（完整对话历史）
```

#### 预期效果

- system prefix 跨 call 完全一致
- 第一轮：cache_write（创建缓存）
- 第二轮起：cache_read（命中缓存）
- 缓存命中率：0% → 90%+

### 3.2 影响范围

#### 需要修改的文件

1. **`backend/agent/context/builder.py`**
   - `build()` 函数：拆分为 `build_static_system()` 和 `build_dynamic_context()`
   - 移除动态内容到独立函数

2. **`backend/agent/runner.py`**
   - `run_stream()` 函数：构建 messages 时，第一条是动态上下文
   - 修改消息构建逻辑

3. **`backend/agent/loop_drivers.py`**
   - `AnthropicDriver.prepare()`：system 只传静态内容
   - `OpenAIDriver.prepare()`：同上

4. **`backend/agent/core.py`**
   - `_run_loop()`：可能需要调整消息处理逻辑

#### 兼容性考虑

- **向后兼容**：新的 messages 格式应该对 LLM 透明
- **工具调用**：工具结果仍然在 messages 中，不受影响
- **多轮对话**：历史消息累积方式不变
- **记忆更新**：对话过程中记忆更新，messages[0] 会重新构建

### 3.3 测试验证

#### 测试用例

1. **基本功能测试**
   - 创建画布、删除画布等核心功能正常
   - 记忆、项目状态等动态内容正确注入

2. **缓存命中测试**
   - 跨 call 缓存命中率 > 90%
   - Loopscope 正确显示缓存数据

3. **内容准确性测试**
   - 记忆更新后，下一轮对话能看到最新内容
   - 项目状态变化后，下一轮对话能反映

4. **性能测试**
   - 响应时间是否提升（缓存命中后应该更快）
   - 内存占用是否合理

---

## 4. 实施计划

### Phase 1：静态/动态分离（本次）

**时间**：1-2 天
**范围**：
- 修改 `builder.py`：拆分 `build()` 为 `build_static_system()` 和 `build_dynamic_context()`
- 修改 `runner.py`：调整消息构建逻辑
- 修改 `loop_drivers.py`：适配新的 system/messages 结构
- 测试验证

**交付物**：
- 代码修改
- 测试报告
- 缓存率对比数据

### Phase 2：上下文压缩策略

**时间**：2-3 天
**目标**：实现 run 内上下文压缩，防止上下文超限，同时保持跨 call 缓存前缀一致

**触发条件**：
```
当前上下文长度 > 用户设置的最大上下文长度 × 90%
```

**压缩目标**：
```
压缩结果不超过模型上下文预算的 50%，没有固定下限（现由 PRD-AGENT-4 的 ContextBudget 统一控制）。
```

**保护范围**：
- system 提示词：完全保留（不压缩）
- 消息历史：按策略压缩

**前缀一致性保证**：
```python
# 压缩后 messages 的结构
messages = [
    # 1. 系统上下文注入（动态内容）→ 每次重新生成
    {"role": "user", "content": dynamic_context},
    
    # 2. 压缩后的摘要 → 替代原始历史
    {"role": "user", "content": "<compacted-summary>\n{摘要内容}\n</compacted-summary>"},
    
    # 3. 最近的消息 → 保留最近 N 条
    {"role": "assistant", "content": "..."},
    {"role": "user", "content": "..."},
    ...
]
```

**run 内压缩流程**：
```
检测到超限 → 暂停当前 run → 发送"上下文压缩中" → 
调用 LLM 生成压缩摘要 → 更新 messages → 重试 agent round
```

**范围**：
- 修改 `backend/agent/core.py`：在 `_run_loop` 中添加压缩检测
- 修改 `backend/agent/context/compress_conv.py`：添加 run 内压缩函数
- 修改 `backend/agent/runner.py`：添加压缩提示发送

**交付物**：
- 压缩检测逻辑
- 压缩执行函数
- "上下文压缩中"提示
- 测试验证

### Phase 3：增量缓存优化（后续）

**时间**：1-2 天
**范围**：
- 实现动态内容哈希缓存
- 变化检测和增量更新
- 复用未变化的字符串

**交付物**：
- 哈希缓存机制
- 增量更新逻辑

---

## 5. 风险与缓解

### 5.1 风险

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| 消息格式变化导致 LLM 拒绝 | 高 | 分阶段测试，确保兼容性 |
| 动态内容注入位置影响模型理解 | 中 | 参考 dsh 的实现方式 |
| 缓存命中率未达预期 | 中 | 渐进式优化，监控实际效果 |
| 记忆更新延迟 | 低 | 接受短暂的缓存过时 |

### 5.2 回滚方案

如果新方案有问题，可以快速回滚：
1. 恢复 `builder.py` 的原始 `build()` 函数
2. 恢复 `runner.py` 的原始消息构建逻辑
3. 重新部署旧版本

---

## 6. 成功指标

| 指标 | 当前值 | 目标值 |
|------|--------|--------|
| MiniMax 全天缓存率 | 72.2% | 95%+ |
| 跨 call 缓存命中率 | 0% | 90%+ |
| 单轮闲聊缓存率 | 0% | 80%+ |
| API 成本（相对） | 100% | 70% |
| 响应时间（缓存命中后） | 基准 | -30% |

---

## 7. 相关资源

- dsh 缓存诊断：`backend/scripts/diagnostics/test_cross_call_cache.py`
- Session 增量缓存诊断：`backend/scripts/diagnostics/test_session_incremental_cache.py`
- 调查报告：`docs/reports/INVEST-Cross-Call-Prompt-Caching.md`
- 优化报告：`docs/reports/OPT-Cache-Strategy-Aggressive.md`
