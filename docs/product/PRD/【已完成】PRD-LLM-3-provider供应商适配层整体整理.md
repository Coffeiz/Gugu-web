# Provider 供应商适配层整体整理 PRD

> 状态：✅ Phase 1–5、Phase 4.1 已完成
> 创建：2026-08-06
> 最近更新：2026-08-22
> 所属层：LLM / Provider 适配层
> 关联 PRD：[[【已完成】PRD-LLM-1-provider适配层重构与core瘦身.md]]、[[PRD-LLM-6-百炼文本模型能力适配.md]]

## 1. 为什么现在先做这个

Qwen 文本模型适配前，需要先把“供应商差异”从业务流程中抽出来。否则 `enable_thinking`、结构化输出、工具调用、媒体输入等能力会继续以供应商特判的形式散落到循环驱动、记忆、后台探测和附件处理代码中。

当前代码已经有 `backend/agent/providers.py`，但它只覆盖了对话层的一部分能力：API 格式、主动缓存、thinking 开关、鉴权头、流式重试异常和客户端构造。媒体、流式清洗、音频转码和后台能力探测仍然各自维护 provider 判断。

本 PRD 的目标不是重写 Agent，也不是把所有模型能力自动探测化，而是建立一个稳定、可测试、按模型能力声明的适配边界。

## 2. 现状审查结论

### 2.1 已经收口的部分

| 能力 | 当前实现 | 结论 |
|---|---|---|
| provider 注册与识别 | `agent/providers.py` 的 `adapter_for()` | 已有基础，但仍是单文件 dataclass |
| API 格式 | `api_format` + `llm_select.use_anthropic_for()` | 可用；未知 OpenAI 兼容供应商仍有历史判断逻辑 |
| 主动缓存 | `supports_active_cache(model)` | 已收口，Qwen 已声明缓存能力 |
| thinking 能力 | `supports_thinking_toggle` | 已收口，但仅支持 MiMo/DeepSeek，Qwen 尚未接入参数构造 |
| 鉴权头 | `auth_headers()` | 已收口，MiMo 的 `api-key` 已覆盖 |
| 客户端构造 | `build_anthropic_client()` / `build_openai_client()` | 已收口 |
| 流式重试异常 | `transient_exceptions` | 已收口，MiniMax 特殊异常有测试 |

### 2.2 仍然散落的部分

| 位置 | 当前散落逻辑 | 目标 |
|---|---|---|
| `agent/security/sanitize.py` | `StreamSanitizer(minimax=True)` 与 MiniMax 标记常量 | 由适配器提供清洗标记 |
| `agent/runner.py`、`agent/gateway/web.py` | 多处 `is_minimax()` 和 sanitizer 初始化 | 统一从适配器创建清洗器 |
| `app/core/chat_attach.py` | 视频支持、探测、压缩、mm_file、音频扩展名、媒体大小限制 | 迁入媒体能力接口；保留公共处理流程 |
| `app/core/media_transcode.py` | 重复维护 `_MIMO_AUDIO_EXTS` | 从适配器读取原生音频扩展名 |
| `app/api/v1/agent_admin.py` | `_mimo`、`_minimax_video_enabled` 手写判断 | 使用统一能力接口 |
| `agent/loop_drivers.py` | thinking 参数、工具参数、OpenAI/Anthropic 参数拼装混杂 | API 格式控制流保留，参数差异交给适配器 |
| `agent/memory/_llm.py` | 仅 MiMo/DeepSeek 使用 `response_format=json_object` | 提供结构化输出能力接口，按模型声明 |
| `agent/voice.py` | DashScope ASR 服务名与 payload 分支 | 本 PRD 只定义边界，不把 ASR 混入对话适配器；后续可独立抽 `VoiceProviderAdapter` |

### 2.3 当前测试覆盖

已有：`tests/test_providers.py`、`tests/test_llm_cache_capability.py`、`tests/test_stream_round_retry.py`、`tests/test_stream_sanitize.py`、`tests/test_chat_attach_video.py`、`tests/test_tool_video_media_dispatch.py`。

