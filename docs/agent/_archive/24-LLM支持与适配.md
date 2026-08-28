# LLM 支持清单与适配优化

> 咕咕当前支持的 LLM 厂商、各自走哪套 API 格式、做了哪些**针对性适配/优化**、以及踩过的坑。
> 加新模型 / 排查模型相关问题先看这份。相关：[[03-可靠性.md]]、[[33-多步执行与防停顿.md]]、[[00-总览.md]]。
> 代码锚点：模型路由 `agent/llm_select.py`；调用循环 `agent/core.py`（`_run_anthropic` / `_run_openai`）；配置 `app/core/config.py`；后台 `app/api/v1/agent_admin.py` + `views/Admin/Agent/index.vue`。

---

## 易读概述

咕咕不是绑死在某一家大模型上——后台可以配置多个 LLM 厂商（MiniMax、Anthropic、DeepSeek、小米 MiMo、通义千问、智谱 GLM、OpenAI 兼容），随时切换用哪个来驱动咕咕的大脑，也可以同时留几个作为备用池。

这带来一个麻烦：**不同厂商的 API 协议不一样**。业内主要分两大流派——Anthropic（Claude）风格和 OpenAI 风格，字段名、流式返回格式、"思考过程"怎么表示都不同。咕咕内部把所有厂商归到这两套格式里的一套，调用逻辑按格式分叉，而不是每家写一套。

更麻烦的是，即使同属一套格式，各厂商也有零星的怪癖——有的鉴权头不是标准 Bearer、有的思考模式一开就把正文憋没了、有的对格式校验特别严格。这份文档记录的就是"为了让每家模型都能可靠干活，额外做了哪些补丁"，以及"哪些坑已经踩过、后来怎么修的"。

日常用得到这份文档的场景：**加一个新厂商**、**某个模型突然报错/行为不对**、**想知道某个优化是给谁做的**。

---

## 专业细节

### 1. 概览：7 个厂商 × 2 套 API 格式

| 厂商（provider） | 默认 base_url | 默认模型 | API 格式 | 调用路径 |
|---|---|---|---|---|
| **minimax** | `api.minimaxi.com/anthropic` | `MiniMax-M3` | **Anthropic** | `_run_anthropic` |
| **anthropic** | `api.anthropic.com/v1` | `claude-opus-4-8` | **Anthropic** | `_run_anthropic` |
| **deepseek** | `api.deepseek.com` | `deepseek-chat` | OpenAI | `_run_openai` |
| **mimo**（小米） | `token-plan-cn.xiaomimimo.com/v1` | `mimo-v2.5` | OpenAI（可选 Anthropic） | `_run_openai` |
| **qwen**（通义千问，默认 provider） | `dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-max` | OpenAI | `_run_openai` |
| **glm**（智谱 GLM） | `open.bigmodel.cn/api/paas/v4` | `glm-5.2` | OpenAI | `_run_openai` |
| **openai**（OpenAI 兼容） | `api.openai.com/v1` | `gpt-4o` | OpenAI | `_run_openai` |

以上厂商列表、默认 base_url/模型已与 `agent/llm_select.py`、`app/core/config.py`（`AISettings.provider` 默认 `qwen`）、`views/Admin/Agent/index.vue` 的 `PROVIDERS` 三处比对一致。

**格式判定**（`llm_select.use_anthropic_for`）：`api_format` 显式优先；否则 `provider==minimax` 或 base_url 含 `anthropic` → Anthropic 格式，其余 → OpenAI 格式。**mimo 两套 API 都提供**，可用 `api_format` 显式选。

---

### 2. 路由 / 判定层（`agent/llm_select.py`）

- `pick_model(settings, ctx)`：选模型的唯一决策点。策略 `active`（单一激活，默认）/ `pool`（多 key 分流，勾 `in_pool`）/ `router`（智能路由，插槽已留、未实装）。
- `use_anthropic_for(ai)`：该模型走哪套格式（全后端唯一判定口，聊天/记忆/IM 共用）。
- `_is_mimo(ai)` / `_is_deepseek(ai)`：厂商专属适配判定。
- `supports_thinking_toggle(ai)` = mimo ∪ deepseek：是否支持 OpenAI 思考开关参数 `{"thinking":{"type":...}}`。已核对代码：该函数正是 `_is_mimo(ai) or _is_deepseek(ai)`，其余 openai 兼容厂商（qwen/openai）不发这个参数，避免报错。
- `openai_default_headers` / `anthropic_default_headers`：非标准鉴权头——**mimo 用 `api-key` 头**（非 Bearer），其余空（SDK 默认）。

