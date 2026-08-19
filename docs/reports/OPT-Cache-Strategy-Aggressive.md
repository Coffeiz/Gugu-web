# 缓存策略优化报告

**报告日期**: 2026-08-19
**优化类型**: 性能优化
**影响范围**: 所有使用 Anthropic 兼容 API 的对话（含 MiniMax-M3）

## 1. 背景

用户观察到 LoopScope 中每轮对话都显示 "Context assembly & prompt" span，怀疑重复内容（如项目列表、记忆等）没有有效缓存。理论上这些内容在多轮对话中大部分时间保持不变，应该能被缓存复用。

## 2. 缓存机制说明

**Anthropic/MiniMax 的缓存机制**（来源：MiniMax 官方文档）：
- ❌ **不是自动识别** - 服务商不会基于内容相似度自动决定
- ✅ **必须主动标记** - 需要在内容中明确指定 `cache_control: {type: "ephemeral"}`
- ✅ **TTL 5 分钟** - 标记的缓存内容在 5 分钟内可复用，每次命中自动刷新
- ✅ **命中便宜** - 缓存读取按 10% 价格计费
- ⚠️ **断点限制** - 最多 4 个显式 cache_control 断点，超出会返回 400 错误

**MiniMax 特殊限制**（2026-08-19 发现）：
- **被动缓存**（推荐）- API 自动识别，无需 cache_control，需要 ≥512 tokens
- **主动缓存**（Anthropic 兼容）- 需要显式 cache_control
- **关键发现**：MiniMax-M3 **不支持被动模式下的主动缓存**
- **实测对比**：被动缓存 Round 1 cache_read=391，主动缓存 Round 1 cache_read=128
- **结论**：对于 MiniMax-M3，使用被动缓存效果更好

## 3. 优化前的策略（保守策略）

**实现位置**：`backend/agent/loop_drivers.py` 第 159-175 行

**策略**：
```python
# 把 system 拆分为稳定前缀 + 动态后缀
stable, dynamic = _builder.split_for_cache(system_text)
# 只给稳定前缀标记缓存
system_param = [
    {"type": "text", "text": stable, "cache_control": {"type": "ephemeral"}},
    {"type": "text", "text": dynamic},  # 不标记
]
```

**问题**：
- 记忆、项目概览、文件概览等大部分时间不变的内容被放在 `dynamic` 部分
- 这些内容在 5 分钟 TTL 内实际上是不变的（每次命中会自动刷新）
- 浪费了缓存空间

## 4. 对比测试

**测试脚本**：`backend/test_cache_strategy_compare.py`

**测试方法**：
1. 构造真实场景的 system 提示词（含记忆、项目、文件概览）
2. 跑 3 轮相同对话
3. 对比两种策略的 cache_read_tokens 和 cache_write_tokens

**测试结果**：

| 轮次 | 策略 | input_tokens | cache_read | 命中率 |
|------|------|--------------|------------|--------|
| 第1轮 | 保守 | 330 | 128 | 27.9% |
| 第1轮 | 激进 | 331 | 128 | 27.9% |
| 第2轮 | 保守 | 108 | 384 | **78.0%** |
| 第2轮 | 激进 | 34 | 459 | **93.1%** |
| 第3轮 | 保守 | 133 | 384 | **74.3%** |
| 第3轮 | 激进 | 25 | 493 | **95.2%** |

**总体统计**：
- 保守策略：input=571, cache_read=896, 命中率 61.1%
- 激进策略：input=390, cache_read=1080, 命中率 73.5%
- **提升：+20.5%**

## 5. 实施的优化（激进策略）

**修改位置**：`backend/agent/loop_drivers.py` 第 159-175 行

**新策略**：
```python
# 放弃 stable/dynamic 分组，全部标记缓存
if system_text:
    stripped = _builder.strip_cache_marker(system_text)
    if supports_active_cache:
        _sys_blk = {"type": "text", "text": stripped, "cache_control": {"type": "ephemeral"}}
        system_param = [_sys_blk]
    else:
        system_param = stripped
```

**优势**：
1. **简化逻辑** - 不再需要 `split_for_cache` 拆分
2. **更高命中率** - 73.5% vs 61.1%（提升 20.5%）
3. **节省成本** - input_tokens 减少 31.7%
4. **更快响应** - 减少重复计算

**潜在代价**：
- 动态部分每次变化会触发 cache_write
- 但相对节省的 cache_read，代价可接受

## 6. 验证

**部署步骤**：
1. 修改代码 → 同步到 devserver → 重启后端
2. 进行实际对话测试
3. 对比 LoopScope 中的缓存指标

**预期效果**：
- 后续对话的 cache_ratio 应普遍提升到 70%+
- 平均 input_tokens 减少 20-30%
- 用户感受到响应更快

## 7. 后续监控

**监控指标**：
- LoopScope 中的 cache_ratio（应提升到 70%+）
- 平均 input_tokens（应减少 20-30%）
- cache_write_tokens（应在合理范围）

**是否回滚的判断**：
- 如果 cache_write_tokens 异常飙升（说明缓存频繁失效）
- 或者响应时间反而变慢
- 考虑回滚或调整策略

## 8. 相关文件

- `backend/agent/loop_drivers.py` - 缓存策略实现
- `backend/test_cache_strategy_compare.py` - 对比测试脚本
- `docs/devlog.md` - debug 记录

## 9. 经验教训

1. **数据驱动决策** - 通过对比测试验证假设，而不是凭直觉
2. **激进策略优于保守** - 在 TTL 窗口内，大部分"动态"内容其实不变
3. **简化设计** - 放弃复杂的分组逻辑，换更简单的实现
4. **持续监控** - 优化后需要实际数据验证效果

---

**测试人员**: ZCode
**审核**: -
**状态**: ✅ 已实施，待生产环境验证