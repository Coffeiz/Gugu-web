# Provider 供应商适配层整体整理 PRD

> 状态：🔲 待评估（主体重构仅完成现状摸底与方案设计，未开始实现；Phase 5 独立追加项已完成，见下）
> 创建：2026-08-06
> 最近更新：2026-08-08
> 所属层：LLM / Provider 适配层
> 关联模块：`backend/agent/providers.py`、`backend/agent/llm_select.py`、`backend/agent/loop_drivers.py`、`backend/agent/sanitize.py`、`backend/agent/runner.py`、`backend/agent/gateway/web.py`、`backend/agent/greeting.py`、`backend/agent/memory/_llm.py`、`backend/app/core/chat_attach.py`、`backend/app/core/media_transcode.py`、`backend/app/api/v1/agent_admin.py`、`backend/app/api/v1/agent.py`
> 关联文档：[[【已完成】PRD-LLM-1-provider适配层重构与core瘦身.md]]；[[../../reports/TEST-LLM-MiniMax-M3-视频mm_file传输.md]]

---

## 0. 实施状态

| 阶段 | 状态 | 说明 |
|---|---|---|
| 现状摸底 | ✅ 已完成 | 确认 provider 适配代码散落在 **12 个文件**，涵盖对话层、媒体层、流式清洗、thinking 参数、缓存、鉴权、重试白名单、音频转码等多类 provider 专属逻辑。详见第 1 节。 |
| 方案设计 | ✅ 已完成 | 确定 `providers/` 目录化 + `ProviderAdapter` 从 dataclass 改类、同时承载对话层与媒体层 + 流式清洗/音频转码等能力位收拢。详见第 3 节。 |
| Phase 1：`providers/` 目录化（纯重构） | 🔲 待评估 | 把 `providers.py` 迁成 `providers/` 包，`ProviderAdapter` 改类 + 继承，行为不变。 |
| Phase 2：媒体层迁入适配器（纯重构） | 🔲 待评估 | 把 `chat_attach.py` 的视频探测/压缩/mm_file 上传迁进适配器，`chat_attach.py` 改调用 `adapter_for(ai)`。 |
| Phase 3：流式清洗/音频转码/鉴权等能力位收拢（纯重构） | 🔲 待评估 | 把 `sanitize.py` 的 MiniMax 清洗、`media_transcode.py` 的 mimo 音频白名单、`agent_admin.py` 的 `_mimo` 鉴权判断等收拢进适配器能力位。 |
| Phase 4：视频时长限制（行为变化） | 🔲 待评估 | 在 `MediaLimits` 加 `max_duration_s=120`，ffprobe 读 duration，超 2 分钟拒绝。 |
| Phase 5（独立追加）：`read_file` 读取视频复用聊天附件的原生视频理解能力 | ✅ 已完成（重新设计，见下） | 用户反馈"文件库里的视频太大读不了"排查发现：`read_file` 读文件库已有视频（`file_readers.py`）从未接入 `chat_attach.py` 已有的原生视频理解链路（探测→压缩→base64/mm_file→真正的 video content block），只做硬性大小检查，超过 36MB 直接拒绝。**Phase 6~9 曾走过一条错误路线**（把视频物化到磁盘、ffmpeg 截一帧代表画面 + 抽音频转写，用"图片+文字"近似替代原生视频理解）——产品目标一直是让支持视频理解的 LLM 直接看视频本身，不是把视频降级成单帧图片。该路线已被完整撤销，重新设计为抽取 `chat_attach.prepare_video_media()` 公共 helper，`read_file` 和聊天附件路径复用同一份压缩/大小判断/传输方式选择逻辑，视频最终仍以真正的 `video` content block 进入模型（详见第 1.1、FR-LLM-3-5 节）。 |

---

## 1. 背景与目标

### 背景

Gugu 后端接入了多家 LLM 供应商（Anthropic 原生、MiniMax、小米 MiMo、DeepSeek 等），provider 之间的差异目前由 `agent/providers.py` 的 `ProviderAdapter` dataclass 收拢「对话层」差异（API 格式 / 缓存能力 / 鉴权头 / 流式重试白名单）。但**这只是 provider 适配的一小部分**——媒体层、流式清洗、音频转码、thinking 参数、鉴权头等大量 provider 专属逻辑仍散落在 12 个文件里手写 `if minimax:` / `if mimo:` 判断。

顺着 MiniMax M3 大视频 mm_file 传输（见 [[../../reports/TEST-LLM-MiniMax-M3-视频mm_file传输.md]]）的实现，摸底确认了三个结构性问题：

1. **`ProviderAdapter` 是 `frozen dataclass`，字段全是纯函数/标量**，装不下有状态、有 IO 的媒体逻辑（async probe/compress/upload）。所以媒体差异只能被「挤」到外面手写 `if`。
2. **同一个供应商的完整适配被拆成多份**：MiniMax 的对话层在 `providers.py` 的 `_MINIMAX`，媒体层在 `chat_attach.py` 的 `_minimax_video_enabled` + `_upload_video_mmfile`，流式清洗在 `sanitize.py` 的 `StreamSanitizer(minimax=...)`。同一个供应商的知识不内聚。
3. **新增一个供应商要改多个文件**：`providers.py` 加注册表项 + `chat_attach.py` 加媒体判断 + `agent_admin.py` 加探测判断 + `sanitize.py` 加清洗标记 + 可能 `loop_drivers.py` 加 thinking 判断。违背了 `providers.py` docstring 自己说的「新增/修改 provider 差异点只改这一个文件」。

