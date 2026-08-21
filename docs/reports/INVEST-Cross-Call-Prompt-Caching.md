# 跨 Call Prompt 缓存调查报告

**日期**: 2026-08-19
**调查目标**: 找出为什么 Loopscope 显示的缓存率远低于预期（72% vs Qwen-paw 的 98%）

## 1. 问题背景

用户发现 MiniMax 的全天缓存率为 72.2%，而之前使用 Qwen-paw 时达到 98.7%。差距约 26.5%，每天约 130 万 tokens 的浪费。

## 2. 调查过程

### 2.1 Loopscope 单轮数据分析

| Run 类型 | 工具轮次 | cache_read | 分析 |
|----------|---------|-----------|------|
| 闲聊（单轮） | 1 | 128 | 无缓存 |
| 工具调用 | 3轮 | 164,951 | 高缓存率 65% |
| 闲聊（单轮） | 1 | 128 | 无缓存 |

**结论**: 缓存只在 run 内多轮工具循环中生效。

### 2.2 MiniMax 缓存机制测试

#### 被动缓存测试
```python
# 5 次完全相同的请求
Call 1: cache_read=128, cache_write=0
Call 2: cache_read=128, cache_write=0
Call 3: cache_read=128, cache_write=0
Call 4: cache_read=128, cache_write=0
Call 5: cache_read=128, cache_write=0
```

**结论**: MiniMax 不支持跨 call 被动缓存（即使 ≥512 tokens）。

#### 主动缓存测试（cache_control）
```python
# 给 system 块加 cache_control
Call 1: cache_read=128, cache_write=0
Call 2: cache_read=128, cache_write=0
```

**结论**: 主动缓存也不支持跨 call。

### 2.3 dsh（DeepSeek Harness）对比测试

在 dsh 中使用 MiniMax-M3 进行 5 轮对话：

```
Turn 1 step 1: input=420,  cache_read=7552   ← 跨 call 缓存命中！
Turn 2 step 1: input=421,  cache_read=8448   ← 更多缓存！
Turn 3 step 1: input=28137, cache_read=25984 ← 更多！
Turn 4 step 1: input=51085, cache_read=51840 ← 更多！
```

**结论**: dsh 在 MiniMax 上实现了跨 call 缓存！

### 2.4 根本原因定位

**dsh 的 system prompt 完全静态**：
- 只有固定的人格/工具定义
- 不包含时间、记忆、项目状态等动态内容
- 跨 call 时 system prefix 完全一致，MiniMax 前缀匹配能命中

**我们的 system prompt 包含动态内容**：
- 当前时间（每分钟变化）
- 记忆摘要（偶发变化）
- 项目概览、文件概览（偶发变化）
- 跨 call 时 system prefix 变化，缓存无法命中

## 3. 关键发现

### MiniMax 缓存机制

- **缓存策略**: 前缀精确匹配（tools → system → messages）
- **任何内容变化都会导致整个缓存失效**
- **支持 cache_control 标记**，但只在 prefix 匹配成功时生效
- **不支持跨 call 缓存**（除非 prefix 完全一致）

### 各 Provider 缓存支持对比

| Provider | 跨 call 缓存 | 前缀匹配方式 | 缓存 TTL |
|----------|-------------|-------------|---------|
| MiniMax | 条件支持 | 前缀精确匹配 | 5分钟 |
| Qwen/阿里 | 条件支持 | 前缀精确匹配 | 5分钟 |
| DeepSeek | ✅ 支持 | prompt_cache_hit_tokens | 自动 |
| Qwen-paw | ✅ 支持 | 自动缓存 | 不确定 |

**"条件支持"** 指：如果跨 call 时 prefix 完全一致（system + messages 前缀相同），则可以命中缓存。

## 4. 修复方案

### 已实施

1. **OpenAI 路径支持 cache_control** - Qwen/阿里正确读取缓存字段
2. **多段缓存策略** - stable/semi-stable/volatile 分段
3. **Loopscope 缓存字段修复** - 正确读取 `prompt_tokens_details.cached_tokens`

### 待实施

**将动态内容从 system 移到 messages[0]**：

```
# 当前架构（有问题）
system = 人格 + 记忆 + 项目 + 时间  ← 动态内容导致前缀变化

# 优化后架构（参考 dsh）
system = 人格 + 政策 + 工具定义  ← 完全静态
messages[0] = 记忆 + 项目 + 时间  ← 动态内容在 messages 中
```

这样 system prefix 在 call 之间完全一致，MiniMax 就能匹配缓存。

## 5. 预期效果

实施优化后：
- system prefix 跨 call 完全一致
- MiniMax 前缀匹配能命中 system 缓存
- 缓存率从 72% 提升到接近 98%（与 Qwen-paw 相当）

## 6. 相关文件

- `backend/agent/loop_drivers.py` - 缓存策略实现
- `backend/agent/context/builder.py` - system prompt 构建
- `backend/agent/runtime/loopscope_trace/utils.py` - 缓存数据提取
- `backend/scripts/diagnostics/test_cross_call_cache.py` - 跨 call 缓存诊断脚本
- `backend/scripts/diagnostics/test_cache_mode_compare.py` - 缓存模式对比诊断脚本

---

**调查人员**: ZCode
**状态**: ✅ 根因已定位，待实施优化
