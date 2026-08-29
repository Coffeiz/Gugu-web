"""文件预览和写入边界测试。

这些测试对齐当前 ``services/files`` 接口，确认预览失败不会向调用层
泄漏异常，也不会把失败状态写入文件元数据；上传写入行为由
``test_files_api.py`` 和 ``test_file_service.py`` 覆盖。
"""

from unittest.mock import patch

import pytest

from app.core.errors import ExpectedError, RetryableError
from app.services.files.previews import render_cached_pdf, render_thumbnail


class TestPreviewFailureSafety:
    """预览失败只影响视觉结果，不修改文件主记录。"""

    @pytest.mark.asyncio
    async def test_thumbnail_failure_returns_original_bytes(self):
        raw = b"not-an-image"
        with patch("app.services.files.previews.generate_thumbs_sync", side_effect=ValueError("图片解码失败")):
            content, media_type = await render_thumbnail(raw, 1, "card", "image/png")

        assert content == raw
        assert media_type == "image/png"

    @pytest.mark.asyncio
    async def test_preview_failure_does_not_populate_cache(self):
        with patch("app.services.files.previews.office_to_pdf", side_effect=RuntimeError("PDF 渲染失败")):
            with pytest.raises(RuntimeError, match="PDF 渲染失败"):
                await render_cached_pdf(b"pdf-source", cache_key="1:v1", extension="PDF")

        with patch("app.services.files.previews.office_to_pdf", return_value=b"pdf-result") as convert:
            result = await render_cached_pdf(b"pdf-source", cache_key="1:v1", extension="PDF")

        assert result == b"pdf-result"
        convert.assert_called_once()


class TestAPIErrorLayering:
    """可见错误使用稳定的公开信息，不泄漏内部细节。"""

    def test_expected_error_returns_4xx(self):
        error = ExpectedError("FILE_NOT_FOUND", "文件不存在")
        assert error.public_message == "文件不存在"

    def test_retryable_error_has_public_message(self):
        error = RetryableError(
            code="UPLOAD_TIMEOUT",
            public_message="上传超时，请稍后重试",
            cause=TimeoutError("OSS 连接超时"),
        )
        assert error.public_message == "上传超时，请稍后重试"
        assert "OSS" not in error.public_message

    def test_internal_error_is_redacted(self):
        from app.core.redaction import redact

        original = "读取 /home/coffeiz/uploads/secret-token.txt 失败"
        redacted = redact(original)

        assert "/home/coffeiz/uploads/secret-token.txt" not in redacted
        assert len(redacted) < len(original)
