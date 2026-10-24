"""通用媒体准备：把图片 / 视频压到模型能收的形态，并封成各协议的内容块。

这一层做的是「与厂商无关」的媒体处理——能力判定、压缩转码、块构造。厂商专属的
行为（文件上传、原生格式集）留在各自 Provider 里，规格跟随 Provider。

子模块：
- `constants`：MIME 映射、视觉处理参数、Provider 媒体策略默认别名
- `gates`：当前模型能不能看图 / 听音 / 看视频，以及 Provider 媒体限制
- `images`：图片压缩与图片内容块
- `video`：视频探测 / 转码 / 缓存与视频内容块

调用方：
- `agent/chat/attachments.py`：聊天附件装配进本轮消息
- `agent/tools/media_reader.py`：文件库 read_file 读媒体
"""
from __future__ import annotations

from . import constants, gates, images, video
# 兼容导出：这几个符号在抽包前就是从 `agent.media` 直接取的（调用方按
# `from agent import media` → `media.image_ready(...)` 用），抽包后子模块路径
# 变了但调用点照旧，必须在这里保留同名出口，否则运行期 AttributeError。
from .gates import should_transcribe_audio
from .images import image_ready, strip_image_for_history

__all__ = [
    "constants", "gates", "images", "video",
    "image_ready", "strip_image_for_history", "should_transcribe_audio",
]
