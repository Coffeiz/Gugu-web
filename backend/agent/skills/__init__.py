"""Prompt skills 加载层（渐进式按需披露）。

每个 skill 一个 `.md`：frontmatter（`name` / `when`）+ 正文（做法说明，可指挥模型调若干 tool）。
- `skills_index(names)` → `[{slug, name, when}]`，供 builder 注入「可用技能」索引（只放一行触发条件）。
- `load_skill(key)`   → 正文（去掉 frontmatter），供 `use_skill` 工具按名拉取。

与 `agent/tools/`（函数调用工具）的关系：skill 是「带触发条件的剧本」，跑在 tool 之上。
依赖单向：tools（use_skill）→ skills（本模块）。

不缓存：每次现读目录里的几个 .md（开销极小），改 skill 内容**无需重启**即生效。

⚠️ 约定：**每新增一个 skill，记得在 `prompts/skills.md` 补一条「主动指针」**
（「用户什么场景 → `use_skill X`」）——别只靠 builder 自动注入的索引；指针写在常驻准则里
能强化触发（尤其需要主动留意的场景）。现有 7 个：weather / project-planning /
scheduled-tasks / im-bind / web-search / file-ops / note-writing，skills.md 都有对应指针。
"""
from __future__ import annotations

from pathlib import Path

_DIR = Path(__file__).parent


def _parse(text: str) -> tuple[dict, str]:
    """拆 frontmatter（--- 包裹的 key: value）与正文。无 frontmatter 时 meta 为空。"""
    meta: dict[str, str] = {}
    body = text
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
            fm = text[3:end]
            body = text[end + 4:].lstrip("\n")
            for line in fm.splitlines():
                if ":" in line:
                    k, v = line.split(":", 1)
                    meta[k.strip()] = v.strip()
    return meta, body


def _load_all() -> dict[str, dict]:
    out: dict[str, dict] = {}
    for p in sorted(_DIR.glob("*.md")):
        try:
            meta, body = _parse(p.read_text(encoding="utf-8"))
        except Exception:
            continue
        slug = p.stem
        def _clean(v: str) -> str:
            return (v or "").strip().strip('"').strip("'")
        # 触发文案：兼容 description（Claude Code 风格）与 when（早期风格）；
        # emoji 可能嵌在 metadata: 下（扁平解析仍能取到 emoji 行）
        out[slug] = {
            "slug": slug,
            "name": _clean(meta.get("name", slug)),
            "when": _clean(meta.get("description") or meta.get("when")),
            "emoji": _clean(meta.get("emoji")),
            "body": body.strip(),
        }
    return out


def skills_index(names: list[str] | None = None) -> list[dict]:
    """返回 [{slug, name, when, emoji}]。names 给定则只取这些（按给定顺序），否则全部。"""
    alls = _load_all()
    keys = names if names is not None else list(alls)
    return [
        {"slug": alls[k]["slug"], "name": alls[k]["name"], "when": alls[k]["when"], "emoji": alls[k]["emoji"]}
        for k in keys if k in alls
    ]


def load_skill(key: str) -> str | None:
    """按 slug（文件名）或 name 取正文；找不到返回 None。"""
    alls = _load_all()
    if key in alls:
        return alls[key]["body"]
    for v in alls.values():
        if v["name"] == key:
            return v["body"]
    return None
