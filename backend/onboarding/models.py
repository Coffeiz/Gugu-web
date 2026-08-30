"""新手引导子系统自有数据表。

`OnboardingState`：一用户一行，状态存 JSON（字段随文案迭代增减、免逐字段迁移）。
**不改 User 模型** —— 子系统独立。用 app 的 Base，仅复用基础设施、不耦合业务。
"""
from datetime import datetime
from uuid import UUID

from sqlalchemy import ForeignKey, JSON, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.core.tz import now_utc
from app.db.base import Base
from app.db.types import UtcDateTime


def default_state() -> dict:
    """新用户的初始播种状态。"""
    return {
        "seeded": False,
        "seeded_project_id": None,
        "seeded_project_name": None,
        "guide_enabled": False,
        "guide_version": 1,
        "current_step": "locale",
        "completed_steps": [],
        "dismissed": False,
        "completed_at": None,
    }


class OnboardingState(Base):
    __tablename__ = "onboarding_state"

    user_id: Mapped[UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    state: Mapped[dict] = mapped_column(JSON, default=default_state)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=now_utc)
    updated_at: Mapped[datetime] = mapped_column(
        UtcDateTime, default=now_utc, onupdate=now_utc)
