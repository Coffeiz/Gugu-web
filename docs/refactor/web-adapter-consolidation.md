# Web Adapter 与 Runner 统一组装方案

**日期**: 2026-08-20
**状态**: 待实施
**关联**: Prompt Cache 优化（`OPT-Cache-Assembly-2026-08-19.md`）

---

## 问题

`agent/gateway/web.py` 的 `stream()` → `_generate()` 有独立的上下文组装流程，与 `agent/runner.py` 的 `run_stream()` 高度重复。两套代码逐渐分叉，导致：

1. **修一边漏另一边**：`[system-reminder]` 注入顺序修复时，只改了 runner.py，漏了 web.py
2. **行为不一致**：web.py 缺少 `model_cfg` 传递、`content_json` 精细处理、`filter_tool_names`
3. **缓存策略不同步**：两处的 messages 组装顺序需手动保持一致

## 差异清单

| 差异 | web.py | runner.py (run_stream) | 影响 |
|------|--------|----------------------|------|
| 上下文加载 | 分别调 `loaders.load_*()` | `load_context_data()` 统一加载 | 无功能差异，但 web 缺少 `im_channels` |
| `model_cfg` | 不传，回退 `settings.ai` | 传 `pick_model()` 解析结果 | web 可能用错模型/参数 |
| `content_json` | 简单透传 list | 详细提取 text/tool_use/tool_result | web 可能发送原始 list 给 LLM |
| 工具名过滤 | 不过滤 | `filter_tool_names()` | web 可能暴露不该用的工具 |
| IM identity/记忆 | 无 | 有 | web 不需要（web 无 IM 概念） |
| proactive_lead | 无 | 有 | web 不需要 |
| greeting 处理 | 有 | 无 | web 独有，需保留 |
| source | 硬编码 `"web"` | `getattr(req, "source")` | 无功能差异 |
| 非流式标记 | 未传 `non_streaming` | `non_streaming=False` | `build_split` 默认值可能不对 |

## 重构方案

### 方案：web adapter 调用 `run_stream()`

将 web adapter 的职责收窄为：

```
stream()
  ├─ 加载上下文（projects, events, memory 等）
  ├─ 会话 get/create
  ├─ 构造 AgentRequest
  ├─ 调用 run_stream(req)          ← 统一入口
  └─ 流式输出 + 持久化
```

`run_stream()` 负责所有组装逻辑（build_split、dynamic extras、messages、sanitize、runner.run）。

### 需要的改动

#### 1. `runner.py` — `run_stream()` 接受 web 请求

当前 `run_stream` 的签名和内部逻辑已基本通用。需要：

- 确保 `run_stream` 能处理 web 场景（无 IM identity/bridge/proactive_lead 时跳过）
- 添加 greeting 参数支持（web 独有）
- 传递正确的 `model_cfg`

#### 2. `web.py` — 瘦身

移除 `_generate()` 中的重复组装逻辑：

- 删除 `build_split` 调用
- 删除 `_dynamic_extra_parts` / `_ctx_injection` 组装
- 删除 `anthr_messages` / `oa_messages` 手动构建
- 删除 `sanitize.sanitize_messages` 调用
- 保留：流式输出、去重、持久化、反思

#### 3. 保留 web 独有逻辑

以下逻辑只在 web 路径需要，应在 `run_stream` 中作为可选参数支持：

- `greeting` 处理（新会话首轮不重复寒暄）
- 流式去重（MiniMax 多轮工具调用文本重述）
- `_generate` 的 `asyncio.create_task` 后台执行模型

### 实施步骤

1. **阶段 0**（当前）：验证 `[system-reminder]` 顺序修复的缓存效果
2. **阶段 1**：将 web.py 的 greeting 逻辑提取为 `run_stream` 的可选参数
3. **阶段 2**：让 `web._generate()` 调用 `run_stream()` 而非自己组装
4. **阶段 3**：删除 web.py 中的重复组装代码
5. **阶段 4**：确保 `run_collect`（IM 路）也走统一流程

### 风险

- web 的流式输出逻辑（去重、token yield）与 runner 的 streaming 有差异，需仔细对齐
- `asyncio.create_task` 后台执行模型可能与 runner 的 streaming generator 冲突
- 需要完整的回归测试覆盖 web + IM 两条路径

## 验收标准

1. web 和 IM 路径使用同一套组装代码
2. 修改组装逻辑只需改一处
3. 缓存命中率在 web 和 IM 路径一致
4. 所有现有测试通过
