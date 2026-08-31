"""注册播种：为新用户建引导项目（阶段/待办/2 文件）+ 个人空间一个 mp3「小惊喜」。

只依赖 app 的 model / storage，**不调用 agent**。幂等：以 onboarding 状态的 seeded 为闸门，
删项目/文件都不重建。文案/命名全静态随机（content.py）。
"""
import logging
import uuid
from datetime import date, timedelta
from pathlib import Path

from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Project, File, CalendarEvent
from app.services.storage import get_storage
from onboarding import content, state

logger = logging.getLogger("onboarding")

ASSETS_DIR = Path(__file__).parent / "assets"


def _human_size(n: int) -> str:
    for unit in ("B", "KB", "MB"):
        if n < 1024 or unit == "MB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n/1024:.1f} {unit}"
        n /= 1024
    return f"{n} B"


def _key(user_id, ext: str) -> str:
    return f"u/{user_id}/onboarding/{uuid.uuid4().hex}.{ext}"


async def _put_text_file(db, user_id, *, project_id, display_name, body: str) -> File:
    data = body.encode("utf-8")
    key = _key(user_id, "md")
    await get_storage().put(key, data, "text/markdown")
    f = File(user_id=user_id, display_name=display_name, ext="md", space="project",
             project_id=project_id, folder_id=None, stage_name="",
             storage_key=key, size=_human_size(len(data)), size_bytes=len(data),
             mime_type="text/markdown")
    db.add(f)
    return f


async def _put_surprise_mp3(db, user_id) -> File | None:
    """个人空间根目录放一个 mp3；素材取 onboarding/assets/ 下任意 .mp3，缺则跳过。"""
    mp3s = sorted(ASSETS_DIR.glob("*.mp3")) if ASSETS_DIR.is_dir() else []
    if not mp3s:
        logger.warning("onboarding: assets/ 下无 mp3，跳过「小惊喜」播种（其余照常）")
        return None
    src = mp3s[0]
    data = src.read_bytes()
    key = _key(user_id, "mp3")
    await get_storage().put(key, data, "audio/mpeg")
    f = File(user_id=user_id, display_name=src.stem, ext="mp3", space="personal",
             project_id=None, folder_id=None, stage_name="",
             storage_key=key, size=_human_size(len(data)), size_bytes=len(data),
             mime_type="audio/mpeg")
    db.add(f)
    return f


def _build_stages(seed_content: dict) -> tuple[list, str]:
    stages = []
    for i, (labels, todos) in enumerate(zip(seed_content["stage_labels"], seed_content["stage_todos"])):
        stages.append({
            "key": f"s{i}",
            "label": content.pick(labels),
            "todos": [{"id": f"s{i}t{j}", "text": t, "done": False}
                      for j, t in enumerate(todos)],
        })
    return stages, stages[0]["key"]


async def seed_for_user(db: AsyncSession, user, *, locale: str | None = None) -> None:
    """注册成功后调用（best-effort：失败不影响注册）。幂等。"""
    user_id = user.id
    try:
        st = await state.get_state(db, user_id)
        if st["seed"].get("seeded"):
            return

        # 1) 引导项目：日期＝初次登陆日 → 截止日 +3 天
        today = date.today()
        seed = content.seed_content(locale)
        name = content.pick(seed["project_names"])
        stages, current = _build_stages(seed)
        proj = Project(user_id=user_id, name=name, status="active", current_stage=current,
                       start_date=today.isoformat(),
                       deadline=(today + timedelta(days=3)).isoformat())
        proj.stages = stages
        db.add(proj)
        await db.flush()   # 拿 proj.id

        # 1b) 日历活动：初次登陆当天「和咕咕的第一天」（挂到引导项目）
        db.add(CalendarEvent(user_id=user_id, title=seed["calendar_title"],
                             date=today.isoformat(), type="event", project_id=proj.id))

        # 2) 两个文件（归属引导项目）
        wf = content.pick(seed["welcome_files"])
        await _put_text_file(db, user_id, project_id=proj.id,
                             display_name=wf["title"], body=wf["body"])
        await _put_text_file(db, user_id, project_id=proj.id,
                             display_name=seed["scratch_title"],
                             body=content.pick(seed["scratch_bodies"]))

        # 3) 个人空间 mp3「小惊喜」
        await _put_surprise_mp3(db, user_id)

        await db.commit()

        # 4) 回填状态
        await state.update_seed_state(db, user_id, {
            "seeded": True, "project_id": proj.id, "project_name": name,
        })
        await state.reset_guide_state(db, user_id)
        logger.info("onboarding: 已为用户 %s 播种引导项目 %s（%s）", user_id, proj.id, name)
    except Exception as e:
        logger.exception("onboarding: 播种失败（不影响注册）: %s", e)
        try:
            await db.rollback()
        except Exception:
            pass