---

### 3. 按 API 格式的横切适配

#### Anthropic 格式（`_run_anthropic`，minimax / anthropic / mimo-anthropic）
- **prompt 缓存**：system 拆「稳定前缀（人格/政策/技能索引，打 `cache_control: ephemeral`）┃ 动态后缀（记忆/分钟时间，不缓存）」+ **多轮工具滚动缓存断点**；`cache_read_input_tokens` 统计。**例外：mimo 的 anthropic 端点不支持缓存，不发 `cache_control`**。（0.14.1）
- **思考**：`thinking:{type:"adaptive"}`（Anthropic 原生），thinking blocks 多轮**原样回传**（`content_dicts` 含 thinking）。
- **历史兼容边界（2026-08-24）**：thinking 可能带模型专属签名，不做跨 provider 迁移。
  会话记录最近使用的 provider/API 格式；检测到切换时一次性移除历史中的旧 thinking
  块并持久化，保留文本与工具往返，同配置不重复处理。详见[上下文架构与扩展指南](32-上下文架构与扩展指南.md)。
- **工具**：`registry.anthropic_schemas`；`sanitize.sanitize_messages` 清孤儿 `tool_use`/`tool_result`、空块、None 字段（MiniMax 严格校验，否则 `400 text is not set`）。
- **流式抽风重试**：MiniMax 偶发空/异常流 → `IndexError`/`KeyError` 纳入出-token-前重试。

#### OpenAI 格式（`_run_openai`，deepseek / mimo / qwen / openai）
- **思考开关**：DeepSeek 按官方 OpenAI 格式发送 `extra_body: {"thinking":{"type":"enabled/disabled"}}`，思考强度作为顶层 `reasoning_effort: low/high/max` 发送；mimo 仍使用自身的 thinking 参数。（Unreleased）
- **`reasoning_content` 多轮回传**：流式捕获 `delta.reasoning_content`，在**所有** assistant 回填点统一带回（`_asst` 收口）——mimo/deepseek 思考+工具多轮缺它会 **400**。**模型无关**（任何吐 reasoning_content 的模型都受益）。只当轮内存回传、不入库。（0.14.2）
- **空正文兜底**：整轮无正文（推理模型把话全放 reasoning_content / 降级无活干）→ `empty_retry` 追一轮要正文，仍空给得体兜底。**不限 mimo**。
- **system 缓存标记**：去掉 builder 的 `CACHE_BREAK`（OpenAI 通道不支持 cache_control）。

#### 全路共用的可靠性守卫（`agent/core.py`）
真实性/防停顿守卫，与厂商无关：`_looks_like_narration`（假装已做完）、`_announces_intent`（说要做没动手，0.14.2）、`_is_decision_dodge`（擅自不做）、自我核实闭环（`did_mutate`/`verify_queried`）。详见 [[03-可靠性.md]]、[[33-多步执行与防停顿.md]]。

---

### 4. 逐厂商：针对性优化 + 注意

#### MiniMax（`MiniMax-M3`，Anthropic 格式）—— 当前主力强模型
- **优化**：prompt 缓存（稳定前缀 + 滚动断点）、thinking blocks 回传、`sanitize_messages`、流式抽风重试。
- **实测**：复杂长任务能链式+同轮并行调 6 工具、可靠 finish、零停顿（[[33-多步执行与防停顿.md]] §7.5）。
- **坑**：历史里非标字段 / 不配对工具块 → 严格校验 `400`（已由 sanitize 兜）。

#### Anthropic / Claude（`claude-opus-4-8`，Anthropic 格式）
- **优化**：同 MiniMax 的缓存/thinking。
- **特性**：continue/stop 纪律**内化在权重**，几乎不"宣告完就停"，是守卫体系的"满分参照"。最强基座。

#### DeepSeek（`deepseek-chat`，OpenAI 格式）
- **优化**：① **思考开关生效**；② **思考强度 `reasoning_effort`（low/high/max）后台可调**——思考模式下 temperature 失效，effort 是质量/成本旋钮；③ **DeepSeek Vision** 使用 `deepseek-v4-flash-vision-exp`，OpenAI `image_url.detail` 默认 `auto`；④ **反思走 `json_object` + thinking:disabled**；⑤ **自动上下文缓存命中监控**（`prompt_cache_hit_tokens` → `_usage.cache_read`）；⑥ `reasoning_content` 多轮回传（横切，自动受益）。（Unreleased）
- **特性**：上下文缓存**全自动**（无需 `cache_control`），咕咕「稳定前缀在前」的 system 拆分天然吃到命中；多轮无状态、客户端重发全历史（咕咕本就如此）。
- **坑**：思考模式忽略 temperature/top_p；`json_object` 要求 prompt 含 "json" 字样+样例（反思 prompt 已满足）。
- **可选未做**：Tool strict 模式（beta）；前缀续写 / FIM（与咕咕场景无关）。

