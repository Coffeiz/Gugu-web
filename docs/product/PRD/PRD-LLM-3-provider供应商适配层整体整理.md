# Provider 供应商适配层整体整理 PRD

> 状态：🔲 待评估（主体重构仅完成现状摸底与方案设计，未开始实现；Phase 5/6 独立追加项已完成，见下）
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
| Phase 5（独立追加）：`read_file` 读取视频复用压缩 | ✅ 已完成（Phase 6 已重做） | 用户反馈"文件库里的视频太大读不了"排查发现：视频压缩只在"用户发视频给咕咕"（`chat_attach.py`）这条路径生效，`read_file` 读文件库已有视频（`file_readers.py`）完全没有压缩，超过 36MB 直接拒绝。跟 Phase 1-4 的大重构（`providers/` 目录化）相互独立，不依赖其完成即可先落地。详见第 1.1、2.5 节。 |
| Phase 6（独立追加）：`read_file` 视频读取改直接 ffmpeg 提取，不再整段压缩 | ✅ 已完成（Phase 8 已复审修复） | 外部 code review 指出 Phase 5 实现有 3 个问题：①超大视频整个读进内存，OSS 后端因 `stat()` 默认实现是 exists+get 还要多下载一遍；②复用的 `_compress_video` 目标码率是给"发送给 MiniMax"设计的（1080p 5Mbps），跟"读取只需要 1 帧画面+前 5 分钟音频"的真实需求不匹配，长视频低码率反而可能越压越大；③新增测试没有真正断言 `read_video` 的最终结果。修复方案见 FR-LLM-3-6。 |
| Phase 8（独立追加）：Code Review 复审发现的 1 个 P1 + 2 个 P2 | ✅ 已完成 | 复审 Phase 6 修复后发现：① P1 `OSSStorageBackend.stat()` 捕获的异常类型是错的——`head_object` 对象不存在时抛的是 `NotFound`，不是代码里 `except` 的 `NoSuchKey`，`stat()` 在真实 OSS 上会直接抛未处理异常，"不存在→None"的契约名不副实（测试自己 mock 的异常类型跟真实 SDK 行为不一致，测试全绿但语义是错的）；② P2 `download_to_file` 手写 `get_object` + `shutil.copyfileobj`，丢了 oss2 官方 `get_object_to_file` 自带的 `Content-Length` 一致性校验，网络异常若未以异常形式冒出来会静默留下截断文件；③ P2 视频"物化到磁盘"这一步没有独立的并发限制，`_FFMPEG_SEMAPHORE` 只限制 ffmpeg 子进程数，挡不住高并发时磁盘上堆积大量完整临时视频文件。三个都已修复，见 FR-LLM-3-6 Phase 8 小节。 |
| Phase 9（独立追加）：Code Review 三审发现的 1 个 P2 reliability | ✅ 已完成 | 复审 Phase 8 修复（改用 `get_object_to_file`）后指出：`get_object_to_file` 检测到"服务器声明 200MB、连接却提前 EOF 到 150MB"时抛的 `InconsistentError`（`status=-3`）没有被 `_oss_is_transient()` 的白名单覆盖（既不是 `RequestError` 也不 `>=500`），这类瞬时故障检测到了却不会走 `_oss_retry` 重试，白白浪费了这次改用 SDK 原生下载函数才具备的检测能力。已修复，见 FR-LLM-3-6 Phase 9 小节。 |

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

### 1.1 追加项：`read_file` 读取视频复用压缩（Phase 5，独立于本 PRD 主体重构）

用户反馈"想让咕咕读文件库里的一个视频，太大读不了"，排查发现视频压缩逻辑（`chat_attach.py` 的 `_probe_video`/`_compress_video`/`_should_compress_video`）只在**用户发视频给咕咕**这条路径接了进去；`agent/tools/file_readers.py` 的 `read_video`（`read_file` 工具读文件库已有视频时走这里）只做硬性大小检查（`MEDIA_READ_MAX_BYTES = 36MB`），超过直接拒绝，从未调用过压缩函数。查了本 PRD 全文，只讨论"发送"场景，没有提到"读取已有视频"这个场景——不是有意排除在范围外的产品决策，是技术遗漏。