### 现状：provider 适配代码散落点（12 个文件）

| 文件 | 散落的 provider 专属逻辑 |
|---|---|
| `backend/agent/providers.py` | `ProviderAdapter` dataclass + `adapter_for()` 注册表（唯一收拢点，但只覆盖对话层） |
| `backend/agent/llm_select.py` | `_is_mimo`/`_is_deepseek`/`is_minimax`/`supports_*` 薄包装 |
| `backend/agent/loop_drivers.py` | `AnthropicDriver.prepare` 里 `_is_mimo(ai)` 判断 thinking 参数 |
| `backend/agent/sanitize.py` | `StreamSanitizer(minimax=...)`：MiniMax 流式泄漏标记（`]<]minimax`/`[e~[`）清洗 |
| `backend/agent/runner.py` | `is_minimax(model_cfg)` 决定流式清洗器（4 处 `StreamSanitizer(minimax=...)`） |
| `backend/agent/gateway/web.py` | `_is_mimo(settings.ai)` 判断标题/摘要的 thinking 参数 + `StreamSanitizer(minimax=...)` |
| `backend/agent/greeting.py` | `_is_mimo(ai)` + `use_anthropic_for(ai)` 判断 thinking |
| `backend/agent/memory/_llm.py` | `supports_thinking_toggle`：mimo/deepseek 的 JSON 模式 + thinking 参数 |
| `backend/app/core/chat_attach.py` | `_minimax_video_enabled` + 视频探测/压缩/mm_file 上传 + `MEDIA_RAW_MAX`（mimo base64 限制）+ `AUDIO_EXTS`（mimo 原生音频白名单） |
| `backend/app/core/media_transcode.py` | `_MIMO_AUDIO_EXTS`：mimo 原生音频格式白名单（与 `chat_attach.AUDIO_EXTS` 重复定义） |
| `backend/app/api/v1/agent_admin.py` | `_mimo` 手写判断（2 处，api-key 头）+ `_minimax_video_enabled` 视频探测 |
| `backend/app/api/v1/agent.py` | `to_mimo_mp3`：浏览器录音转码喂 mimo |

### 目标

- 把「这个 provider 该怎么打交道」的**全部知识**（对话层 + 媒体层 + 流式清洗 + 音频转码 + thinking + 缓存 + 鉴权 + 重试白名单）收拢进 `providers/` 目录，让每个供应商的完整适配内聚在一个模块。
- 新增视频时长限制：视频长度 >2 分钟直接拒绝（不压缩、不上传），时长限制按模型配置（有则用，无则兜底默认 2 分钟）。
- 压缩策略统一：分辨率 >1080p 或码率 >16Mbps → 压缩成 1080p 5M h264；最大视频大小 90MB。
- 保持 `llm_select.py` 的薄包装签名不变，12 个调用点一行不改。

### 1.1 追加项：`read_file` 读取视频复用聊天附件的原生视频理解能力（Phase 5，独立于本 PRD 主体重构）

用户反馈"想让咕咕读文件库里的一个视频，太大读不了"，排查发现视频理解能力（`chat_attach.py` 的探测/压缩/base64/mm_file 上传全链路）只在**用户发视频给咕咕**这条路径接了进去；`agent/tools/file_readers.py` 的 `read_video`（`read_file` 工具读文件库已有视频时走这里）只做硬性大小检查（`MEDIA_READ_MAX_BYTES = 36MB`），超过直接拒绝，从未接入过这条链路。查了本 PRD 全文，只讨论"发送"场景，没有提到"读取已有视频"这个场景——不是有意排除在范围外的产品决策，是技术遗漏。

**产品目标始终是**：让支持视频理解的 LLM 直接理解视频本身（真正的 `video` content block），不是把视频降级成单帧代表画面 + 音频转写这种近似方案。`read_file` 复用 `chat_attach.py` 已有的、经过实测验证的视频处理能力（ffprobe 探测 → 超 1080p/16Mbps 压缩 → 按大小选择 base64/Files API(mm_file)/拒绝），而不是重新设计一套。

**实施过程中的一段弯路（Phase 6~9，已完整撤销）**：最初实现（Phase 6）把这次修复理解成了"视频太大读不进内存"的纯工程问题，改成把视频物化到本地磁盘、用 ffmpeg 截一帧代表画面 + 抽前 5 分钟音频转写，经过 code review 三轮复审逐步修好了内存占用、OSS 双下载、并发磁盘堆积、重试可靠性等一系列工程问题（Phase 7/8/9），但这条路线本身背离了产品目标——"读到了内容"不等于"模型在原生理解视频"，代表帧漏掉时间线信息、音频转写漏掉画面信息，都不是可接受的替代品。经过明确指正后，Phase 6~9 新增的 `_materialize_video`/`_VIDEO_READ_SEMAPHORE`/`_extract_frame`/`_extract_audio`/`_run_ffmpeg` 等实现连同专门为它们新增的 `StorageBackend.local_path()`/`download_to_file()` 一并删除，`read_video` 重新设计为抽取 `chat_attach.prepare_video_media()` 公共 helper 并复用（详见 FR-LLM-3-5）。`OSSStorageBackend.stat()` 改用 `get_object_meta` 这一处优化被保留——它服务于仍然存在的 `read_audio` 物理大小检查，不是只为已删除的视频物化路径存在。

