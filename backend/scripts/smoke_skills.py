"""Prompt skills 系统 · 冒烟测试。

跑法：
    cd backend && .venv/bin/python scripts/smoke_skills.py   # 退出码 0=全绿，1=有失败

覆盖：
  · skills 加载器：frontmatter 解析、按 slug / name 取正文、未知返回 None
  · use_skill 工具：拉到正文 / 未知技能报 error（经真实 registry.dispatch）
  · http_get：SSRF 闸门（公网放行、私网/环回/链路本地拦截）+ 一次实网抓 wttr.in
  · builder：传 skills 才注入「## 可用技能」索引
  · profile 接线：DefaultProfile 启用 web/meta，tool_names 含 http_get/use_skill
"""
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # backend/ 入 path

import agent.tools  # noqa: F401  注册全部工具集（含 web/meta）
from agent.tools import registry
from agent.tools.web import _host_allowed
from agent import skills
from agent.context import builder
from agent.profiles.default import DefaultProfile

PASS, FAIL = [], []


def build_prompt(*args, **kwargs):
    static, dynamic, _ = builder.build_split(*args, **kwargs)
    return "\n\n---\n\n".join(part for part in (static, dynamic) if part)


def check(name, cond, extra=""):
    (PASS if cond else FAIL).append(name)
    print(f"  {'✅' if cond else '❌'} {name}" + (f"  [{extra}]" if extra and not cond else ""))


_UID = "00000000-0000-0000-0000-000000000000"


async def main():
    print("【1】skills 加载器")
    idx = skills.skills_index(["weather"])
    name = idx[0]["name"] if idx else ""
    check("skills_index 命中 weather", len(idx) == 1 and idx[0]["slug"] == "weather", str(idx))
    check("frontmatter name 解析", bool(name) and name != "weather", str(idx))
    check("frontmatter description→when 解析", idx and len(idx[0]["when"]) > 0, str(idx))
    check("load_skill by slug", (skills.load_skill("weather") or "").find("wttr.in") >= 0)
    check("load_skill by name", (skills.load_skill(name) or "").find("wttr.in") >= 0)
    check("load_skill 未知返回 None", skills.load_skill("不存在的技能") is None)

    print("【2】http_get · SSRF 闸门（纯逻辑，不联网）")
    check("公网 8.8.8.8 放行", _host_allowed("8.8.8.8") is True)
    check("环回 127.0.0.1 拦截", _host_allowed("127.0.0.1") is False)
    check("私网 192.168.110.50 拦截", _host_allowed("192.168.110.50") is False)
    check("链路本地 169.254.169.254 拦截", _host_allowed("169.254.169.254") is False)
    check("私网 10.x 拦截", _host_allowed("10.0.0.1") is False)

    print("【3】builder 注入「可用技能」索引")
    sp_on = build_prompt("default", "测试", [], [], {}, None, skills=["weather"])
    sp_off = build_prompt("default", "测试", [], [], {}, None)
    check("传 skills → 含『## 可用技能』", "## 可用技能" in sp_on)
    check("索引含 weather slug", "`weather`" in sp_on)
    check("不传 skills → 不注入", "## 可用技能" not in sp_off)

    print("【4】profile 接线")
    names = DefaultProfile().tool_names
    check("工具集启用 web/meta", "web" in DefaultProfile.tools and "meta" in DefaultProfile.tools)
    check("tool_names 含 http_get", "http_get" in names)
    check("tool_names 含 use_skill", "use_skill" in names)
    check("DefaultProfile.skills 含 weather", "weather" in DefaultProfile.skills)

    print("【5】use_skill 工具（真实 dispatch）")
    out, _ = await registry.dispatch(_UID, "use_skill", {"name": "weather"})
    check("use_skill 拉到正文", "wttr.in" in out)
    out2, _ = await registry.dispatch(_UID, "use_skill", {"name": "不存在"})
    check("use_skill 未知报 error", '"error"' in out2)

    print("【6】http_get 实网（抓 wttr.in；无外网时此项可能失败）")
    pub, _ = await registry.dispatch(_UID, "http_get", {"url": "https://wttr.in/Beijing?format=3"})
    pubd = json.loads(pub)
    check("http_get 抓到 200 + 内容", pubd.get("status") == 200 and bool(pubd.get("body")), pub[:120])
    # 中文城市 URL（技能正文用的就是 wttr.in/北京）——确认 http_get 处理非 ASCII URL
    cn, _ = await registry.dispatch(_UID, "http_get", {"url": "https://wttr.in/北京?format=3"})
    cnd = json.loads(cn)
    check("http_get 中文城市 URL", cnd.get("status") == 200 and bool(cnd.get("body")), cn[:120])
    bad, _ = await registry.dispatch(_UID, "http_get", {"url": "http://192.168.110.50:6379"})
    check("http_get 内网被拦", '"error"' in bad, bad[:120])

    print("【7】搜索工具：web_search(SearXNG) / deep_research(Tavily)")
    names = DefaultProfile().tool_names
    check("web_search 注册（SearXNG）", "web_search" in names)
    check("deep_research 注册（Tavily）", "deep_research" in names)
    check("news skill 已移除", "news" not in DefaultProfile.skills and skills.load_skill("news") is None)
    # web_search：配了 searxng_url 就实搜，没配则应给「改用 deep_research」的友好降级
    from app.core.config import get_settings
    ws, _ = await registry.dispatch(_UID, "web_search", {"query": "Vue3 文档"})
    wsd = ws if isinstance(ws, dict) else json.loads(ws)
    if get_settings().search.searxng_url:
        check("web_search 实搜有结果", bool(wsd.get("results")), str(wsd)[:120])
    else:
        check("web_search 未配置时友好降级到 deep_research", "deep_research" in (wsd.get("error", "")), str(wsd)[:120])

    print(f"\n结果：{len(PASS)} 通过 / {len(FAIL)} 失败")
    if FAIL:
        print("失败项：", FAIL)
    return 0 if not FAIL else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
