"""文件写操作的安全边界测试。

覆盖重构方案 6.5 节待补齐项：
- 文件写操作的版本控制、事务协调和幂等规则
- 预览和缩略图失败不能破坏文件元数据和存储主记录
- API 错误分层规则（预期错误、冲突错误、内部诊断）
"""

import pytest
from unittest.mock import AsyncMock, patch, MagicMock
from datetime import datetime

from app.core.errors import ExpectedError, RetryableError
from app.services.files.previews import get_thumbnail, get_preview
from app.services.files.upload import confirm_upload


class TestPreviewFailureSafety:
    """预览和缩略图失败不能破坏文件元数据和存储主记录。"""

    @pytest.mark.asyncio
    async def test_thumbnail_failure_preserves_file_record(self, db_session, mock_storage):
        """缩略图生成失败时，文件记录和存储对象应保持完整。"""
        file_id = 1
        user_id = 1

        # 模拟缩略图生成失败（如图片损坏、格式不支持）
        with patch("app.services.files.previews.generate_thumbnail", side_effect=Exception("图片解码失败")):
            # 缩略图失败应被捕获，不应抛出异常到调用层
            result = await get_thumbnail(db_session, mock_storage, file_id, user_id)

            # 应返回 None 或降级方案，而不是抛异常
            assert result is None or result == b""

        # 验证文件记录未被修改
        from app.models import File
        from sqlalchemy import select
        file = (await db_session.execute(select(File).where(File.id == file_id))).scalar_one_or_none()
        assert file is not None
        assert file.deleted_at is None

    @pytest.mark.asyncio
    async def test_preview_failure_does_not_corrupt_metadata(self, db_session, mock_storage):
        """预览渲染失败时，文件元数据（大小、类型、存储路径）不应被篡改。"""
        file_id = 1
        user_id = 1
        original_size = 1024
        original_ext = "pdf"

        # 模拟 PDF 转换失败
        with patch("app.services.files.previews.convert_pdf", side_effect=RuntimeError("PDF 渲染超时")):
            with pytest.raises((ExpectedError, RuntimeError)):
                await get_preview(db_session, mock_storage, file_id, user_id)

        # 验证文件元数据未被修改
        from app.models import File
        from sqlalchemy import select
        file = (await db_session.execute(select(File).where(File.id == file_id))).scalar_one_or_none()
        assert file is not None
        assert file.size == original_size
        assert file.ext == original_ext


class TestUploadIdempotency:
    """上传确认的幂等性规则。"""

    @pytest.mark.asyncio
    async def test_confirm_upload_is_idempotent(self, db_session, mock_storage):
        """同一 storage_key 的重复确认应安全返回成功，不产生重复记录。"""
        user_id = 1
        folder_id = 1
        storage_key = "uploads/test-idempotent.pdf"
        display_name = "test-idempotent"
        ext = "pdf"
        size = 1024

        # 第一次确认
        file1 = await confirm_upload(
            db_session,
            mock_storage,
            user_id=user_id,
            folder_id=folder_id,
            storage_key=storage_key,
            display_name=display_name,
            ext=ext,
            size=size,
        )

        # 第二次确认（相同 storage_key）
        file2 = await confirm_upload(
            db_session,
            mock_storage,
            user_id=user_id,
            folder_id=folder_id,
            storage_key=storage_key,
            display_name=display_name,
            ext=ext,
            size=size,
        )

        # 应返回同一文件记录（幂等）
        assert file1.id == file2.id

    @pytest.mark.asyncio
    async def test_confirm_upload_with_different_key_creates_new_file(self, db_session, mock_storage):
        """不同的 storage_key 应创建不同的文件记录。"""
        user_id = 1
        folder_id = 1

        file1 = await confirm_upload(
            db_session,
            mock_storage,
            user_id=user_id,
            folder_id=folder_id,
            storage_key="uploads/file1.pdf",
            display_name="file1",
            ext="pdf",
            size=1024,
        )

        file2 = await confirm_upload(
            db_session,
            mock_storage,
            user_id=user_id,
            folder_id=folder_id,
            storage_key="uploads/file2.pdf",
            display_name="file2",
            ext="pdf",
            size=2048,
        )

        # 应创建两条不同的记录
        assert file1.id != file2.id


class TestAPIErrorLayering:
    """API 错误分层规则。"""

    @pytest.mark.asyncio
    async def test_expected_error_returns_4xx(self, db_session):
        """预期错误（用户可见）应映射为 4xx 状态码。"""
        error = ExpectedError("文件不存在", code="FILE_NOT_FOUND")
        assert error.http_status_code == 404 or error.http_status_code >= 400

    @pytest.mark.asyncio
    async def test_retryable_error_has_public_message(self):
        """可重试错误应有固定的公开消息，不泄露内部细节。"""
        error = RetryableError(
            code="UPLOAD_TIMEOUT",
            public_message="上传超时，请稍后重试",
            cause=TimeoutError("OSS 连接超时"),
        )
        assert error.public_message == "上传超时，请稍后重试"
        assert "OSS" not in error.public_message

    @pytest.mark.asyncio
    async def test_internal_error_is_redacted(self):
        """内部异常（如数据库错误）应走脱敏路径。"""
        from app.core.redaction import redact

        original = "duplicate key value violates unique constraint 'files_storage_key_key'"
        redacted = redact(original)

        # 脱敏后不应包含表名、约束名等敏感信息
        assert "files_storage_key_key" not in redacted
        assert len(redacted) < len(original)