这个修复不依赖 Phase 1-4 的 `providers/` 目录化重构（`_compress_video` 等函数当前就是不带 provider 参数的纯 ffmpeg 操作，可以直接被 `file_readers.py` 调用），所以单独作为 Phase 5 先落地，不用等大重构。详见 FR-LLM-3-5。

Phase 5 的实现（复用 `_compress_video` 整段压缩）被外部 code review 指出跟真实需求不匹配，已在 Phase 6 重做为直接 ffmpeg 抽取，详见 FR-LLM-3-6。

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

### FR-LLM-3-5：`read_file` 读取视频复用压缩（✅ 已完成，独立于 Phase 1-4；实现已被 Phase 6 取代，见 FR-LLM-3-6）

- `file_readers.py` 新增 `_load_video_bytes(file)`：物理大小 ≤ `MEDIA_READ_MAX_BYTES` 直接返回原始字节；超过则下载后调用 `chat_attach._compress_video` 压缩一次，压完仍超限才报错（"压缩后仍超出读取上限"）。
- 压缩产物固定是 mp4 容器（`_compress_video` 内部输出 `.out.mp4`），传给后续 `_extract_frame`/`_extract_audio` 的扩展名统一改成 `"mp4"`，不沿用原始扩展名（比如 `.mov`），避免 ffmpeg 按错误容器格式解析。
- 压缩产物不写回文件库、不落盘存储——只在这次 `read_file` 调用的生命周期内使用（提取一帧画面 + 转写音频），不改变存储里的原文件。
- `read_video` 改用 `_load_video_bytes`；`read_audio` 不受影响，继续用原来的 `_media_size_error`（音频没有类似的压缩手段，体积检查逻辑不变）。
- 不判断是否"值得压"（不调用 `_should_compress_video`）——进这条分支时已经确定超过读取上限，直接压缩，没有"超限但不需要压"的中间状态。

### FR-LLM-3-6：`read_file` 视频读取改直接 ffmpeg 提取，不再整段压缩（✅ 已完成，Phase 8 复审再修 3 处）

外部 code review 对 Phase 5 实现提出 3 个问题，逐条对应修复：

1. **P1/P2 大视频整段进内存 + OSS 双下载**：`_load_video_bytes()` 无论多大都先 `get()` 整个对象；`OSSStorageBackend` 没覆写 `stat()`，继承的默认实现是 `exists→整个 get()→len(...)`，等于一次读取要从 OSS 拉两遍。
   修复：
   - `OSSStorageBackend` 新增 `stat()` 覆写，改用元信息查询接口，不下载对象本体（Phase 8 修订：最初用的 `head_object`，复审发现这个方法抛的异常类型跟代码里 `except` 的对不上，改用 `get_object_meta`，见下）。
   - `StorageBackend` 新增 `local_path(key) -> Path | None`（默认 `None`）和 `download_to_file(key, dest)`（默认整读整写，小文件兜底）两个接口；`LocalStorageBackend.local_path` 返回真实路径（零拷贝）；`OSSStorageBackend.download_to_file` 流式下载到临时文件，不在内存里缓冲整个对象（Phase 8 修订：最初手写 `get_object` + `shutil.copyfileobj`，复审发现丢了 SDK 自带的一致性校验，改用 `get_object_to_file`，见下）。
2. **P2 复用的压缩参数不是为读取设计的**：`_compress_video` 固定压 1080p 5Mbps h264（目标是给 MiniMax 上传用，边界是 45MB base64/90MB mm_file），而 `read_video` 实际只需要第 1 秒附近一帧画面 + 前 300 秒音频；长视频低码率场景下反而可能压完更大，且要等一次完整转码（最长 180 秒 timeout）才知道白等。
   修复：彻底不再走"整段压缩"这条路。新增 `_materialize_video(file)`：本地存储直接用 `local_path()` 给的真实路径；远程存储用 `download_to_file()` 流式落一份临时文件。`_extract_frame`/`_extract_audio`/`_run_ffmpeg` 改成直接对这个磁盘文件跑 ffmpeg（`-ss 1s` 截一帧 + 前 300 秒转 wav），不再需要先生成一份完整的压缩视频。`MEDIA_READ_MAX_BYTES` 不再是视频读取的门禁（改用于 `read_audio`，音频转写仍需整段进内存）——视频大小上限交给 ffmpeg 处理磁盘文件，真正进 Python 内存的只有 ≤8MB 的画面帧和 ≤16MB 的音频。