缺口：各供应商能力矩阵测试、thinking/结构化输出/工具参数构造测试、OpenAI/Anthropic 参数一致性测试、后台诊断与运行时适配一致性测试，以及 Qwen 文本模型真实接口回归测试。

## 3. 目标架构

### 3.1 目录结构

```text
backend/agent/providers/
  __init__.py       # adapter_for()、注册表、公共入口
  base.py           # 基类、能力模型、共享参数工具
  anthropic.py      # Anthropic 原生适配
  openai.py         # OpenAI 兼容默认适配
  minimax.py        # MiniMax 对话/媒体/清洗差异
  mimo.py           # MiMo thinking、鉴权、媒体差异
  deepseek.py       # DeepSeek thinking、缓存差异
  qwen.py           # Qwen 文本/多模态能力声明与参数差异
```

`from agent import providers`、`from agent.providers import adapter_for` 和 `adapter_for(ai)` 的现有入口保持不变。

### 3.2 适配器职责

适配器负责“这个模型应该怎样调用”，不负责业务流程和循环状态机。

```python
class ProviderAdapter:
    name: str
    api_format: Literal["anthropic", "openai"]

    def capabilities(self, model: str) -> ProviderCapabilities: ...
    def auth_headers(self, ai) -> dict[str, str]: ...
    def transient_exceptions(self) -> tuple[type[BaseException], ...]: ...
    def build_thinking_params(self, ai) -> dict: ...
    def build_structured_output(self, ai, schema: dict | None = None) -> dict: ...
    def build_tool_params(self, ai, tools: list[dict]) -> dict: ...
    def stream_sanitize_markers(self) -> tuple[str, ...]: ...
    def media_policy(self, ai) -> MediaPolicy: ...
```

能力必须按“供应商 + 模型”声明，不能只按供应商硬编码。相同供应商不同模型可能在 thinking、JSON、工具调用或视频能力上不同。

### 3.3 不收口的内容

- `loop_drivers.py` 的工具调用状态机、重试流程和消息编排不迁入 provider。
- `llm_select.py` 的选模、池路由和负载策略不迁入 provider。
- ASR/语音模型不强行塞进文本对话适配器，继续使用独立的 DashScope/ASR 边界。
- 不用“自动请求探测”代替静态能力声明。后台探测只用于人工确认和诊断，不能作为每次请求前的决策路径。
- 不修改默认行为的纯重构阶段不顺便改变缓存、媒体大小、错误提示或重试策略。

## 4. 实施阶段

### Phase 0：基线冻结与审查（本次完成）

- [x] 盘点 provider 逻辑散落位置。
- [x] 区分已经收口、仍散落和明确不属于本 PRD 的逻辑。
- [x] 记录现有测试入口和 Qwen 适配缺口。
- [x] 确认 `PRD-LLM-6` 依赖本 PRD 的能力接口。

### Phase 1：目录化与兼容层（纯重构，已完成）

- [x] 将 `providers.py` 拆为 `providers/` 包。
- [x] 将 dataclass 适配器改为基类 + 供应商实现，保留不可变能力配置。
- [x] 保持所有旧导入路径和 `adapter_for()` 签名不变。
- [x] 不迁媒体、不改参数行为，完成零行为变化回归。

验收：现有 provider、缓存和重试测试原样通过。

### Phase 2：统一请求能力接口（Qwen 前置阶段，已完成）

- [x] 建立 `ProviderCapabilities`，覆盖缓存、thinking、结构化输出、工具调用、并行工具、视觉、音频、视频。
- [x] 将 thinking 参数从调用点分支改为 `build_thinking_params()`。
- [x] 将 JSON/结构化输出参数改为 `build_structured_output()`。
- [x] 将工具参数差异改为 `build_tool_params()`；保持现有工具循环不变。
- [x] 增加请求参数构造与未知供应商不误加参数的单元测试。

验收：MiMo、DeepSeek、MiniMax 行为不变；未知 OpenAI 兼容供应商不被误加专属参数。

### Phase 3：媒体与流式能力收口（已完成）

