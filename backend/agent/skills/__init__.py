"""Prompt skills 加载层（渐进式按需披露）。

每个 skill 一个 `.md`：frontmatter（`name` / `description_short` / `description_long`）+ 正文（做法说明，可指挥模型调若干 tool）。
- `skills_index(names)` → `[{slug, name, description_short, description_long}]`，供 builder 注入「可用技能」索引。
- `load_skill(key)`   → 正文（去掉 frontmatter），供 `use_skill` 工具按名拉取。

与 `agent/tools/`（函数调用工具）的关系：skill 是「带触发条件的剧本」，跑在 tool 之上。
依赖单向：tools（use_skill）→ skills（本模块）。

不缓存：每次现读目录里的几个 .md（开销极小），改 skill 内容**无需重启**即生效。

常驻行为规则保留在 `prompts/skills.md`，能力名称和短描述只从本目录注册表生成，不再维护第二份 Skill 目录。
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
        if p.name.upper() == "README.MD":
            continue
        try:
            meta, body = _parse(p.read_text(encoding="utf-8"))
        except Exception:
            continue
        slug = p.stem
        def _clean(v: str) -> str:
            return (v or "").strip().strip('"').strip("'")
        # emoji 可能嵌在 metadata: 下（扁平解析仍能取到 emoji 行）
        out[slug] = {
            "slug": slug,
            "name": _clean(meta.get("name", slug)),
            "description_short": _clean(meta.get("description_short")),
            "category": _clean(meta.get("category")),
            "source": _clean(meta.get("source", "builtin")) or "builtin",
            "related_tools": tuple(
                item.strip() for item in _clean(meta.get("related_tools")).split(",") if item.strip()
            ),
            "description_long": _clean(meta.get("description_long")),
            "emoji": _clean(meta.get("emoji")),
            "body": body.strip(),
        }
    return out


def skill_metadata(names: list[str] | None = None) -> list[dict]:
    """返回注册表所需的 Skill metadata，不读取正文到调用方。"""
    alls = _load_all()
    keys = names if names is not None else list(alls)
    return [
        {key: value for key, value in item.items() if key != "body"}
        for key, item in ((key, alls[key]) for key in keys if key in alls)
    ]


def skills_index(names: list[str] | None = None) -> list[dict]:
    """返回注册 metadata 的 Skill 索引；names 给定则只取这些。"""
    alls = _load_all()
    keys = names if names is not None else list(alls)
    return [
        {"slug": alls[k]["slug"], "name": alls[k]["name"],
         "description_short": alls[k]["description_short"],
         "description_long": alls[k]["description_long"], "emoji": alls[k]["emoji"]}
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


def resolve_skill_slug(key: str) -> str | None:
    """把 slug 或展示名归一为稳定 slug，供 Run 内正文去重。"""
    key = (key or "").strip()
    alls = _load_all()
    if key in alls:
        return key
    for item in alls.values():
        if item["name"] == key:
            return item["slug"]
    return None


def skill_diagnostics(names: list[str] | None = None) -> tuple[str, ...]:
    """校验 Skill 注册 metadata。"""
    rows = skill_metadata(names)
    diagnostics = []
    for row in rows:
        if not row.get("description_short"):
            diagnostics.append(f"Skill {row['slug']} 缺少 description_short")
        if not row.get("description_long"):
            diagnostics.append(f"Skill {row['slug']} 缺少 description_long")
    return tuple(diagnostics)