3. **P2 测试没有真正验证 `read_video` 的最终结果**：原测试 mock 压缩产物后只断言 `_extract_frame`/`_extract_audio` 收到了参数，没检查 `read_video` 的返回值——而 fake audio 返回 `None` 加 `vision_ready=False` 时，真实代码路径其实会返回 `{"error": ...}`，测试没揭穿这一点。
   修复：`tests/test_file_readers.py` 重写为 `test_read_video_succeeds_via_direct_ffmpeg_extraction`（mock 音频转写返回真实文本，断言 `result["content"]` 真的包含转写结果）+ `test_read_video_downloads_remote_storage_to_temp_file`（断言远程存储走了 `download_to_file` 而不是 `get()`，且临时文件用完即删）。

未在本次范围内改动：`chat_attach._compress_video`（发送给 MiniMax 用，目标是"生成一份可用于上传的压缩视频"，跟 `read_video` "只抽取有限画面/音频"是不同目标，不适合共用同一段压缩逻辑；`read_video` 改造后不再依赖它，两条路径不再有代码重叠，也就没有需要维护的重复实现）。

**Phase 8 修订（外部 code review 复审又发现 1 个 P1 + 2 个 P2）**：

1. **P1 `OSSStorageBackend.stat()` 捕获了错误的异常类型**：`head_object` 是 HEAD 请求，oss2 官方文档写明对象不存在时抛 `NotFound`——而且 HEAD 返回 404 时 SDK 层面区分不了"对象不存在"还是"bucket 配错/不存在"；代码里却 `except oss_exc.NoSuchKey`（`NotFound` 的子类），根本捕获不到父类异常，真实 OSS 上对象不存在时 `stat()` 会直接抛出未处理异常，违反"不存在→None"的契约。测试之所以全绿，是因为测试自己手动 mock 成了 `raise NoSuchKey(...)`，模拟的不是 `head_object` 的真实行为——这正是"mock 测试全绿，但 mock 模拟的底层库语义本身错了"这类问题的典型案例。
   修复：改用 `bucket.get_object_meta(key)`（`GET ?objectMeta`）而不是 `head_object`——同样只取元信息不下载本体，但官方文档明确保证对象不存在时抛更精确的 `NoSuchKey`，跟这里的异常处理正好对上。
2. **P2 `download_to_file` 手写流式下载丢了长度一致性校验**：`get_object()` + `shutil.copyfileobj()` 确实解决了"整个读进内存"的问题，但 oss2 官方 `get_object_to_file()` 内部在已知 `Content-Length` 时会调用 `copyfileobj_and_verify()`，下载完成后校验实际字节数与声明长度是否一致，不一致抛 `InconsistentError`；手写版本没有这层保护——网络中断多数情况会抛异常触发 `_oss_retry` 重试，但如果底层出现"提前 EOF、没有以异常形式冒出来"的情况，会静默留下一份被截断的视频文件，表现为下游 ffmpeg 莫名其妙"读取失败"，而不是能被立刻定位的"存储下载失败"。
   修复：`download_to_file` 直接委托给 `bucket.get_object_to_file(key, filename)`，外面继续包 `_oss_retry` 复用现有的重试策略，不用自己另起一套。
