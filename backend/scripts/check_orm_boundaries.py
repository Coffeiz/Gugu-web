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
import re
import subprocess
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
                    elif isinstance(node.func, ast.Name) and name in ORM_CONSTRUCTORS:
                        findings.append(Finding("orm-constructor", area, rel, node.lineno, _source_line(lines, node.lineno)))

                if isinstance(node, ast.ImportFrom) and node.module == "app.models":
                    imported = {alias.name for alias in node.names}
                    if imported & {"File", "Folder"} and area in {"api", "agent"}:
                        findings.append(Finding("file-domain-model-import", area, rel, node.lineno, _source_line(lines, node.lineno)))

    return findings


def scan_added_lines(base: str) -> list[str]:
    """只检查相对 base 新增的高风险代码行，作为阶段 1 棘轮。

    这里按源码形态匹配“裸 SQLAlchemy constructor”，不能用简单的 ``"update(" in line``：
    Agent 返回值里大量 ``result.update(...)`` / ``dict.update(...)``，它们不是 ORM。事务提交/回滚
    也不是领域查询；当前约定是 Service 负责查询/写入与 flush，API/Agent dispatch 作为任务事务
    边界可以 commit/rollback，因此不纳入“新增 ORM 边界”棘轮。
    """
    diff = subprocess.run(
        ["git", "diff", "--unified=0", f"{base}...HEAD", "--", "backend/app/api/v1", "backend/agent/tools", "backend/app/services"],
        cwd=BACKEND.parent,
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    violations: list[str] = []
    current_file = ""
    for line in diff.splitlines():
        if line.startswith("+++ b/"):
            current_file = line[6:]
            continue
        if not line.startswith("+") or line.startswith("+++"):
            continue
        code = line[1:].strip()
        if not code or code.startswith("#"):
            continue
        # 少数跨用户广播或协议层认证查询无法复用单用户 Service；豁免必须
        # 写在新增代码行上并说明原因，便于审查和后续收口。
        if "orm-exempt:" in code:
            continue
        # Service 是规范要求承接 ORM 的边界；阶段 1 只禁止 API/Agent 绕过
        # Service 新增高风险 ORM，Service 自身的查询由后续领域迁移与测试约束。
        if not (current_file.startswith("backend/app/api/v1/")
                or current_file.startswith("backend/agent/tools/")):
            continue
        # 只匹配 select(...)/update(...)/delete(...)/insert(...) 这类裸 constructor；
        # 前面的负向约束排除 result.update(...) 等普通对象方法。
        bare_constructor = bool(re.search(
            r"(?<![\w.])(select|update|delete|insert)\s*\(", code,
        ))
        session_orm = any(token in code for token in (
            "db.get(", "session.get(", "self.db.get(",
            "db.execute(", "db.delete(", "db.add(",
        ))
        high_risk = (
            "from app.models import" in code and any(name in code for name in ("File", "Folder"))
            or bare_constructor
            or session_orm
        )
        if high_risk:
            violations.append(f"{current_file}: {code[:160]}")
    return violations


def scan_agent_boundary() -> list[Finding]:
    """检查 Agent 工具是否仍直接依赖 ORM。

    这是阶段 P1 的严格守卫：Agent 工具可以编排调用 Service，但不能成为 ORM 的第二个入口。
    """
    findings: list[Finding] = []
    root = SCAN_ROOTS["agent"]
    for path in sorted(root.rglob("*.py")):
        if "__pycache__" in path.parts or path.name.startswith("._"):
            continue
        source = path.read_text(encoding="utf-8")
        lines = source.splitlines()
        try:
            tree = ast.parse(source, filename=str(path))
        except SyntaxError as exc:
            findings.append(Finding("syntax-error", "agent", str(path.relative_to(BACKEND)), exc.lineno or 0, str(exc)))
            continue
        rel = str(path.relative_to(BACKEND))
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and (
                node.module == "sqlalchemy"
                or node.module == "app.models"
                or node.module == "app.core.ownership"
            ):
                findings.append(Finding("agent-direct-import", "agent", rel, node.lineno, _source_line(lines, node.lineno)))
            if isinstance(node, ast.Call):
                name = _call_name(node)
                if isinstance(node.func, ast.Attribute) and name in (ORM_METHODS - {"commit", "rollback"}) and _is_session_receiver(node.func):
                    findings.append(Finding("agent-orm-method", "agent", rel, node.lineno, _source_line(lines, node.lineno)))
                elif isinstance(node.func, ast.Name) and name in ORM_CONSTRUCTORS:
                    findings.append(Finding("agent-orm-constructor", "agent", rel, node.lineno, _source_line(lines, node.lineno)))
            if isinstance(node, ast.Name) and node.id == "get_owned":
                findings.append(Finding("agent-ownership-helper", "agent", rel, node.lineno, _source_line(lines, node.lineno)))
    return findings


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", action="store_true", dest="as_json")
    parser.add_argument("--diff-base", help="阶段 1：只检查相对该 Git ref 新增的高风险 ORM 行")
    parser.add_argument("--agent-strict", action="store_true", help="P1：禁止 Agent 工具直接依赖 ORM")
    args = parser.parse_args()
    if args.agent_strict:
        findings = scan_agent_boundary()
        if findings:
            print("❌ Agent ORM 边界失败：Agent 工具仍直接依赖 ORM，请迁移到 Service：")
            for finding in findings:
                print(f"  {finding.path}:{finding.line} [{finding.category}] {finding.detail}")
            return 1
        print("✅ Agent ORM 边界通过：Agent 工具未直接依赖 ORM")
        return 0
    if args.diff_base:
        violations = scan_added_lines(args.diff_base)
        if violations:
            print("❌ ORM 阶段 1 棘轮失败：新增代码包含未收口的 ORM 边界，请迁移到 Service 或补充明确豁免：")
            for violation in violations:
                print(f"  {violation}")
            return 1
        print("✅ ORM 阶段 1 棘轮通过：新增高风险 ORM 边界未扩大")
        return 0
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
