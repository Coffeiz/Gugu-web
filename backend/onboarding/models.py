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
from onboarding.guide_state import default_guide_state, normalize_guide_state
from onboarding.seed_state import default_seed_state, normalize_seed_state


def default_state() -> dict:
    """同一行中分离保存播种状态和弹窗引导状态。"""
    return {
        "seed": default_seed_state(),
        "guide": default_guide_state(),
    }


def normalize_state(raw: dict | None) -> dict:
    """将旧扁平状态迁移为 seed/guide 两个命名空间，保留未知顶层字段。"""
    source = raw if isinstance(raw, dict) else {}
    if "seed" in source or "guide" in source:
        result = {**default_state(), **source}
        result["seed"] = normalize_seed_state(result.get("seed"))
        result["guide"] = normalize_guide_state(result.get("guide"))
        return result

    # 兼容 2026-08-31 之前已经写入的扁平状态；不把旧用户自动开启弹窗引导。
    seed = normalize_seed_state({
        "seeded": source.get("seeded", False),
        "project_id": source.get("seeded_project_id"),
        "project_name": source.get("seeded_project_name"),
    })
    guide = default_guide_state()
    return {**default_state(), **{key: value for key, value in source.items()
                                  if key not in {"seeded", "seeded_project_id", "seeded_project_name",
                                                 "guide_enabled", "guide_version", "current_step",
                                                 "completed_steps", "dismissed", "completed_at"}},
            "seed": seed,
            "guide": guide}


class OnboardingState(Base):
    __tablename__ = "onboarding_state"

    user_id: Mapped[UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    state: Mapped[dict] = mapped_column(JSON, default=default_state)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=now_utc)
    updated_at: Mapped[datetime] = mapped_column(
        UtcDateTime, default=now_utc, onupdate=now_utc)
