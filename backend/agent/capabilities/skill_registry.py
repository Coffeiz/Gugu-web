"""Markdown Skill 的 Capability adapter。"""

from __future__ import annotations

from agent import skills
from .errors import CapabilityRegistrationError
from .models import CapabilityMeta


class SkillCapabilityRegistry:
    def metadata(self, names: list[str] | None = None) -> tuple[CapabilityMeta, ...]:
        rows = skills.skill_metadata(None if names is None else list(names))
        out = []
        for row in rows:
            short = (row.get("description_short") or "").strip()
            if not short:
                short = (row.get("name") or row["slug"]).strip()
            if not short or len(short) > 100:
                raise CapabilityRegistrationError(
                    f"Skill {row['slug']} 的短描述必须是 1-100 个字符"
                )
            out.append(CapabilityMeta(
                name=row["slug"], kind="skill", description_short=short,
                category=row.get("category", ""),
                related_tools=tuple(row.get("related_tools", ()) or ()),
                source=row.get("source", "builtin") or "builtin",
                enabled=True,
            ))
        return tuple(out)

    def diagnostics(self, names: list[str] | None = None) -> tuple[str, ...]:
        return skills.skill_diagnostics(names)