### 非目标

- **不拆 `loop_drivers.py`**：它是「循环控制流」（工具调用状态机、防幻觉守卫），不是「供应商适配」。它应**调用** `adapter_for(ai)` 拿能力位，但本身保持按 API 格式（Anthropic/OpenAI）拆。
- **不改 `llm_select.py` 的选模型逻辑**：它决定「选哪个模型」，`_is_mimo`/`is_minimax` 这些是给外部调用点的稳定签名，只改内部实现（委托 `adapter_for`），签名和导入路径不变。
- **不引入新依赖**：全部是内部代码搬迁 + ffprobe 读 duration 字段，不涉及新增包/服务/环境变量。

---

## 2. 功能需求

### FR-LLM-3-1：`providers/` 目录化，`ProviderAdapter` 改类（🔲 待评估）

- 把 `backend/agent/providers.py` 迁成 `backend/agent/providers/` 包：
  ```
  backend/agent/providers/
    __init__.py        # 统一入口：adapter_for(ai) → ProviderAdapter（保持现有签名）
    base.py            # ProviderAdapter 抽象基类 + MediaLimits + 共享探测/压缩/客户端构造工具
    anthropic.py       # 原生 Anthropic 默认适配器
    minimax.py         # MiniMax：对话层 + 媒体层（mm_file 上传、video 块、时长/大小限制）+ 流式清洗标记
    mimo.py            # 小米 MiMo：thinking 参数、api-key 头、video_url 块、音频白名单
    deepseek.py        # DeepSeek
    openai.py          # 其它 OpenAI 兼容厂商兜底
  ```
- `ProviderAdapter` 从 `frozen dataclass` 改成**类 + 继承**，每个供应商一个子类。
- `adapter_for(ai)` 签名不变，`from agent import providers` / `from agent.providers import adapter_for` 导入路径不变（`providers` 从模块变包，`__init__.py` 重导出）。
- 验收标准：`tests/test_providers.py`、`tests/test_stream_round_retry.py` 原样通过，行为字节级不变。

### FR-LLM-3-2：媒体层迁入适配器（🔲 待评估）

- `ProviderAdapter` 新增媒体层能力位与方法：
  ```python
  class ProviderAdapter(ABC):
      # ── 对话层（现有能力，原样保留）──
      name: str
      api_format: str
      def supports_active_cache(self, model): ...
      def supports_thinking_toggle(self): ...
      def auth_headers(self, ai): ...
      def transient_exceptions(self): ...
      # ── 媒体层（新增，收拢 chat_attach 的散落逻辑）──
      def supports_video(self, model): ...          # 取代 _minimax_video_enabled
      def supports_audio(self) -> bool: ...         # 取代 chat_attach 里硬编码的 _audio_enabled
      def video_limits(self) -> MediaLimits: ...    # 时长/大小/压缩阈值
      def audio_native_exts(self) -> set: ...       # 取代 chat_attach.AUDIO_EXTS / media_transcode._MIMO_AUDIO_EXTS
      def media_raw_max(self) -> int: ...           # 取代 chat_attach.MEDIA_RAW_MAX
      async def prepare_video(self, raw, name, ai): ...  # 探测→压缩→base64/mm_file
      def build_video_block(self, media_item): ...  # 取代 build_user_content 里的 if
      def build_audio_block(self, media_item): ...  # 取代 build_user_content 里的 if
  ```
- `MediaLimits` dataclass（放 `base.py`）：
  ```python
  @dataclass
  class MediaLimits:
      max_duration_s: int = 120          # 默认 2 分钟
      max_size_bytes: int = 90 * 1024 * 1024   # 默认 90MB
      compress_max_dim: int = 1920       # 1080p
      compress_bitrate: str = "5M"
      compress_trigger_bitrate: int = 16 * 1024 * 1024
      base64_max: int = 45 * 1024 * 1024
  ```
- `prepare_video` 是**模板方法**：探测 → 超限拒绝 → 压缩 → 按 size 决定 base64/mm_file。共享逻辑（探测/压缩/时长校验）写在基类，子类只覆写「大视频怎么传」（`_upload_large`）和「块怎么拼」（`build_video_block`）。
- `chat_attach.py` 的 `_minimax_video_enabled`/`_probe_video`/`_compress_video`/`_should_compress_video`/`_upload_video_mmfile`/`MEDIA_RAW_MAX`/`AUDIO_EXTS` 全部迁进 `base.py`（共享）或 `minimax.py`/`mimo.py`（供应商专属）。
- `chat_attach.py` 的 `resolve_for_message` 视频/音频分支和 `build_user_content` 块拼接，改成调用 `adapter_for(ai).prepare_video(...)` / `adapter_for(ai).build_video_block(...)` / `adapter_for(ai).build_audio_block(...)`。
- `media_transcode.py` 的 `_MIMO_AUDIO_EXTS` 迁进 `mimo.py`，函数 `to_mimo_mp3` 改成调用 `adapter_for(ai).audio_native_exts()`。
- `agent_admin.py` 的 `_do_vision_probe` 视频/音频探测判断，改成 `adapter_for(_ns).supports_video(model)` / `adapter_for(_ns).supports_audio()`。
- 验收标准：`tests/test_chat_attach_video.py` 原样通过（或仅改 import 路径），行为字节级不变。

