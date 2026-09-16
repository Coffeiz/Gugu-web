# Admin 主对话命中率 vs Loopscope run 缓存率 差异调查报告

**日期**: 2026-09-16
**调查目标**: Loopscope 里 run 的缓存命中率几乎都是 99%，但 Admin 用量统计的主对话命中率明显更低（用户先后看到 83.9% / 76.2%），排查是 bug 还是口径/策略问题。

## 结论（TL;DR）

**没有计算 bug。两边的公式完全同构**（`cache_read / (fresh_input + cache_read + cache_write)`），差异全部来自**统计范围与聚合方式**：

| 视角 | 范围 | 实测值（devserver） |
|------|------|--------------------|
| Loopscope 单 run | 一次 run 内的全部 LLM 调用 | 中位数 **97.5%**，主流桶 95–99% |
| Loopscope 全部 run 加权 | 同一批 run 按 token 加权聚合 | **≈91.9%** |
| Admin「最近 7 天」主对话 | 窗口内全部 scenario=chat 调用 | **92.9%** |
| Admin「今日」 | 当天（样本小、冷启动多） | 76.2%（随当天调用滚动） |
| Admin「总计」 | 全期，含旧策略时代存量 | 48.2% |

关键证据：把 Loopscope collector 里同样的 387 个 run **按 token 加权聚合成一个数**，得到 ≈91.9%，与 Admin 7 天口径 92.9% 基本吻合——**同一批调用，逐 run 看是 97.5%，加权后就是 92%**。差距是视角，不是算错。

## 1. 两侧口径核对

### Loopscope（`backend/agent/runtime/loopscope_trace/state.py` add_usage）

```
input = fresh_input + cache_read + cache_write   # 三分量重算，防历史不一致
cache_ratio = cache_read / input
```

范围：**单个 run**（一次对话回合的 agent 循环内全部 LLM 调用）。

### Admin（`backend/app/api/v1/agent_admin.py`）

```
有效输入 tokens_in = tokens_in + cache_read + cache_write   # anthropic/minimax 或 cutoff 后
cache_ratio = SUM(cache_read) / SUM(有效输入)
```

范围：**时间窗（今日/最近7天/全期）内全部 scenario='chat' 的 agent_usage 行**（非 BYOK；2026-09-10 前无 scenario 标记的存量行也计入主对话）。个人侧 `/auth/usage` 趋势接口同公式（分母含命中+写入，注释明确「只算 in+read 会把首次建缓存当天的分母算小」）。

两边的分子分母定义一致，归一化层（`agent/usage.py`）也是同一份 provider usage。

## 2. 真实数据比对（devserver，只读 SQL）

### 2.1 Loopscope collector（最近 387 个有输入的 run）

| 桶 | runs | eff tokens |
|----|------|-----------|
| 95–99% | 196 | 31.1M |
| 90–95% | 37 | 7.9M |
| <90% | 85 | 10.1M |

中位数 97.5%；≥98.5% 的 run 只占 33%。「几乎都是 99%」来自滚动浏览时长 run 聚集在 95–99% 桶的印象；<90% 的 85 个 run（短 run、冷启动 run）在列表里不显眼。

### 2.2 Admin 场景聚合（最近 7 天，非 BYOK）

| 场景 | calls | 有效输入 | 命中率 |
|------|-------|---------|--------|
| **chat（主对话）** | 542 | 148.8M | **92.7%** |
| compaction | 39 | 3.3M | 81.0% |
| reflection | 321 | 2.7M | 29.0% |
| knowledge | 19 | 77K | 23.2% |

### 2.3 主对话 16–24% 新鲜输入的去向（7 天 chat）

| 构成 | calls | fresh tokens | 说明 |
|------|-------|-------------|------|
| 会话后续轮的逐轮新增 | 444 | 8.9M（6.4%） | **结构性**：每轮新增的用户消息+RAG/memory/工具结果天然未命中 |
| 会话窗口内首轮 | 10 | 0.43M（9.6%） | 新会话首轮，单轮有效输入平均 44 万 tokens（RAG+memory 重装载） |
| **无 session_id 的 chat 调用** | 88 | 1.5M | 命中率仅 71.3%；其中 61 次 MiniMax 无工具调用只有 **38.3%** |
| 全程零命中调用 | 12 | 0.6M | MiniMax 为主 |