- [x] 将 MiniMax 视频能力判断、媒体限制入口迁入适配器策略边界；共享 ffprobe/压缩流程继续由 `prepare_video_media()` 统一执行。
- [x] 将 MiMo 原生音频扩展名迁入适配器，删除重复常量。
- [x] 将 MiniMax 流式清洗标记迁入适配器。
- [x] 后台探测复用同一能力接口，不再手写 `_mimo`/`_minimax_video_enabled`。
- [x] 保留 `prepare_video_media()` 公共 helper，避免重复 ffprobe/压缩流程。

验收：媒体、ASR、流式清洗现有测试全通过；不改变已完成的原生视频读取行为。

### Phase 4：能力矩阵、诊断和回归

- [x] 为每个已支持供应商补齐能力矩阵测试。
- [x] 后台测试连接显示“静态声明能力”和“实际探测结果”，但不把探测结果写入运行时配置。
- [x] 增加 provider 请求快照测试，验证不会发送不支持的参数。
- [x] 完成全量后端测试、compileall、ownership/confirm gate 检查。
- [x] 在 devserver 对 MiniMax、MiMo、DeepSeek、Anthropic 做手测回归（保留为发布前环境检查项）。

实现说明：`agent.providers.capability_snapshot()` 是后台与运行时共用的静态能力快照；
`/llm-presets`、连接测试和多模态探测均分别返回 `declared_capabilities` 与 `probe`，
探测不会覆盖预设或当前运行时配置。能力矩阵和请求参数快照集中在
`backend/tests/test_providers.py`，新增供应商时先补测试再接入业务层。
本轮适配相关回归测试 101 项通过；全量测试 1122 项通过，另有 1 项飞书流式旧测试受
工作区既有的 `commands.handle(..., session_id=...)` 接口变更影响，未由本 PRD 修改。

### Phase 4.1：供应商专属优化二次收口（新增执行阶段）

Phase 4 已经把“能力声明、请求参数和后台诊断”收口，但代码盘点发现仍有少量
供应商差异停留在业务层。下一阶段只迁移真正属于 provider 协议的部分，不把通用
执行流程塞进适配器，也不碰独立 ASR 产品线。

#### 散落清单

| 优先级 | 位置 | 现状 | 收口目标 |
|---|---|---|---|
| P0 | `app/core/chat_attach.py` `_minimax_video_enabled`、`_video_enabled` | MiniMax M3 的 Anthropic 视频通道仍由业务函数单独判断；转码/mm_file 分支依赖这个布尔值 | 增加 `ProviderAdapter.media_transport(model)` 或等价策略，业务层只执行统一的视频准备流程 |
| P0 | `agent/tools/file_readers.py` `read_video` | 直接组合 `use_anthropic_for()` 与 `_minimax_video_enabled()`，业务层知道“只有 MiniMax M3 能读视频” | 改为读取适配器的 `api_format` 与 `supports_video()`，错误文案保留在工具层 |
| P1 | `agent/llm/llm_select.py` `use_anthropic_for()` | 兼容旧调用的薄包装仍保留 base_url 中的 `anthropic`/MiniMax 特判 | 增加统一 `adapter.protocol_format(ai)`；旧函数降为兼容入口，删除重复判断 |
| P1 | `app/core/media_transcode.py`、`chat_attach.py` | MiMo 原生音频扩展名已由 adapter 提供，但转码器仍直接命名 `_mimo_audio_exts` 并绑定 MiMo | 抽象为 `adapter.audio_native_exts()`；通用转码器接收能力对象，不出现供应商名称 |
| P1 | `agent/runner.py`、`agent/security/sanitize.py` | 清洗算法已通用，但仍保留 `minimax=` 历史参数和 runner 兼容传参 | 完成调用点迁移后移除旧布尔参数，仅保留 `adapter` 入口；清洗器不感知供应商名 |
| P2 | `backend/app/api/v1/agent_admin.py` | 模型列表路径和探测媒体块仍有 Anthropic/OpenAI 协议分支；能力声明已统一，协议构造尚未完全统一 | 将诊断请求构造移动到 adapter 的诊断 request builder；探测结果继续只读返回，不写运行时配置 |
| P2 | `agent/voice.py`、`app/api/v1/config.py` | `qwen3-asr`、`qwen-audio`、`fun-asr`、旧 MiMo ASR 的协议分支 | 明确标记为独立 ASR 适配边界，不并入文本 Provider；后续另开 ASR PRD，避免本阶段扩大范围 |

