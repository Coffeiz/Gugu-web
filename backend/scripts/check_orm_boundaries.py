#!/usr/bin/env python3
"""ORM 边界基线扫描器。

阶段 0 只报告存量，不作为失败门禁。扫描结果用于 ORM 规范化方案的阶段
迁移清单；不要为了让报告变少而给存量代码做无关格式化。

用法：
    python scripts/check_orm_boundaries.py
    python scripts/check_orm_boundaries.py --json
"""
from __future__ import annotations

import argparse
import ast
import json
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
SCAN_ROOTS = {
    "api": BACKEND / "app" / "api" / "v1",
    "agent": BACKEND / "agent" / "tools",
    "service": BACKEND / "app" / "services",
}
ORM_METHODS = {
    "get", "execute", "scalars", "scalar", "scalar_one", "scalar_one_or_none",
    "add", "add_all", "delete", "flush", "refresh", "commit", "rollback",
}
ORM_CONSTRUCTORS = {"select", "update", "delete", "insert"}


@dataclass(frozen=True)
class Finding:
    category: str
    area: str
    path: str
    line: int
    detail: str


def _call_name(node: ast.Call) -> str | None:
    if isinstance(node.func, ast.Attribute):
        return node.func.attr
    if isinstance(node.func, ast.Name):
        return node.func.id
    return None


def _is_session_receiver(node: ast.Attribute) -> bool:
    """识别 db/session/self.db，避免把普通 dict.get() 算成 ORM 调用。"""
    value = node.value
    if isinstance(value, ast.Name):
        return value.id in {"db", "session", "database"}
    return isinstance(value, ast.Attribute) and isinstance(value.value, ast.Name) \
        and value.value.id == "self" and value.attr in {"db", "session"}


def _source_line(lines: list[str], line: int) -> str:
    return lines[line - 1].strip()[:160]


def scan() -> list[Finding]:
    findings: list[Finding] = []
    for area, root in SCAN_ROOTS.items():
        if not root.exists():
            continue
        for path in sorted(root.rglob("*.py")):
            if "__pycache__" in path.parts or path.name.startswith("._"):
                continue
            source = path.read_text(encoding="utf-8")
            lines = source.splitlines()
            try:
                tree = ast.parse(source, filename=str(path))
            except SyntaxError as exc:
                findings.append(Finding("syntax-error", area, str(path.relative_to(BACKEND)), exc.lineno or 0, str(exc)))
                continue

            rel = str(path.relative_to(BACKEND))
            for node in ast.walk(tree):
                if isinstance(node, ast.Call):
                    name = _call_name(node)
                    if isinstance(node.func, ast.Attribute) and name in ORM_METHODS \
                            and _is_session_receiver(node.func):
                        findings.append(Finding("orm-method", area, rel, node.lineno, _source_line(lines, node.lineno)))
                    elif name in ORM_CONSTRUCTORS:
                        findings.append(Finding("orm-constructor", area, rel, node.lineno, _source_line(lines, node.lineno)))

                if isinstance(node, ast.ImportFrom) and node.module == "app.models":
                    imported = {alias.name for alias in node.names}
                    if imported & {"File", "Folder"} and area in {"api", "agent"}:
                        findings.append(Finding("file-domain-model-import", area, rel, node.lineno, _source_line(lines, node.lineno)))

    return findings


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", action="store_true", dest="as_json")
    args = parser.parse_args()
    findings = scan()
    counts = Counter((item.area, item.category) for item in findings)
    files = defaultdict(set)
    for item in findings:
        files[(item.area, item.category)].add(item.path)

    if args.as_json:
        print(json.dumps({
            "mode": "baseline-report-only",
            "finding_count": len(findings),
            "counts": {f"{area}:{category}": count for (area, category), count in sorted(counts.items())},
            "files": {f"{area}:{category}": sorted(paths) for (area, category), paths in sorted(files.items())},
            "findings": [asdict(item) for item in findings],
        }, ensure_ascii=False, indent=2))
        return 0

    print("ORM 边界基线（阶段 0，仅报告，不阻塞）")
    print(f"总发现数：{len(findings)}")
    for (area, category), count in sorted(counts.items()):
        print(f"- {area}/{category}: {count} 处，涉及 {len(files[(area, category)])} 个文件")
    print("\n说明：阶段 1 守卫接入前，以上结果均视为已知存量；新增违规不得借此豁免。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
