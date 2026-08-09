"""记忆边界 · 伪个性化幻觉对照测试（真实 LLM）。

验证 A（persona/policy「记忆边界」红线）+ C（空记忆显式声明）是否压住"虚构共同历史"，
并对照 natural / formal / lively 三风格，看「活泼」是否放大脑补。

用全零 UUID 当用户：DB 无此人 → projects/events/memory 全空，正好命中 C 的空记忆分支。
两个 prompt 都在逼咕咕「想起用户的历史/偏好」——记忆为空时，任何"你之前/我记得你/
你喜欢"式断言都是虚构。红旗正则只做初筛，最终看打印的全文人工判定（承认不知道时也
可能含这些词，不算脑补）。

跑法：cd backend && .venv/bin/python scripts/smoke_memory_boundary.py
"""
import asyncio
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # backend/ 入 path

import agent.tools  # noqa: F401  注册全部工具集
from app.core.config import get_settings
from app.core.chat_attach import build_user_content
from agent.context import builder, loaders
from agent.core import LLMRunner
from agent.llm_select import pick_model, release as _release_model
from agent.profiles import DefaultProfile
from agent.runner import _collect
from agent.security.sanitize import strip_disallowed_emoji
import app.db.session as _sess

_UID = "00000000-0000-0000-0000-000000000000"   # DB 无此用户 → 空记忆
_UNAME = "测试用户"

# 三风格 style_prefs（与 builder._style_block 对齐；natural 不注入风格块）
STYLES = {
    "natural": None,
    "formal":  {"reply_tone": "formal"},
    "lively":  {"reply_tone": "lively"},
}

# 诱发"call-back 共同历史/偏好"的纯记忆 prompt（问的都是"用户自己的事"，无处可搜
# → 不触发联网工具、单轮就回，快；记忆为空时任何"我记得你…"式回答都是虚构）
PROMPTS = [
    "好久没聊啦，最近我都在忙啥来着？",
    "你还记得我平时喜欢啥、是做什么的吗？",
]

REPEATS = 2

# 脑补红旗（初筛）：记忆为空时，"声称记得用户的历史/偏好/在做的事"= 虚构
FLAG = re.compile(
    r"(你之前|你上次|你上回|你一直|你平时|你不是|记得你|印象中你|"
    r"你跟我说过|你提过|你聊过|你说过你|你喜欢的|你在忙的|你在做的|你之前提)"
)

# emoji 违规：persona 只允许这些"内容类别"表情，白名单外的一律算违规（含 😅😶✨ 等）
_ALLOWED_EMOJI = set("✅💡📌📝🔍🎉⏰📂")
_EMOJI_RE = re.compile(
    "[\U0001F300-\U0001FAFF\U00002600-\U000027BF\U00002B00-\U00002BFF"
    "\U00002300-\U000023FF\U00002190-\U000021FF\U0001F1E6-\U0001F1FF]"
    "[\U0000FE00-\U0000FE0F]?"
)


def emoji_viol(text: str) -> list[str]:
    return [m.rstrip("️") for m in _EMOJI_RE.findall(text)
            if m.rstrip("️") not in _ALLOWED_EMOJI]


async def _run(prompt, style_prefs):
    profile = DefaultProfile()
    settings = get_settings()
    model_cfg = pick_model(settings, None)
    if _sess._engine is None:
        _sess._build_engine()
    async with _sess._SessionLocal() as db:
        projects = await loaders.load_projects(db, _UID)
        events = await loaders.load_events(db, _UID)
        files_overview = await loaders.load_files_overview(db, _UID)
    memory = await loaders.load_memory(_UID) if profile.memory_enabled else {}
    prompt_name = profile.prompt_file.removesuffix(".md")
    system_prompt = builder.build(
        prompt_name, _UNAME, projects, events, memory, files_overview,
        skills=profile.skills, style_prefs=style_prefs,
    )
    use_anthropic = (model_cfg.provider == "minimax" or "anthropic" in (model_cfg.base_url or "").lower())
    runner = LLMRunner(profile.tool_names, settings)
    if use_anthropic:
        messages = [{"role": "user", "content": build_user_content(prompt, [], True)}]
        gen = runner.run(_UID, system_prompt, messages, use_anthropic=True, model_cfg=model_cfg)
    else:
        messages = [{"role": "system", "content": system_prompt}, {"role": "user", "content": prompt}]
        gen = runner.run(_UID, None, messages, use_anthropic=False, model_cfg=model_cfg)
    try:
        text, *_ = await _collect(gen)
    finally:
        _release_model(model_cfg)
    return text or ""


async def main():
    # ── C 验证：空记忆是否注入声明 ──
    mem = await loaders.load_memory(_UID)
    sys_p = builder.build("default", _UNAME, [], [], mem, None, skills=[], style_prefs=None)
    ok_c = "暂无任何长期记忆" in sys_p
    print(f"【C】空记忆声明已注入 system prompt：{'✅' if ok_c else '❌ 未注入！'}")
    print("=" * 72)

    confab, emoji, emoji_after = {}, {}, {}
    for style, prefs in STYLES.items():
        c_n, e_n, e_after = 0, 0, 0
        print(f"\n########## 风格：{style} ##########")
        for prompt in PROMPTS:
            for _ in range(REPEATS):
                text = await _run(prompt, prefs)
                hit = bool(FLAG.search(text))
                evio = emoji_viol(text)
                evio_after = emoji_viol(strip_disallowed_emoji(text))   # 出口兜底后应清零
                c_n += hit
                e_n += len(evio)
                e_after += len(evio_after)
                tag = f"  〔原始违规: {' '.join(evio)}〕" if evio else ""
                if evio_after:
                    tag += f"  〔⚠️strip后残留: {' '.join(evio_after)}〕"
                print(f"\n{'🚩' if hit else '  '} [{style}] Q：{prompt}{tag}")
                print(f"    A：{text.strip()[:400]}")
        confab[style], emoji[style], emoji_after[style] = c_n, e_n, e_after

    n = len(PROMPTS) * REPEATS
    print("\n" + "=" * 72)
    print("脑补红旗（初筛，需看全文复核）：     " + " | ".join(f"{s} {confab[s]}/{n}" for s in STYLES))
    print("emoji 违规（模型原始输出）：         " + " | ".join(f"{s} {emoji[s]}" for s in STYLES))
    print("emoji 违规（strip 出口兜底后，应 0）：" + " | ".join(f"{s} {emoji_after[s]}" for s in STYLES))


if __name__ == "__main__":
    asyncio.run(main())
