"""Prompt skills 系统 · 冒烟测试。

跑法：
    cd backend && .venv/bin/python scripts/smoke/smoke_skills.py
    cd backend && .venv/bin/python scripts/smoke/smoke_skills.py --allow-real-network

覆盖：
  · skills 加载器：frontmatter 解析、按 slug / name 取正文、未知返回 None
  · use_skill 工具：拉到正文 / 未知技能报 error（经真实 registry.dispatch）
  · http_get：SSRF 闸门；真实外网抓取需显式传入 --allow-real-network
  · builder：默认注入全部内置 Skill 索引，空列表可显式关闭
  · 系统能力接线：注册表中的全部工具都可进入能力目录
"""
import argparse
import asyncio
import ipaddress
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # backend/ 入 path

import agent.tools  # noqa: F401  注册全部工具集（含 web/meta）
from agent.tools import registry
from agent import skills
from agent.context import builder
from agent.capabilities.defaults import all_system_tool_names
from app.core.url_security import is_blocked_ip

PASS, FAIL = [], []


def build_prompt(*args, **kwargs):
    static, dynamic, _ = builder.build_split(*args, **kwargs)
    return "\n\n---\n\n".join(part for part in (static, dynamic) if part)


def check(name, cond, extra=""):
    (PASS if cond else FAIL).append(name)
    print(f"  {'✅' if cond else '❌'} {name}" + (f"  [{extra}]" if extra and not cond else ""))


_UID = "00000000-0000-0000-0000-000000000000"


async def main(*, allow_real_network: bool):
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
    check("公网地址放行", not is_blocked_ip(ipaddress.ip_address("93.184.216.34")))
    check("环回地址拦截", is_blocked_ip(ipaddress.ip_address("127.0.0.1")))
    check("私网地址拦截", is_blocked_ip(ipaddress.ip_address("192.168.1.50")))
    check("链路本地地址拦截", is_blocked_ip(ipaddress.ip_address("169.254.169.254")))
    check("CGNAT 地址拦截", is_blocked_ip(ipaddress.ip_address("100.64.0.1")))

    print("【3】builder 注入「可用技能」索引")
    sp_on = build_prompt("default", "测试", [], [], {}, None, skills=["weather"])
    sp_off = build_prompt("default", "测试", [], [], {}, None, skills=[])
    check("传 skills → 含『## 可用技能』", "## 可用技能" in sp_on)
    check("索引含 weather slug", "`weather`" in sp_on)
    check("不传 skills → 不注入", "## 可用技能" not in sp_off)

    print("【4】系统能力接线")
    names = all_system_tool_names()
    check("tool_names 含 http_get", "http_get" in names)
    check("tool_names 含 use_skill", "use_skill" in names)
    check("tool_names 含 send_email", "send_email" in names)
    check("默认索引含 email", "`email`" in build_prompt("default", "测试", [], [], {}, None))

    print("【5】use_skill 工具（真实 dispatch）")
    out, _ = await registry.dispatch(_UID, "use_skill", {"name": "weather"})
    check("use_skill 拉到正文", "wttr.in" in out)
    out2, _ = await registry.dispatch(_UID, "use_skill", {"name": "不存在"})
    check("use_skill 未知报 error", '"error"' in out2)

    print("【6】http_get SSRF 拦截（不联网）")
    bad, _ = await registry.dispatch(_UID, "http_get", {"url": "http://192.168.1.50:6379"})
    check("http_get 内网被拦", '"error"' in bad, bad[:120])

    print("【7】搜索工具：web_search(SearXNG) / deep_research(Tavily)")
    names = all_system_tool_names()
    check("web_search 注册（SearXNG）", "web_search" in names)
    check("deep_research 注册（Tavily）", "deep_research" in names)
    check("news skill 已移除", skills.load_skill("news") is None)
    from app.core.config import get_settings
    if allow_real_network:
        print("已显式允许外网：执行真实 HTTP 与搜索检查")
        pub, _ = await registry.dispatch(_UID, "http_get", {"url": "https://wttr.in/Beijing?format=3"})
        pubd = json.loads(pub)
        check("http_get 抓到 200 + 内容", pubd.get("status") == 200 and bool(pubd.get("body")), pub[:120])
        cn, _ = await registry.dispatch(_UID, "http_get", {"url": "https://wttr.in/北京?format=3"})
        cnd = json.loads(cn)
        check("http_get 中文城市 URL", cnd.get("status") == 200 and bool(cnd.get("body")), cn[:120])
        ws, _ = await registry.dispatch(_UID, "web_search", {"query": "Vue3 文档"})
        wsd = ws if isinstance(ws, dict) else json.loads(ws)
        if get_settings().search.searxng_url:
            check("web_search 实搜有结果", bool(wsd.get("results")), str(wsd)[:120])
        else:
            check("web_search 未配置时友好降级到 deep_research", "deep_research" in (wsd.get("error", "")), str(wsd)[:120])
    elif not get_settings().search.searxng_url:
        ws, _ = await registry.dispatch(_UID, "web_search", {"query": "Vue3 文档"})
        wsd = ws if isinstance(ws, dict) else json.loads(ws)
        check("web_search 未配置时友好降级到 deep_research", "deep_research" in (wsd.get("error", "")), str(wsd)[:120])
    else:
        print("跳过真实搜索（需显式传入 --allow-real-network）")

    print(f"\n结果：{len(PASS)} 通过 / {len(FAIL)} 失败")
    if FAIL:
        print("失败项：", FAIL)
    return 0 if not FAIL else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="验证内置技能与工具接线")
    parser.add_argument(
        "--allow-real-network",
        action="store_true",
        help="允许访问 wttr.in 和已配置的搜索服务；默认仅运行本地检查",
    )
    args = parser.parse_args()
    sys.exit(asyncio.run(main(allow_real_network=args.allow_real_network)))
