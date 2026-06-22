"""对话后反思：提炼值得长期记住的信息，增量写入 facts/daily。

复用 settings.ai 的 provider 做一次廉价非流式调用，产出 JSON：
  {"facts": ["新长期事实", ...], "daily": "一句话总结(可空)"}
由 web adapter 在对话结束后 fire-and-forget 调用，不阻塞 SSE、失败不影响主流程。
"""
from __future__ import annotations

import asyncio
import json
from datetime import datetime
from pathlib import Path

from agent.memory import store

# 保持后台任务引用，防止被 GC（fire-and-forget 必须）
_bg_tasks: set = set()

_PROMPTS_DIR = Path(__file__).parent.parent / "prompts"
# 文件缺失时的兜底（正常走 prompts/reflection.md，可热编辑 / Admin 在线改）
_SYS_FALLBACK = (
    "你在帮咕咕维护对用户的长期记忆。只记关于用户本人的稳定信息（身份/偏好/习惯），"
    "不记推测、世界常识、一时状态，不评判用户，宁少勿多、没有就返回空。"
    '严格只输出 JSON：{"facts": ["..."], "daily": "一句话总结(没有就空字符串)"}'
)


def _load_sys() -> str:
    """每次现读 reflection.md（热生效）；缺失则用兜底。"""
    try:
        return (_PROMPTS_DIR / "reflection.md").read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return _SYS_FALLBACK


def schedule(user_id, user_name, user_msg, assistant_reply, settings) -> None:
    """非阻塞触发一次反思。"""
    task = asyncio.create_task(
        reflect(user_id, user_name, user_msg, assistant_reply, settings)
    )
    _bg_tasks.add(task)
    task.add_done_callback(_bg_tasks.discard)


async def reflect(user_id, user_name, user_msg, assistant_reply, settings) -> None:
    try:
        existing = (await store.read_memory(user_id))["facts"]
        out = await _extract(user_name, user_msg, assistant_reply, existing, settings)
        new_facts = out.get("facts") or []
        daily_note = (out.get("daily") or "").strip()

        if new_facts:
            merged = store.merge_facts(existing, new_facts)
            if merged.strip() != existing.strip():
                await store.write_facts(user_id, merged)
        if daily_note:
            await store.append_daily(user_id, datetime.now().strftime("%Y-%m-%d"), daily_note)
    except Exception:
        pass  # 反思是锦上添花，任何失败都不能影响对话


async def _extract(user_name, user_msg, assistant_reply, existing_facts, settings) -> dict:
    user = (
        f"已知事实：\n{existing_facts or '（暂无）'}\n\n"
        f"本次对话：\n用户({user_name})：{user_msg}\n咕咕：{assistant_reply}\n\n请提炼。"
    )
    sys = _load_sys()
    use_anthropic = (
        settings.ai.provider == "minimax"
        or "anthropic" in settings.ai.base_url.lower()
    )
    text = (
        await _call_anthropic(sys, user, settings)
        if use_anthropic
        else await _call_openai(sys, user, settings)
    )
    return _parse_json(text)


async def _call_anthropic(sys: str, user: str, settings) -> str:
    import httpx
    from anthropic import AsyncAnthropic

    client = AsyncAnthropic(
        api_key=settings.ai.api_key or "dummy",
        base_url=settings.ai.base_url,
        http_client=httpx.AsyncClient(timeout=httpx.Timeout(connect=10.0, read=40.0, write=10.0, pool=5.0)),
    )
    resp = await client.messages.create(
        model=settings.ai.model,
        system=sys,
        messages=[{"role": "user", "content": user}],
        max_tokens=500,
        temperature=0.3,
    )
    return "".join(b.text for b in resp.content if getattr(b, "type", "") == "text")


async def _call_openai(sys: str, user: str, settings) -> str:
    import httpx
    from openai import AsyncOpenAI

    client = AsyncOpenAI(
        api_key=settings.ai.api_key or "dummy",
        base_url=settings.ai.base_url,
        timeout=httpx.Timeout(connect=10.0, read=40.0, write=10.0, pool=5.0),
    )
    resp = await client.chat.completions.create(
        model=settings.ai.model,
        messages=[{"role": "system", "content": sys}, {"role": "user", "content": user}],
        max_tokens=500,
        temperature=0.3,
    )
    return resp.choices[0].message.content or ""


def _parse_json(text: str) -> dict:
    """从模型输出里抠出 JSON 对象，容忍 ```json 围栏与前后杂字。"""
    if not text:
        return {}
    s = text.strip()
    if "```" in s:
        s = s.split("```")[1]
        if s.startswith("json"):
            s = s[4:]
    lo, hi = s.find("{"), s.rfind("}")
    if lo == -1 or hi == -1:
        return {}
    try:
        return json.loads(s[lo:hi + 1])
    except Exception:
        return {}