### FR-LLM-3-3：流式清洗/鉴权/其他能力位收拢（🔲 待评估）

把 `sanitize.py`、`agent_admin.py`、各调用点里散落的 provider 专属判断收拢进适配器：

- **`stream_sanitize_markers(self) -> list[str]`**：MiniMax 适配器返回 `["]<]minimax", "[e~["]`，其它适配器返回 `[]`。`sanitize.StreamSanitizer.__init__` 改成接收 adapter 或 marker 列表，不再接收 `minimax: bool` 参数。
  - 调用点改造：`runner.py`（4 处）、`gateway/web.py`（2 处）改成 `StreamSanitizer(adapter=adapter_for(model_cfg))`，或更上层封装一个工厂函数 `make_stream_sanitizer(ai)`。
- **`auth_headers(self, ai)` 扩展**：mimo 的 `api-key` 头已经在 `ProviderAdapter` 里收口（PRD-LLM-1 已完成），本 FR 顺手把 `agent_admin.py` 里两处手写 `_mimo = provider == "mimo" or "xiaomimimo" in base_url` + `headers["api-key"] = api_key` 删掉，改成 `adapter_for(...).auth_headers(...)`。
- **`supports_thinking_toggle` 已收口**（PRD-LLM-1）：`loop_drivers.py`/`greeting.py`/`gateway/web.py`/`memory/_llm.py` 里用 `supports_thinking_toggle(ai)` 的地方保持原样（已是薄包装）。
- **`build_anthropic_client`/`build_openai_client` 已收口**（PRD-LLM-1 Phase 3）：调用点保持原样。
- 验收标准：`tests/test_stream_sanitize.py`、`tests/test_providers.py` 原样通过，行为字节级不变。

### FR-LLM-3-4：视频时长限制（🔲 待评估，行为变化）

- `_probe_video` 的 ffprobe 命令加读 `format=duration`（或 `stream=duration`），返回里加 `duration` 字段。
- `prepare_video` 模板方法里，探测后先判时长：`duration > limits.max_duration_s` → 直接拒绝（不压缩、不上传），返回「视频太长」的标记。
- 时长限制按模型配置：`model_cfg` 有 `video_max_duration` 字段则用，无则兜底 `MediaLimits.max_duration_s`（默认 120 秒）。
- 压缩不解决时长问题（MiniMax 对超长视频照样拒），所以超时长的视频**不压缩直接拒绝**。
- 验收标准：新增测试覆盖「超 2 分钟拒绝」「≤2 分钟正常处理」「模型配置覆盖默认值」。

### FR-LLM-3-5：`read_file` 读取视频复用聊天附件的原生视频理解能力（✅ 已完成，独立于 Phase 1-4）

**正确描述**（替换掉 Phase 6~9 走过的弯路描述）：`read_file` 读取视频时复用聊天附件已有的原生视频理解能力。视频仍作为完整的 `video` content block 提交给支持视频的 LLM；必要时先压缩，并按照 provider 的输入限制选择 base64、Files API（`mm_file://`）或明确拒绝。视频大小并不是"越大越能读"——超出当前 provider 支持范围时，`read_file` 应该明确告诉用户"这个视频超过当前模型支持的上限"，而不是想办法把任意大小的视频都"读出点什么"。

- **公共 helper**：`app/core/chat_attach.py` 新增 `prepare_video_media(raw, mime, name, model_cfg) -> dict`，把原来内联在 `resolve_for_message` 视频分支里的决策逻辑（MiniMax M3：探测→超限压缩→按大小选 base64/mm_file/拒绝；非 MiniMax：仅 ≤`MEDIA_RAW_MAX` 走 base64）抽成独立函数，返回值结构不变（`{"type":"video","mode":"base64"|"mm_file",...}`），失败统一抛 `ValueError`。同时新增 `video_media_to_anthropic_block(m) -> dict | None`，把该结构转成 Anthropic 原生 video content block，供 `build_user_content` 和 `read_video` 共用。
- **`resolve_for_message`**（聊天附件路径）视频分支改为直接调用 `prepare_video_media`，行为字节级不变（`tests/test_chat_attach_video.py` 里已有的 mm_file 成功/失败/超限/≤45MB 用例全部原样通过，因为它们本来就是通过 mock 模块级函数——`_probe_video`/`_should_compress_video`/`_compress_video`/`_upload_video_mmfile`/`_minimax_video_enabled`——间接验证的，这些函数原样保留，只是决策逻辑挪了个位置）；`build_user_content` 的 Anthropic 视频分支改为调用 `video_media_to_anthropic_block`。
- **`agent/tools/file_readers.py` 的 `read_video(file)`** 重新实现：
  1. 用 `agent.llm_select.use_anthropic_for(ai) and chat_attach._minimax_video_enabled(ai)` 判断当前模型是否具备"能在 tool_result 里塞原生 video block"的能力——目前只有 MiniMax M3 满足（OpenAI 格式的 tool_result 只能是纯文本，见下）。不满足直接返回"当前模型不支持通过文件库直接看视频"的明确错误，不读取文件、不做任何近似处理。
  2. 满足则用现有 `stat()` 判断文件是否存在，`get()` 读取完整原始字节（跟 `chat_attach.resolve_for_message` 读聊天附件视频时的做法一致——视频决策本身需要看到完整字节做探测/压缩，不是这次要解决的问题），调用 `chat_attach.prepare_video_media()` 得到媒体项，再用 `chat_attach.video_media_to_anthropic_block()` 转成真正的 video content block。
  3. `prepare_video_media` 抛出的 `ValueError`（超限/上传失败）原样把消息返回给用户；其余异常记 `diag_log` 后返回通用"视频读取失败"。
  4. 返回 `{"_video_media": block, "note": "已读取视频《...》。"}`——`_video_media` 是新增的 tool-result 特殊键，跟已有的 `_vision_image`（看图）走同一套机制。
