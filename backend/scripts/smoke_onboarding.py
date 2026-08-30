"""新用户播种冒烟测试：建临时用户 → 播种 → 幂等 → 清理。

跑：在 backend/ 下 `.venv/bin/python scripts/smoke_onboarding.py`
不污染数据：用临时用户，结束删除（级联清掉项目/文件/事件/状态）。
"""
import asyncio
import os
import sys
import unicodedata
import uuid

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # backend/ 进 path

import app.models  # noqa: F401  注册所有表
import app.db.session as s
from sqlalchemy import delete, func, select
from app.models import User, Project, File, CalendarEvent
from onboarding import content, seed, state
from onboarding.models import OnboardingState

PASS = 0
FAIL = 0


def check(name, cond):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ✓ {name}")
    else:
        FAIL += 1
        print(f"  ✗ {name}")


def has_emoji(text: str) -> bool:
    return any(unicodedata.category(c) == "So" or ord(c) >= 0x1F300 for c in text)


async def _mk_user(db, tag):
    suf = uuid.uuid4().hex[:8]
    u = User(username=f"_smoke_{tag}_{suf}", email=f"_smoke_{tag}_{suf}@t.test",
             hashed_password="x", display_name="smoke")
    db.add(u)
    await db.flush()
    return u


async def _count(db, model, **w):
    stmt = select(func.count()).select_from(model)
    for k, v in w.items():
        stmt = stmt.where(getattr(model, k) == v)
    return (await db.execute(stmt)).scalar()


async def main():
    s._build_engine()
    async with s._SessionLocal() as db:
        u = await _mk_user(db, "new")     # 走引导的新用户
        await db.commit()
        uid = u.id
        try:
            print("== 内容池 ==")
            for locale in ("zh-CN", "ja-JP", "en-US"):
                data = content.seed_content(locale)
                check(f"{locale} 播种内容完整", len(data["project_names"]) == 3
                      and len(data["stage_labels"]) == 3 and len(data["stage_todos"]) == 3
                      and len(data["welcome_files"]) == 2)

            print("== 播种 ==")
            await seed.seed_for_user(db, u)
            st = await state.get_state(db, uid)
            pid = st["seeded_project_id"]
            check("seeded=True", st["seeded"] is True)
            check("有 seeded_project_id", bool(pid))
            p = await db.get(Project, pid)
            check("项目存在且名在池里", p is not None and p.name in content.PROJECT_NAMES)
            check("3 个阶段", p is not None and len(p.stages) == 3)
            check("有起止日期(deadline +3天)", bool(p and p.start_date and p.deadline))
            check("引导项目 2 个文件", await _count(db, File, project_id=pid) == 2)
            check("个人空间根目录 mp3(assets 有曲目时)",
                  await _count(db, File, user_id=uid, space="personal", ext="mp3") >= 1)
            check("日历活动已播种", await _count(db, CalendarEvent, project_id=pid) >= 1)

            print("== 幂等 ==")
            await seed.seed_for_user(db, u)
            check("再播种不重建(仍 1 个项目)", await _count(db, Project, user_id=uid) == 1)

        finally:
            for x in (uid,):
                await db.execute(delete(OnboardingState).where(OnboardingState.user_id == x))
                await db.execute(delete(File).where(File.user_id == x))
                await db.execute(delete(CalendarEvent).where(CalendarEvent.user_id == x))
                await db.execute(delete(Project).where(Project.user_id == x))
                uu = await db.get(User, x)
                if uu:
                    await db.delete(uu)
            await db.commit()
            print("== 已清理临时用户 ==")

    print(f"\n结果: {PASS} passed, {FAIL} failed")
    sys.exit(1 if FAIL else 0)


asyncio.run(main())