#### mimo / 小米（`mimo-v2.5`，OpenAI 格式，可选 Anthropic）
- **优化**：`thinking:disabled` 防"正文全进 reasoning_content、content 空"的空气泡；`reasoning_content` 多轮回传（防 400）；反思 `json_object`；空正文兜底；`api-key` 鉴权头。
- **实测修正**：早判「不适合可靠多步工具」**已推翻**——能链 6 工具+finish；真坑是**思考开时正文空 + 多轮要回传 reasoning_content**（已修），很可能正是之前缺这些优化才显得"多步不行"（[[03-可靠性.md]]）。
- **坑**：anthropic 端点**不支持 prompt 缓存**（不发 cache_control）；带媒体（音视频理解）需走 mimo（媒体块路由）。

#### Qwen / 通义千问（`qwen-max`，OpenAI 格式）—— 默认 provider
- **优化**：无专门适配，走通用 OpenAI 路。
- **注意**：Qwen3 的 `enable_thinking` 参数**未接**（如需可仿 deepseek 加判定）；JSON/工具走通用。

#### 智谱 GLM（`glm-5.2`，OpenAI 格式）
- **默认地址**：`https://open.bigmodel.cn/api/paas/v4`；Admin 的同一个 GLM 预设可切换到 Coding Plan 专属地址 `https://open.bigmodel.cn/api/coding/paas/v4`。
- **适配**：复用 OpenAI 兼容调用、工具和 JSON mode；GLM-4.5/4.6/4.7/5 系列按 Admin 的深度思考开关发送 `thinking.type`。
- **能力声明**：GLM-V 系列才声明图片能力；缓存先保持未声明，待真实模型验证后再单独接入，避免误发缓存参数。


#### OpenAI 兼容（`gpt-4o`，OpenAI 格式）
- 通用路，无专门适配。任何 OpenAI 兼容端点的兜底选项。

---

### 5. 语音 / ASR 模型（独立角色，`VoiceSettings`）
- 与主模型**解耦**：把语音/音视频转成文字再交主模型，主模型不再被强切。
- 固定走 **OpenAI 兼容 `input_audio`**（chat + base64，纯 ASR 不传 thinking）；需 mimo 系（`mimo-v2.5-asr`）或 Qwen ASR。
- `model` 留空 = 未配置 → 收到语音咕咕回「不支持」。后台「Agent 配置」有独立语音模型卡。

---

### 6. 配置与保存（**防「保存了不生效」**）
- 配置面板：后台「Agent 配置」→ LLM 预设（`/admin/agent/llm-presets`）→ 落 `config.override.json` 的 `ai_presets`；激活时同步写 `ai`（当前段）。
- 预设字段：`provider / api_key / base_url / model / max_tokens / temperature / context_tokens / thinking / reasoning_effort / vision / api_format / in_pool`。
- **⚠️ 单一来源 `_AI_SYNC_KEYS` / `_ai_segment`**（`agent_admin.py`）：create/update/activate 三处同步到 `ai` 段的字段**收口成一处**——**漏一个字段 = active 模型拿不到 = 保存了不生效**（历史坑）。**加模型字段时只改这一处**。
- 嵌套配置段（smtp/voice）另有坑：见 [[gugu-config-apply-override]]（apply_override 顶层排除集要含新段）。

---

### 7. 加新模型 / 新字段 Checklist
**加新 provider**：① 前端 `PROVIDERS`（base_url/默认模型）；② 若需专门适配 → `llm_select` 加 `_is_xxx` + `core.py` 对应分支；③ 鉴权非标 → `*_default_headers`。
**加新模型字段**（如又一个 thinking 类旋钮）：① `config.py` 的 `AISettings` + `AIPresetItem`；② `agent_admin.py` 的 `PresetCreate` + `PresetUpdate` + create item dict + update 分支 + **`_AI_SYNC_KEYS`/`_AI_DEFAULTS`**；③ 前端 `editTarget` 初始化 + UI；④ `core.py` 消费处。**漏②的 `_AI_SYNC_KEYS` 是最常见的"保存了不生效"**。
