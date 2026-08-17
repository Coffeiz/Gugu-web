"""Mind Canvas Agent 批处理的幂等请求记录。"""

from datetime import datetime
from uuid import UUID

from sqlalchemy import ForeignKey, Integer, String, Text, UniqueConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.core.tz import now_utc
from app.db.base import Base
from app.db.types import UtcDateTime


class MindCanvasBatchRequest(Base):
    """保存一次成功批处理的 payload 指纹和原始结果，供 request_id 安全重放。"""

    __tablename__ = "mind_canvas_batch_requests"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True,
    )
    canvas_id: Mapped[int] = mapped_column(
        ForeignKey("mind_maps.id", ondelete="CASCADE"), index=True,
    )
    request_id: Mapped[str] = mapped_column(String(120))
    payload_hash: Mapped[str] = mapped_column(String(64))
    result_json: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=now_utc)

    __table_args__ = (
        UniqueConstraint(
            "user_id", "canvas_id", "request_id",
            name="uq_mind_canvas_batch_request",
        ),
    )