- **`agent/tools/base.py` 的 `SkillRegistry.dispatch()`** 新增 `_video_media` 键处理，紧跟在已有的 `_vision_image` 分支之后：把 `note` 和 video block 拼成 `content` 列表原样塞进 `tool_result.content`，核心循环（`agent/loop_drivers.py` 的 `AnthropicDriver.append_tool_round`）不需要改动——它已经把 `res`（`dispatch()` 的返回值）直接放进 `tool_result.content`，Anthropic API 本来就接受字符串或内容块列表，video block 天然能塞进去。OpenAI 格式驱动的 tool 结果是纯文本，走不到这个分支。
- **不引入新协议扩展**：没有改 `tool_result` 的顶层结构，只是复用已有的"工具返回 dict 里的特殊键 → 转换成富内容块"机制（`_vision_image` 已经是先例），`_video_media` 是这个机制的第二个实例，不是新设计。
- `read_audio` 不受影响，继续用原来的 `_media_size_error`（`MEDIA_READ_MAX_BYTES = 36MB`）；音频理解和视频理解是两套完全独立的限制，不要混在一起判断。

**已删除的错误路线（Phase 6~9，完整撤销）**：最初把这次修复理解成"视频太大读不进内存"的纯工程问题，实现为把视频物化到磁盘（`_materialize_video`）、ffmpeg 截一帧代表画面（`_extract_frame`）+ 抽前 5 分钟音频转写（`_extract_audio`/`_run_ffmpeg`），用"图片 + ASR 文字"近似替代原生视频理解，返回给模型的是 `_vision_image`（单帧图片）或纯文字转写，从未是真正的 video block。经过三轮 code review 复审，这条路线在工程层面（内存占用、OSS 双下载、并发磁盘堆积、下载重试可靠性）被逐步修到很扎实，但产品语义从一开始就错了——已被明确指正并要求撤销。删除的代码：`_materialize_video`、`_VIDEO_READ_SEMAPHORE`、`_extract_frame`、`_extract_audio`、`_run_ffmpeg`、`_read_limited`、`_ffmpeg()`（`file_readers.py` 本地的 ffmpeg 查找，跟 `media_transcode.py` 的 `_ffmpeg_bin` 是两回事，后者仍在用于音频转码，未受影响）；`StorageBackend`/`LocalStorageBackend`/`OSSStorageBackend` 的 `local_path()`/`download_to_file()`（专为这条路线新增，全代码库无其他调用点）；`_oss_is_transient()` 里为 `download_to_file` 配套加的 `InconsistentError` 白名单分支（`download_to_file` 删了，这条也没有意义了）。**保留**：`OSSStorageBackend.stat()` 改用 `get_object_meta`（而非默认的 `exists+get`）这一处优化——它服务于仍然存在的 `read_audio` 物理大小检查（`_media_size_error`），不是只为已删除的视频路线存在，符合"已被其他明确需求使用就保留"的原则。

测试：`tests/test_file_readers.py` 整体重写——删除所有代表帧/ASR/物化生命周期/并发信号量相关用例，新增覆盖：MiniMax M3 返回真正的 `_video_media` block（`test_read_video_returns_native_video_block_for_minimax_m3`）、非 MiniMax M3 明确拒绝（`test_read_video_rejects_when_provider_not_minimax_m3`）、文件不存在、`prepare_video_media` 的 `ValueError` 原样透传、通用异常兜底。`tests/test_chat_attach_video.py` 新增 `prepare_video_media`/`video_media_to_anthropic_block` 的直接单测（MiniMax 小视频 base64、45~90MB mm_file 成功、mm_file 上传失败拒绝、>90MB 拒绝、非 MiniMax ≤36MB base64、非 MiniMax >36MB 拒绝），以及 `resolve_for_message` 的 mm_file 成功路径回归（此前只有失败路径有测试）；已有的 `resolve_for_message`/`build_user_content` 视频用例全部原样通过，验证聊天附件路径行为没有被这次重构改变。新增 `tests/test_p2b_io_retry.py` 的 `OSSStorageBackend.stat()` 用例保留（`get_object_meta`），删除 `download_to_file`/`local_path` 相关用例（对应实现已删除）。新增 `tests/test_tool_video_media_dispatch.py` 直接验证 `SkillRegistry.dispatch()` 对 `_video_media` 键的处理。全量测试 779 passed。