3. **P2 视频"物化到磁盘"这一步没有独立的并发限制**：`_FFMPEG_SEMAPHORE=2` 只限制"同时跑的 ffmpeg 子进程数"，而 `_materialize_video` 对远程存储的下载发生在进 `_run_ffmpeg` 之前——20 个用户同时读 OSS 视频，可以先并发下载出 20 份完整临时视频（当时已经取消了视频读取的大小上限，一批 200MB 视频 10 个并发就是 2GB 临时盘），才轮到 2 个排队跑 ffmpeg。
   修复：新增独立的 `_VIDEO_READ_SEMAPHORE`，把"物化（含下载）+ 抽取"整个生命周期当一个临界区；刻意不复用 `_FFMPEG_SEMAPHORE` 包最外层——那样 `read_video` 先 acquire 一次、`_run_ffmpeg` 内部又对同一个 Semaphore 再 acquire 一次，等于嵌套等待同一把锁，反而抬高有效并发下限，必须用独立的 Semaphore 对象。

Phase 8 测试：`tests/test_p2b_io_retry.py` 的 OSS stat/download 测试改成 mock `get_object_meta`/`get_object_to_file`（而不是 `head_object`/`get_object`），新增 `test_oss_download_to_file_retries_on_transient_error` 验证复用了 `_oss_retry`；`tests/test_file_readers.py` 新增 `test_read_video_limits_concurrent_materialize_lifecycle`，用 6 个并发 `read_video` 调用 + 计数器验证同时处于"物化+抽取"临界区内的调用数不超过 2。全量测试 756 passed。

**Phase 9 修订（外部 code review 三审又发现 1 个 P2 reliability）**：

Phase 8 改用 `get_object_to_file` 的一个重要收益就是它能检测"服务器声明 200MB、连接却提前正常 EOF 到 150MB"这种此前手写实现完全无感的场景——但 `_oss_is_transient()` 的白名单没有覆盖这类故障对应的异常：`get_object_to_file` 内部 `copyfileobj_and_verify()` 发现实际读到的字节数与声明的 `Content-Length` 不一致时，抛的是 `oss2.exceptions.InconsistentError`，这个异常的 `status` 是特殊值 `-3`——既不是 `RequestError`（连接级错误），也不满足 `status >= 500`（HTTP 5xx），会被现有两条判断规则漏判为"不重试"。等于说 Phase 8 好不容易换来的检测能力，检测到故障后却直接放弃、不走 `_oss_retry` 的退避重试，而这类"提前 EOF"往往正是最适合自动恢复的瞬时故障（下一次请求很可能就正常了）。

修复：`_oss_is_transient()` 新增 `isinstance(e, oss_exc.InconsistentError)` 分支，视为瞬时故障纳入重试白名单。安全性上没有新增顾虑——`_oss_retry()` 的重试前提本来就是"幂等操作"，`get_object_to_file` 每次调用都以 `wb` 模式重新打开目标文件（覆盖写，不是追加），重试不会把上一次的半截内容和这一次的内容拼在一起。

测试：`tests/test_p2b_io_retry.py` 新增 `test_oss_download_to_file_retries_on_inconsistent_error`——第一次调用模拟"写入部分内容后抛 `InconsistentError`"，第二次成功，断言重试后最终文件内容是完整版本、不含第一次的残留数据。全量测试 757 passed。

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
- **Phase 5（已完成，实现已被 Phase 6 取代）**：`tests/test_file_readers.py` 新增/改造 3 个用例——超限视频下载后走压缩（`test_read_video_compresses_oversized_file`）、压缩后仍超限报错（`test_read_video_rejects_when_still_too_large_after_compress`）、`read_audio` 的原有行为不受影响（`test_media_reader_uses_physical_size_before_get` 改成测 `read_audio`）。后端全量测试 773 passed。
- **Phase 6（已完成）**：`tests/test_file_readers.py` 重写为直接断言 `read_video` 最终结果（`test_read_video_succeeds_via_direct_ffmpeg_extraction`）+ 远程存储走流式下载临时文件（`test_read_video_downloads_remote_storage_to_temp_file`），`_run_ffmpeg`/`_extract_frame`/`_extract_audio` 相关用例改为传入 `Path` 而非 `bytes`。`tests/test_p2b_io_retry.py` 新增 6 个用例覆盖 `OSSStorageBackend.stat()`（走 `head_object` 不下载）/`download_to_file()`（流式写盘）/`local_path()`（OSS 恒 `None`）与 `LocalStorageBackend.local_path()`（零拷贝真实路径）。后端全量测试 754 passed。

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