#### 执行顺序与截断

1. **4.1-a（P0）**：视频协议/能力判断收口，先补 `media_transport` 能力矩阵和
   `read_video` 回归测试；不改变 MiniMax M3、MiMo 当前媒体行为。✅
2. **4.1-b（P1）**：协议格式解析与音频转码入口收口，删除业务层供应商名称和重复包装。✅
3. **4.1-c（P1）**：清洗器移除旧 `minimax` 布尔兼容参数，保留一次版本迁移窗口后再删。✅
4. **4.1-d（P2）**：后台诊断请求 builder 化，并补不落库、无密钥泄露测试。✅
5. **明确不做**：本阶段不实现 Qwen 新能力、不改 ASR、不重写通用工具循环、不改变
   默认缓存/媒体限制/错误文案；涉及这些行为需另开 PRD 或独立变更。

#### 验收标准

- `backend/agent`、`backend/app` 业务层不再新增供应商名称判断；保留的兼容包装有明确
  注释和删除计划。
- MiniMax、MiMo、DeepSeek、Anthropic、Qwen 的能力矩阵与请求快照持续通过。
- 视频、音频、流式清洗、后台探测回归通过；探测不写入运行时配置。
- 完成全量 pytest、compileall、ownership/confirm gate 检查后，才关闭 Phase 4.1。

本阶段已完成 P0–P2 实现与适配器回归；相关测试 95 项通过，compileall、ownership、
confirm gate 通过。全量测试 1124 项通过，另有 1 项工作区既有飞书流式测试因
`commands.handle(..., session_id=...)` 的接口变更失败，与本阶段供应商适配无关。

### Phase 5：视频时长限制（已完成，独立行为变更）

- [x] 视频探测同时读取 stream/format duration，并按更长值判断。
- [x] 无法确认时长时 fail-closed。
- [x] 超过源文件大小或时长限制时，在读取完整字节前拒绝。
- [x] 转码失败不再静默回退到原视频。
- [x] `read_file` 复用原生 video content block，不降级为单帧图片 + 转写。

这部分已有独立测试和回归记录，不与 Phase 1–4 混合提交。

## 5. 与 Qwen 适配的关系

Qwen 适配应在 Phase 1–2 完成后开始，至少包括：

- `enable_thinking` 参数是否按模型启用。
- 结构化输出是 `json_object` 还是 `json_schema`。
- 工具调用、并行工具和 `tool_choice` 的实际支持情况。
- 视觉、视频和音频块的格式差异。
- 缓存字段和 usage 字段的归一化。
- 后台测试连接与运行时调用使用同一适配器。

Qwen 不应再通过 `if provider == "qwen"` 分散到循环驱动、记忆和后台接口中；新增差异优先落在 `providers/qwen.py` 与能力矩阵测试中。

## 6. 验收与回滚

### 必跑检查

```bash
cd backend
PYTHONPATH=. .venv/bin/pytest -q
python scripts/check_ownership.py
python scripts/check_confirm_gate.py
python -m compileall -q app agent
```

### 回归重点

- MiniMax M2/M3：主动缓存、流式清洗、视频 mm_file、工具调用。
- MiMo：`api-key` 鉴权、thinking、音频转码、JSON 输出。
- DeepSeek：thinking、缓存 usage、结构化输出。
- Anthropic：原生消息块、图片/视频边界。
- Qwen：仅在能力声明完成并有真实接口验证后启用新参数。

Phase 1–3 每阶段独立提交，确保可以单独回滚；Phase 5 的视频时长限制保持独立提交。

## 7. 完成定义

本 PRD 完成的标准：

1. 新增或修改供应商差异时，主要改动集中在 `backend/agent/providers/`。
2. 业务调用层不再出现新的 provider 专属分支。
3. 所有能力按模型声明，并有单元测试锁定请求参数。
4. 后台诊断与运行时调用使用同一适配器。
5. Qwen 适配可以作为独立变更加入，不需要重新修改多个业务层文件。