**Phase 5 二次修订（外部 code review 复审又发现 4 个逻辑问题，均在 `prepare_video_media` 内最小修改，未恢复任何 Phase 6~9 基础设施）**：

1. **P1 720p 不放大实际没有可靠实现**：`_compress_video` 原来始终拼一段固定的 `-vf scale=1920:1920:force_original_aspect_ratio=decrease,...` 滤镜，"不放大"这件事完全依赖 ffmpeg `scale` 滤镜 `decrease` 模式的隐式语义（"目标框只用来限制上限，输入已经小于目标时原样通过"）——只检查命令行里出现 `force_original_aspect_ratio=decrease` 字样，并不能证明分辨率真的没被改变。修复：`_compress_video` 新增 `probe` 参数，由**调用方基于真实探测结果显式决定**要不要缩——只有 `probe` 里的长边确实 >1080p 才拼 `-vf scale=...`，≤1080p（比如因体积过大触发转码的 720p 视频）完全不传 `-vf`，ffmpeg 原样保留输入分辨率。这样"720p 保持 720p、2K/4K 才降到 1080p"是由 Python 代码里的显式条件判断保证的，不是靠信任 ffmpeg CLI 参数的隐式行为。
2. **P1 120 秒硬限制不可靠**：`_probe_video` 原来只读视频流（`stream`）层的 `duration` 字段，但不少容器（尤其某些 mov/mp4 变体）只把 `duration` 记在 `format` 层，流层没有这个字段——这类视频的探测结果会变成 0 秒，`>=120 秒直接拒绝`这条规则形同虚设。修复：ffprobe 命令同时问 `format=duration` 和 `stream=...,duration`，流层缺失时退回 format 层（`stream_duration or format_duration`）。另外，源文件处理上限（>500MB / >=120秒）挪到 `prepare_video_media` 最前面、**provider 分支之前**统一判断——这是"服务器愿不愿意尝试处理"这一层的产品限制，跟 provider 是谁无关；原来只在 MiniMax 分支里判断，非 MiniMax provider 完全不受这条限制约束，跟"这是全视频产品限制"的定位矛盾。
3. **P2 >500MB 应该在读完整字节前拒绝**：`read_video`（`agent/tools/file_readers.py`）和 `resolve_for_message`（`app/core/chat_attach.py`）原来都是先把整个文件读进内存，再交给 `prepare_video_media` 判断大小——`read_file` 已经有 `stat()` 拿到的物理大小、聊天附件已经有暂存元数据里的 `meta["size"]`，没必要为了一个注定要拒绝的 500MB+ 视频先申请等量内存。修复：两个入口都在读字节之前先用已有的大小信息做一次前置判断，超限直接返回错误，不调用 `get()`/`read_bytes()`。`prepare_video_media` 内部的检查作为第二道防线保留（防御性，不依赖调用方一定做了前置检查）。
4. **P2 转码失败不能静默使用原视频**：原来 `if _should_compress_video(...): compressed = await _compress_video(raw); if compressed: payload = compressed`——转码失败（`_compress_video` 返回 `None`，比如 ffmpeg 崩溃/未安装）时 `payload` 保持是未转码的原始字节，代码会继续拿这份原始数据去走 base64/mm_file，等于一个规则要求"必须先降到 1080p"的 2K 视频，在转码失败时反而原样把 2K 字节喂给模型，完全违反规则却没有任何提示。修复：转码失败直接 `raise ValueError("这条视频转码失败，没法直接看")`，不再有"转码失败但继续用原视频"这条隐藏路径。

测试：`_compress_video` 相关测试改为显式传入 `probe`（`test_compress_video_720p_keeps_original_resolution_no_upscale` 断言 720p 探测结果下命令里完全没有 `-vf`；`test_compress_video_2k_downscales_to_1080p` 断言 2K 探测结果下才出现缩放滤镜；`test_compress_video_no_probe_keeps_original_resolution` 覆盖探测失败时保守不缩）；`_probe_video` 新增 `test_probe_video_falls_back_to_format_duration_when_stream_missing`/`test_probe_video_duration_takes_the_longer_of_stream_and_format`；`prepare_video_media` 新增 `test_prepare_video_media_transcode_failure_does_not_silently_use_original`（转码失败必须拒绝）、`test_prepare_video_media_source_limits_apply_to_non_minimax_too`（非 MiniMax provider 也受 120 秒限制约束）；`read_video`/`resolve_for_message` 各新增一个"超过 500MB 时不读取完整字节"的前置拒绝测试。全量测试 837 passed。

**Phase 5 三次修订（外部 code review 复审又发现 1 个 P2）**：`_probe_video` 合并 stream/format 两层 duration 原来用 `stream_duration or format_duration`——"整段视频不能超过 2 分钟"这条硬限制应该按更长的估计值判断，`or`（谁先非零用谁）会在 stream 层元数据不完整（比如只有 10 秒）而 format 层是真实的 125 秒时误判成"没超"，放过一个实际超限的视频；改成 `max(stream_duration, format_duration)`。另外，`prepare_video_media` 原来 `duration = (probe or {}).get("duration") or 0` 后直接跟 120 比较——ffprobe 彻底失败、或两层都拿不到 duration 时 `duration` 会是 0，直接拿 0 去跟 120 比较会误判成"远没超限"而放行，等于让一条硬限制在探测失败时开着口子（fail-open）。改成"确认不了时长就直接拒绝"（fail-closed）：`if not duration: raise ValueError("无法确认视频时长，没法直接看")`，只有明确拿到非零 duration 才进入 `>=120` 的正常比较。新增测试 `test_probe_video_duration_takes_the_longer_of_stream_and_format`（原 `test_probe_video_prefers_stream_duration_over_format` 断言方向反了，重命名并改断言）、`test_prepare_video_media_rejects_when_duration_cannot_be_determined`。全量测试 837 passed。