### 2.4 按天与按 provider

- 按天 chat 命中率：密集使用日 94%+（09-10 94.6%、09-12 94.1%）；稀疏日暴跌（09-11 78.5%、09-13 34.5%、09-14 **0.4%**）——调用间隔超过缓存 TTL（MiniMax 约几十分钟）后每轮都重写缓存。
- 按 provider：DeepSeek 94.4% > Qwen 92.0% > **MiniMax 90.4%**（MiniMax 缓存键参与请求参数、不持久化跨请求缓存，续接断点更脆）。
- BYOK 侧（Admin 面板不统计）：7 天 87.3%，本月 chat 88.1%——用户主力用量在 BYOK 通道，Admin 看到的只是平台通道。

### 2.5 「总计 48.2%」的构成

2026-09-10 之前的存量行（5,500 次，339M 有效输入）命中率只有 **28.1%**——那是旧缓存策略时代（四区域改造+尾部时间戳归位之前）的记录，被无标记计入主对话后永久拖低全期口径。09-10 策略落地后的天数都在 92–94%。

## 3. 判定：bug 还是策略？

**计算层：无 bug。** 公式同构、归一化同源、实测交叉对账吻合（Loopscope 加权 91.9% ≈ Admin 92.9%，残差来自 Loopscope 只覆盖 LOOPSCOPE_ENABLED 的 run）。

**口径层：是统计范围差异，属正常但易误读。** 逐 run 看（Loopscope）天然偏向稳态长 run；时间窗加权（Admin）把冷启动、逐轮增量、稀疏日全部摊进来。

**策略层：有真实但非紧急的损失点，按优先级：**

1. **无 session 的 chat 调用（88 次 / 5.2M / 71.3%，MiniMax 无工具组仅 38.3%）**——归属不明，建议排查是哪条旁路（疑似标题/摘要/分类类小调用），要么补 session 归属、要么单独标 scenario，别混进主对话。
2. **Admin「总计」卡片把 09-10 前旧策略存量（28%）与新策略（92%+）混算**，看板参考价值有限——建议前端给「总计」加策略切换日注记，或默认只展示近 7 天。
3. **稀疏使用日的 TTL 过期**（09-14 全天 0.4%）——结构性，无法根除；若在意可评估拉长 MiniMax 侧会话保持策略，但收益有限。
4. **MiniMax 比 DeepSeek 低 4pt**——provider 特性（跨请求不持久化），已知边界，不建议再投入。

## 4. 复现方式

只读查询（devserver）：

```bash
ssh coffeiz@192.168.110.51 'cd ~/文档/Workspace/Gugu-web/backend && .venv/bin/python -' < 脚本
```

核心 SQL 口径（与 `_effective_input_sql` 一致）：

```sql
-- 有效输入（分母）
CASE WHEN LOWER(provider) IN ('anthropic','minimax') OR created_at >= '2026-09-01'
     THEN tokens_in + cache_read + cache_write ELSE tokens_in END
-- 命中率 = SUM(cache_read) / SUM(有效输入)
```

Loopscope 侧直接读 collector SQLite（`/home/coffeiz/loopscope-data/loopscope.db` 的 `runs.usage_json`），`cache_ratio = cache_read / (fresh_input + cache_read + cache_write)`。

## 附：相关记忆/前作

- 2026-08-19《跨 Call Prompt 缓存调查报告》（docs/reports）——四区域架构与缓存策略的前置调查
- 追加式压缩分支对齐（79be37a92）——run 内压缩缓存 0.1%→99.2% 的前因
- BYOK 用量统计修复——命中率分母漏 cache_read 的历史 bug（已修，与本报告无涉）