---

## 3. 技术方案

### 3.1 `providers/` 目录结构

```
backend/agent/providers/
  __init__.py        # adapter_for(ai) + 注册表 + 重导出
  base.py            # ProviderAdapter 抽象基类 + MediaLimits + 共享探测/压缩/客户端构造工具
  anthropic.py       # AnthropicAdapter（默认）
  minimax.py         # MiniMaxAdapter（mm_file 上传、video 块、时长/大小限制、流式清洗标记）
  mimo.py            # MiMoAdapter（thinking 参数、api-key 头、video_url 块、音频白名单）
  deepseek.py        # DeepSeekAdapter
  openai.py          # OpenAIDefaultAdapter（其它 OpenAI 兼容厂商兜底）
```

### 3.2 关键设计决策

1. **`ProviderAdapter` 从 dataclass 改类**：因为媒体层需要 async 方法（`prepare_video`）和有状态配置（`MediaLimits`），`frozen dataclass` 装不下。改成类 + 继承后，每个供应商子类可以覆写媒体层方法、清洗标记、音频白名单等能力位。
2. **`prepare_video` 是模板方法**：探测/压缩/时长校验这些共享逻辑写在基类，子类只覆写「大视频怎么传」（`_upload_large`）和「块怎么拼」（`build_video_block`）。这样「压缩策略相同」自然满足，不会在每家 provider 里复制 ffmpeg 代码。
3. **流式清洗标记收进适配器**：`sanitize.py` 的 `_MINIMAX_TRUNCATE_MARKERS` 迁进 `minimax.py` 的 `stream_sanitize_markers` 方法，`StreamSanitizer.__init__` 改成接收 adapter 引用（`self._markers = adapter.stream_sanitize_markers()`），不再硬编码 MiniMax。这样未来如果其它 provider 也出现类似泄漏标记，只需在那个 provider 的适配器里加 marker 列表，不用改 `sanitize.py`。
4. **音频白名单收进适配器**：`chat_attach.AUDIO_EXTS` 和 `media_transcode._MIMO_AUDIO_EXTS` 是同一份知识的重复定义（`{"mp3", "wav", "flac", "m4a", "ogg"}`），统一迁进 `mimo.py` 的 `audio_native_exts()` 方法。`media_transcode.to_mimo_mp3` 改成接收 ai 参数（duck type），内部调用 `adapter_for(ai).audio_native_exts()`。
5. **鉴权头去重**：`agent_admin.py` 里两处手写 `_mimo = provider == "mimo" or "xiaomimimo" in base_url` + `headers["api-key"] = api_key` 删掉，改成 `adapter_for(...).auth_headers(...)` 单行调用。重复定义会随供应商增减漂移（mimo 新增一个 base_url 关键字时容易漏改一处），收口后只需改 `providers/mimo.py` 一处。
6. **`loop_drivers.py` 不拆**：它是「循环控制流」，不是「供应商适配」。它应**调用** `adapter_for(ai)` 拿能力位（如 `supports_thinking_toggle`），但本身保持按 API 格式拆。
7. **`llm_select.py` 薄包装保留**：`_is_mimo`/`is_minimax` 等签名不变，内部从 `providers.adapter_for` 换成 `providers.adapter_for`（路径不变，因为 `providers` 从模块变包）。12 个调用点一行不改。

### 3.3 数据与日志注意事项

- 视频探测/压缩涉及 ffprobe/ffmpeg 子进程，`prepare_video` 失败时返回 `None`（调用方退文字提示），不抛异常掩盖。
- mm_file 上传涉及 MiniMax Files API，`_upload_large` 失败时返回 `None`，调用方明确拒绝（不回退 base64，避免生成注定超限的字符串）。
- 不新增可见日志；视频内容/文件名不写入日志（沿用 `agent/logsafe.py` 的 `fingerprint()` 约定）。
- 流式清洗标记（`]<]minimax`/`[e~[`）目前硬编码在 `sanitize.py` 模块级常量，迁进适配器后仍是模块级常量（在 `minimax.py` 顶部），仅是归属模块变了，行为不变。

---

## 4. 验证与上线

### 单元测试

- 新增：`tests/test_providers_media.py`（覆盖 `supports_video`/`supports_audio`/`video_limits`/`audio_native_exts`/`media_raw_max`/`prepare_video` 模板方法/`build_video_block`/`build_audio_block`）、`tests/test_video_duration_limit.py`（覆盖时长限制）、`tests/test_providers_sanitize.py`（覆盖 `stream_sanitize_markers` 各适配器返回值）。
- 回归：`tests/test_providers.py`、`tests/test_stream_round_retry.py`、`tests/test_chat_attach_video.py`、`tests/test_stream_sanitize.py`、`tests/test_llm_cache_capability.py` 全部应零改动通过（或仅改 import 路径）。
- 全量 `cd backend && PYTHONPATH=. .venv/bin/pytest` 兜底跑一遍。
- **Phase 5（已完成，最终设计，详见 FR-LLM-3-5）**：`read_file` 复用 `chat_attach.prepare_video_media()`，`read_video` 最终产出真正的 video content block（`_video_media` tool-result 特殊键），不是代表帧/ASR 转写。`tests/test_file_readers.py` 整体重写、`tests/test_chat_attach_video.py` 新增 `prepare_video_media`/`video_media_to_anthropic_block` 单测 + mm_file 成功路径回归、`tests/test_tool_video_media_dispatch.py` 新增验证 dispatch 层 `_video_media` 处理。后端全量测试 779 passed。（此前 Phase 6~9 走过一条"物化到磁盘+代表帧+ASR"的错误路线，已完整撤销，不再赘述其测试记录。）

### 部署与灰度

- **Phase 1/2/3（纯重构）**：单阶段直接上，风险低，`git revert` 单个 commit 可回滚。
- **Phase 4（时长限制）**：行为变化，需在 devserver 人工验证后上。

### 上线后要盯的点

- devserver 上发一个 >2 分钟的视频，确认被拒绝（提示「视频太长」），不触发压缩/上传。
- devserver 上发一个 ≤2 分钟但 >45MB 的视频，确认走 mm_file 上传成功。
- 后台「测试连接」的视频探测（`agent_admin.py`）对 MiniMax M3 仍返回「原生支持视频块 ✅」。
- MiniMax 连续对话中翻查流式输出，确认 `]<]minimax`/`[e~[` 泄漏标记清洗仍生效（`StreamSanitizer` 改造后没误伤）。
- 小米 MiMo 发一条语音，确认音频转码（`to_mimo_mp3`）仍正常（`audio_native_exts` 收口后没改坏）。

---

## 5. 风险与待确认问题

| 风险 | 影响 | 对策 |
|---|---|---|
| `ProviderAdapter` 从 dataclass 改类后，现有 `frozen` 语义丢失（不可变保证） | 低——适配器实例是单例注册表，无并发修改场景 | 用 `@dataclass(frozen=True)` 保留不可变，媒体层方法用 `@property`/方法而非可变字段 |
| `providers.py` 变 `providers/` 包后，`from agent import providers` 的导入路径 | 低——`__init__.py` 重导出即可保持 | Phase 1 先做目录化，跑全量测试确认零回归再进 Phase 2 |
| 视频时长限制的 ffprobe `duration` 读取对某些容器（如 mov 无 duration 元数据）可能为 0 | 中——`duration=0` 会被误判为超长或正常 | 探测失败/无 duration 时**不拒绝**（保守放行），只对明确读到 `duration > max` 才拒绝 |
| 压缩策略「统一」但各家 `build_video_block` 格式不同（`video_url` vs `video`+`mm_file://`） | 低——块格式是 provider 差异，本就该在子类覆写 | `build_video_block` 是抽象方法，每家实现自己的块格式 |
| `StreamSanitizer` 从 `minimax: bool` 改成 adapter 引用后，非 MiniMax 模型可能被误加清洗标记 | 低——`stream_sanitize_markers()` 默认返回 `[]`，只有 MiniMax 适配器返回非空 | 基类默认返回 `[]`，子类覆写；`tests/test_stream_sanitize.py` 已有「非 MiniMax 不保留前缀」的断言 |
| `media_transcode.to_mimo_mp3` 改成接收 ai 参数后，调用点（`agent.py`/`media_ingress.py`/`media_ingress_feishu.py`）需要传 ai | 中——调用点可能没有现成的 ai 对象 | 用 duck type：`to_mimo_mp3(data, ext, ct, ai=None)`，`ai=None` 时退回 `settings.ai`；或保留 `to_mimo_mp3` 签名不变，内部用 `settings.ai` 判 `audio_native_exts()` |
| `agent_admin.py` 删掉手写 `_mimo` 判断后，鉴权头行为可能跟现状不一致 | 低——`adapter_for(...).auth_headers(...)` 已收口（PRD-LLM-1），行为一致 | 用 `tests/test_providers.py` 的 `auth_headers` 断言兜底，改完跑全量测试 |

**待确认问题**：

- 🔲 视频时长限制的配置字段名：`video_max_duration` 是否合适？还是用 `video_max_duration_s` 更明确？—— 倾向 `video_max_duration_s`（带单位，避免歧义）。
- 🔲 超 2 分钟的视频是「直接拒绝」还是「提示用户裁剪后重发」？—— 倾向直接拒绝 + 提示「视频超过 2 分钟，请裁剪后重发」，不自动裁剪（裁剪会改变内容语义，且 ffmpeg 裁剪有精度问题）。
- 🔲 `MediaLimits` 的默认值是否要暴露到后台配置（`agent_admin.py`）？—— 本期倾向硬编码默认值，不做后台配置项，避免扩大改动面。
- 🔲 `media_transcode.to_mimo_mp3` 的签名改造方式：加 `ai` 参数（duck type）还是保留签名、内部用 `settings.ai`？—— 倾向加 `ai=None` 参数，`None` 时退回 `settings.ai`，避免 `media_ingress.py` 等调用点拿不到 ai 对象。
