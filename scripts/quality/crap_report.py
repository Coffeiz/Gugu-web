#!/usr/bin/env python3
"""对显式选定的 Python/TypeScript 文件生成非阻断 CRAP 报告。"""
from __future__ import annotations

import argparse
import ast
from datetime import datetime, timezone
import importlib.metadata
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
from typing import Any

try:
    import lizard
except ImportError:
    lizard = None


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_SCOPE = ROOT / "scripts/quality/crap_scope.json"
DEFAULT_REPORT_DIR = ROOT / "docs/reports"
REPORT_STEM = "{date}-VERIFY-PRD-TEST-2-CRAP-PHASE0-1"
RISK_HIGH = 30.0
RISK_MEDIUM = 15.0
SENSITIVE_KEYS = {
    "access_token", "api_key", "attachment", "attachment_content",
    "authorization", "chat_content", "chat_id", "content", "cookie",
    "email", "message", "message_content", "messages", "password",
    "private_key", "prompt", "prompt_text", "raw_output", "raw_path",
    "refresh_token", "secret", "stderr", "stdout", "token_value",
    "user_id", "user_name", "user_identifier", "username",
}
SECRET_ENV_PATTERN = re.compile(
    r"(API.?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|DATABASE|POSTGRES|REDIS|"
    r"MINIMAX|OPENAI|DEEPSEEK|ANTHROPIC|QQ|WECHAT|FEISHU|BYOK|CHAT.?ID)",
    re.IGNORECASE,
)


class ReportError(ValueError):
    """范围或输入无效；此类错误不得产出看似成功的报告。"""


def crap_score(complexity: int, coverage: float) -> float:
    if complexity < 1 or not 0.0 <= coverage <= 1.0:
        raise ValueError("复杂度必须为正数，覆盖率必须位于 0 到 1 之间")
    return complexity**2 * (1.0 - coverage) ** 3 + complexity


def risk_level(score: float) -> str:
    """展示用风险分层；只提示排序，不作为测试或 CI 门禁。"""
    if score >= RISK_HIGH:
        return "高"
    if score >= RISK_MEDIUM:
        return "中"
    return "低"


def coverage_ratio_for_span(
    executable_lines: set[int], covered_lines: set[int], start_line: int, end_line: int
) -> float | None:
    lines = {line for line in executable_lines if start_line <= line <= end_line}
    if not lines:
        return None
    return len(lines & covered_lines) / len(lines)


def validate_scope(config: Any, root: Path = ROOT) -> list[dict[str, Any]]:
    if not isinstance(config, dict) or config.get("version") != 1:
        raise ReportError("范围文件格式无效：需要 version=1 的对象")
    scopes = config.get("scopes")
    if not isinstance(scopes, list) or not scopes:
        raise ReportError("分析范围为空；请在 scope 文件中显式登记源码与测试入口")

    validated: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for index, item in enumerate(scopes):
        if not isinstance(item, dict):
            raise ReportError(f"范围第 {index + 1} 项必须是对象")
        language = item.get("language")
        if language not in {"python", "typescript"}:
            raise ReportError(f"范围第 {index + 1} 项 language 无效")
        record: dict[str, Any] = {}
        for key in ("source",):
            value = item.get(key)
            if not isinstance(value, str) or not value.strip():
                raise ReportError(f"范围第 {index + 1} 项缺少 {key}")
            relative = Path(value)
            if relative.is_absolute() or ".." in relative.parts:
                raise ReportError(f"范围路径必须是仓库内相对路径：{key}")
            resolved = (root / relative).resolve()
            if not resolved.is_relative_to(root.resolve()):
                raise ReportError(f"范围路径越出仓库：{key}")
            if not resolved.is_file():
                raise ReportError(f"范围文件不存在：{value}")
            record[key] = relative.as_posix()
        tests = item.get("tests")
        if not isinstance(tests, list) or not tests:
            raise ReportError(f"范围第 {index + 1} 项必须显式登记 tests 列表")
        record["tests"] = []
        for test_path in tests:
            if not isinstance(test_path, str) or not test_path.strip():
                raise ReportError(f"范围第 {index + 1} 项 tests 必须是非空路径")
            relative_test = Path(test_path)
            if relative_test.is_absolute() or ".." in relative_test.parts:
                raise ReportError("测试路径必须是仓库内相对路径")
            resolved_test = (root / relative_test).resolve()
            if not resolved_test.is_relative_to(root.resolve()):
                raise ReportError("测试路径越出仓库")
            if not resolved_test.is_file():
                raise ReportError(f"测试文件不存在：{test_path}")
            record["tests"].append(relative_test.as_posix())
        function_tests = item.get("function_tests", {})
        if not isinstance(function_tests, dict):
            raise ReportError(f"范围第 {index + 1} 项 function_tests 必须是对象")
        record["function_tests"] = {}
        for function_name, associated_tests in function_tests.items():
            if not isinstance(function_name, str) or not function_name.strip():
                raise ReportError("函数测试关联必须使用非空函数名")
            if not isinstance(associated_tests, list) or not associated_tests:
                raise ReportError(f"函数 {function_name} 的测试关联必须是非空列表")
            normalized_tests = []
            for test_path in associated_tests:
                if not isinstance(test_path, str) or test_path not in record["tests"]:
                    raise ReportError(f"函数 {function_name} 的关联测试必须来自该源码登记的 tests")
                normalized_tests.append(test_path)
            record["function_tests"][function_name] = normalized_tests
        for key in ("domain", "layer", "ci"):
            value = item.get(key)
            if not isinstance(value, str) or not value.strip():
                raise ReportError(f"范围第 {index + 1} 项缺少 {key}")
            record[key] = value.strip()
        record["language"] = language
        if language == "python" and Path(record["source"]).suffix != ".py":
            raise ReportError(f"Python 源文件后缀不匹配：{record['source']}")
        if language == "typescript" and Path(record["source"]).suffix not in {".ts", ".tsx"}:
            raise ReportError(f"TypeScript 源文件后缀不匹配：{record['source']}")
        identity = (language, record["source"])
        if identity in seen:
            raise ReportError(f"范围存在重复源码：{record['source']}")
        seen.add(identity)
        validated.append(record)
    return validated


def _safe_env(temp_dir: Path, *, python_path: Path | None = None) -> dict[str, str]:
    env = {key: value for key, value in os.environ.items() if not SECRET_ENV_PATTERN.search(key)}
    env["PYTEST_ADDOPTS"] = ""
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env["COVERAGE_FILE"] = str(temp_dir / ".coverage")
    if python_path is not None:
        env["PYTHONPATH"] = str(python_path)
    return env


def _run_test(language: str, entries: list[dict[str, Any]], temp_dir: Path) -> dict[str, Any]:
    source = ROOT / entries[0]["source"]
    coverage_path = temp_dir / f"{language}-coverage.json"
    if language == "python":
        backend = ROOT / "backend"
        module = source.relative_to(backend).with_suffix("").as_posix().replace("/", ".")
        test_paths = sorted({str((ROOT / test).relative_to(backend)) for entry in entries for test in entry["tests"]})
        command = [
            sys.executable, "-m", "pytest", "-q", "--disable-warnings",
            f"--cov={module}", "--cov-branch", f"--cov-report=json:{coverage_path}",
            *test_paths,
        ]
        cwd = backend
        env = _safe_env(temp_dir, python_path=backend)
        display = f"python -m pytest -q --disable-warnings --cov={module} --cov-branch --cov-report=json:<TEMP> {', '.join(test_paths)}"
    else:
        source_paths = sorted({entry["source"] for entry in entries})
        test_paths = sorted({str(Path(test).relative_to("frontend")) for entry in entries for test in entry["tests"]})
        coverage_dir = temp_dir / "typescript-coverage"
        source_patterns = ",".join(str(Path(path).relative_to("frontend")) for path in source_paths)
        command = [
            "corepack", "pnpm", "exec", "vitest", "run", *test_paths,
            "--coverage.enabled", "--coverage.provider=v8",
            f"--coverage.include={source_patterns}",
            "--coverage.reporter=json", f"--coverage.reportsDirectory={coverage_dir}",
        ]
        cwd = ROOT / "frontend"
        env = _safe_env(temp_dir)
        coverage_path = coverage_dir / "coverage-final.json"
        display = f"corepack pnpm exec vitest run {' '.join(test_paths)} --coverage.enabled --coverage.provider=v8 --coverage.include={source_patterns} --coverage.reporter=json --coverage.reportsDirectory=<TEMP>"

    started = time.monotonic()
    try:
        result = subprocess.run(
            command,
            cwd=cwd,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=300,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return {"status": "timeout", "exit_code": None, "duration_ms": round((time.monotonic() - started) * 1000), "coverage_path": coverage_path, "command": display}
    except OSError as exc:
        return {"status": "error", "exit_code": None, "duration_ms": round((time.monotonic() - started) * 1000), "coverage_path": coverage_path, "command": display, "error_type": type(exc).__name__}

    return {
        "status": "passed" if result.returncode == 0 else "failed",
        "exit_code": result.returncode,
        "duration_ms": round((time.monotonic() - started) * 1000),
        "coverage_path": coverage_path,
        "command": display,
    }


def _coverage_for_file(path: Path, coverage_path: Path, language: str) -> tuple[set[int], set[int]]:
    if not coverage_path.is_file():
        raise ReportError(f"测试完成但未生成覆盖率文件：{language}")
    data = json.loads(coverage_path.read_text(encoding="utf-8"))
    file_map = data.get("files", {}) if language == "python" else data
    source_resolved = path.resolve()
    language_root = ROOT / ("backend" if language == "python" else "frontend")
    record = None
    for key, candidate in file_map.items():
        candidate_path = Path(key)
        resolved = candidate_path.resolve() if candidate_path.is_absolute() else (ROOT / candidate_path).resolve()
        suffixes = (
            path.relative_to(ROOT).as_posix(),
            path.relative_to(language_root).as_posix(),
        )
        if resolved == source_resolved or any(candidate_path.as_posix().endswith(suffix) for suffix in suffixes):
            record = candidate
            break
    if not isinstance(record, dict):
        raise ReportError(f"覆盖率结果未包含显式源码：{path.relative_to(ROOT).as_posix()}")

    if language == "python":
        executed = {int(line) for line in record.get("executed_lines", [])}
        missing = {int(line) for line in record.get("missing_lines", [])}
        return executed | missing, executed

    line_counts = record.get("l")
    if isinstance(line_counts, dict) and line_counts:
        covered = {int(line) for line, count in line_counts.items() if int(count) > 0}
        executable = {int(line) for line in line_counts}
        return executable, covered

    statement_map = record.get("statementMap", {})
    statement_counts = record.get("s", {})
    line_hits: dict[int, list[bool]] = {}
    for statement_id, location in statement_map.items():
        start = int(location.get("start", {}).get("line", 0))
        end = int(location.get("end", {}).get("line", start))
        hit = int(statement_counts.get(statement_id, 0)) > 0
        for line in range(start, end + 1):
            if line > 0:
                line_hits.setdefault(line, []).append(hit)
    executable = set(line_hits)
    covered = {line for line, hits in line_hits.items() if hits and all(hits)}
    return executable, covered


def _function_records(entry: dict[str, Any], coverage_path: Path) -> list[dict[str, Any]]:
    if lizard is None:
        raise ReportError("未安装 lizard，无法计算圈复杂度")
    source = ROOT / entry["source"]
    analysis = lizard.analyze_file(str(source))
    if not analysis.function_list:
        raise ReportError(f"复杂度分析失败：{entry['source']}")
    executable, covered = _coverage_for_file(source, coverage_path, entry["language"])
    function_names = {function.name for function in analysis.function_list}
    unknown_mappings = set(entry.get("function_tests", {})) - function_names
    if unknown_mappings:
        raise ReportError("函数测试关联包含不存在的函数名")
    python_spans = _python_function_body_spans(source) if entry["language"] == "python" else None
    functions = []
    for function in analysis.function_list:
        if python_spans is None:
            start_line, end_line = function.start_line, function.end_line
        else:
            span = python_spans.get((function.name, function.start_line))
            if span is None:
                raise ReportError(f"无法将复杂度函数映射到 Python AST：{function.name}")
            start_line, end_line = span
        coverage = coverage_ratio_for_span(executable, covered, start_line, end_line)
        if coverage is None:
            continue
        score = crap_score(function.cyclomatic_complexity, coverage)
        associated_tests = entry.get("function_tests", {}).get(function.name, [])
        functions.append({
            "source": entry["source"],
            "function": function.name,
            "start_line": function.start_line,
            "end_line": function.end_line,
            "domain": entry["domain"],
            "layer": entry["layer"],
            "ci": entry["ci"],
            "tests": associated_tests,
            "test_association": "registered" if associated_tests else "pending_manual",
            "cc": function.cyclomatic_complexity,
            "coverage": round(coverage, 6),
            "crap": round(score, 4),
            "risk": risk_level(score),
        })
    return functions


def _python_function_body_spans(source: Path) -> dict[tuple[str, int], tuple[int, int]]:
    """按 AST 建立函数体区间，排除 import 时执行的 def/参数签名行。"""
    try:
        tree = ast.parse(source.read_text(encoding="utf-8"), filename=str(source))
    except (OSError, SyntaxError) as exc:
        raise ReportError(f"无法解析 Python 函数范围：{type(exc).__name__}") from exc

    spans: dict[tuple[str, int], tuple[int, int]] = {}
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        if not node.body:
            continue
        body_start = node.body[0].lineno
        body_end = node.body[-1].end_lineno or node.body[-1].lineno
        if body_start <= node.lineno:
            raise ReportError(f"单行 Python 函数无法通过行覆盖率区分定义与函数体：{node.name}")
        spans[(node.name, node.lineno)] = (body_start, body_end)
        if node.decorator_list:
            decorator_start = min(decorator.lineno for decorator in node.decorator_list)
            spans[(node.name, decorator_start)] = (body_start, body_end)
    return spans


def _function_coverage_span(
    source: Path, language: str, function_name: str, start_line: int, end_line: int
) -> tuple[int, int]:
    """返回函数体覆盖率区间；TypeScript 保留 Lizard 函数区间。"""
    if language != "python":
        return start_line, end_line
    span = _python_function_body_spans(source).get((function_name, start_line))
    if span is None:
        raise ReportError(f"无法将复杂度函数映射到 Python AST：{function_name}")
    return span


def _tool_versions() -> dict[str, str]:
    versions = {
        "python": sys.version.split()[0],
        "lizard": importlib.metadata.version("lizard"),
        "pytest_cov": importlib.metadata.version("pytest-cov"),
        "coverage": importlib.metadata.version("coverage"),
    }
    frontend = ROOT / "frontend"
    package_json = json.loads((frontend / "package.json").read_text(encoding="utf-8"))
    versions["vitest"] = _node_package_version(frontend / "node_modules/vitest/package.json")
    versions["vitest_coverage_v8"] = _node_package_version(frontend / "node_modules/@vitest/coverage-v8/package.json")
    versions["vitest_declared"] = package_json["devDependencies"]["vitest"]
    versions["vitest_coverage_v8_declared"] = package_json["devDependencies"]["@vitest/coverage-v8"]
    return versions


def _node_package_version(path: Path) -> str:
    try:
        return str(json.loads(path.read_text(encoding="utf-8"))["version"])
    except (OSError, json.JSONDecodeError, KeyError, TypeError):
        return "unavailable"


def _assert_no_sensitive_fields(value: Any, parent: str = "") -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            normalized = re.sub(r"[^a-z0-9_]", "", str(key).lower())
            if normalized in SENSITIVE_KEYS:
                raise ReportError(f"报告包含禁止的敏感字段：{parent}{key}")
            _assert_no_sensitive_fields(child, f"{parent}{key}.")
    elif isinstance(value, list):
        for child in value:
            _assert_no_sensitive_fields(child, parent)


def _markdown(report: dict[str, Any]) -> str:
    rows = [
        "# VERIFY：PRD-TEST-2 Phase 0–1 CRAP 基线报告",
        "",
        f"> 报告日期：{report['date']}",
        f"> Commit：{report['commit']}（工作区修改：{'是' if report['worktree_dirty'] else '否'}）",
        f"> 状态：{report['status']}（非阻断；本次未运行变异测试）",
        f"> 耗时：{report['duration_ms']} ms",
        "",
        "---",
        "",
        "## 范围与方法",
        "",
        "只分析 scripts/quality/crap_scope.json 中显式列出的源码/测试配对。CRAP = CC² × (1 − Cov)³ + CC。风险标签只用于报告排序，不构成门禁。Python 覆盖率按 AST 函数体区间计算（排除 def 和参数签名行）；TypeScript 按复杂度工具给出的函数区间计算。",
        "",
        "| 语言 | 源码 | 测试入口 | 领域 / 层级 | CI 状态 | 测试结果 | 耗时 |",
        "|---|---|---|---|---|---|---|",
    ]
    for run in report["runs"]:
        for scope in run["scopes"]:
            source_link = f"[{scope['source']}](../../{scope['source']})"
            test_links = ", ".join(f"[{test}](../../{test})" for test in scope["tests"])
            rows.append(f"| {scope['language']} | {source_link} | {test_links} | {scope['domain']} / {scope['layer']} | {scope['ci']} | {run['status']} | {run['duration_ms']} ms |")
    rows.extend([
        "",
        "## CRAP 明细",
        "",
        "| 风险 | CRAP | CC | Cov | 函数 | 源码位置 | 函数级测试关联 |",
        "|---|---:|---:|---:|---|---|---|",
    ])
    for item in sorted(report["items"], key=lambda record: record["crap"], reverse=True):
        source_link = f"[{item['source']}:{item['start_line']}](../../{item['source']}#L{item['start_line']})"
        test_links = ", ".join(f"[{test}](../../{test})" for test in item["tests"]) or "待人工关联"
        rows.append(f"| {item['risk']} | {item['crap']:.4f} | {item['cc']} | {item['coverage']:.1%} | {item['function']} | {source_link} | {test_links} |")
    if not report["items"]:
        rows.append("| — | — | — | — | 没有可分析函数 | — | — |")
    rows.extend([
        "",
        "## 结果摘要",
        "",
        f"- 函数数：{report['summary']['functions_total']}；CRAP 高风险（≥30）：{report['summary']['complexity_hotspots']}。",
        f"- 工具版本：lizard {report['tools']['lizard']}、pytest-cov {report['tools']['pytest_cov']}、coverage {report['tools']['coverage']}、Vitest {report['tools']['vitest']}、@vitest/coverage-v8 {report['tools']['vitest_coverage_v8']}。",
        "- 变异统计：本阶段未执行（JSON 中为 null，不是 0 个变异）。",
        "- 执行策略：CRAP 报告与变异测试仅周期性手动运行，不由自动 CI 触发；普通 pytest/Vitest 仍按现有 workflow 执行。CRAP 分数不会令命令失败；测试、工具或分析失败会显式标记 failed 或 timeout 并返回非零状态。",
        "",
        "## 排除范围与数据边界",
        "",
    ])
    rows.extend(f"- {reason}" for reason in report["exclusions"])
    rows.extend([
        "- 报告只保留仓库相对路径、函数名、覆盖率/复杂度和测试状态；不保存测试 stdout、聊天正文、附件、真实用户数据或凭据。覆盖率 JSON 与 .coverage 在系统临时目录生成，由 TemporaryDirectory 自动清理。",
        "",
        "## 测试脚本与复现",
        "",
        "- 编排脚本：scripts/quality/crap_report.py。",
        "- 范围配置：scripts/quality/crap_scope.json。",
        "- 命令：backend/.venv/bin/python scripts/quality/crap_report.py。",
        "- 原始脱敏结果：同目录 JSON 报告；临时覆盖率文件不保留。",
        "- 真实 provider / 服务 / 数据：否；试点为纯单元测试，未连接真实模型、数据库、Redis、IM、网络或用户文件。",
        "- 工具文档：[Lizard](https://github.com/terryyin/lizard)、[pytest-cov JSON 报告](https://pytest-cov.readthedocs.io/en/stable/reporting.html)、[Vitest coverage](https://vitest.dev/guide/coverage.html)。",
        "",
    ])
    return "\n".join(rows)


def build_report(scope_config: dict[str, Any], *, language: str = "all") -> dict[str, Any]:
    scopes = validate_scope(scope_config)
    selected = scopes if language == "all" else [item for item in scopes if item["language"] == language]
    if not selected:
        raise ReportError(f"所选语言没有显式分析范围：{language}")
    started = time.monotonic()
    report: dict[str, Any] = {
        "schema_version": 1,
        "report_type": "crap",
        "status": "passed",
        "date": datetime.now().astimezone().date().isoformat(),
        "created_at": datetime.now(timezone.utc).isoformat(),
        "commit": "unknown",
        "worktree_dirty": False,
        "tools": _tool_versions(),
        "scope": selected,
        "exclusions": list(scope_config.get("exclusions", [])),
        "runs": [],
        "items": [],
        "errors": [],
        "summary": {
            "functions_total": 0,
            "complexity_hotspots": 0,
            "mutants_total": None,
            "mutants_killed": None,
            "mutants_survived": None,
            "mutants_timeout": None,
            "mutants_error": None,
            "equivalent_marked": None,
        },
    }
    git = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, check=False)
    if git.returncode == 0:
        report["commit"] = git.stdout.strip()
    dirty = subprocess.run(["git", "status", "--porcelain"], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, check=False)
    report["worktree_dirty"] = dirty.returncode != 0 or bool(dirty.stdout.strip())

    grouped = {key: [entry for entry in selected if entry["language"] == key] for key in ("python", "typescript")}
    with tempfile.TemporaryDirectory(prefix="gugu-crap-") as temp_name:
        temp_dir = Path(temp_name)
        for lang, entries in grouped.items():
            if not entries:
                continue
            run = _run_test(lang, entries, temp_dir)
            report["runs"].append({
                "language": lang,
                "status": run["status"],
                "exit_code": run["exit_code"],
                "duration_ms": run["duration_ms"],
                "command": run["command"],
                "scopes": entries,
            })
            if run["status"] != "passed":
                report["status"] = "failed"
                report["errors"].append({"language": lang, "kind": run["status"], "exit_code": run["exit_code"], "error_type": run.get("error_type")})
                continue
            for entry in entries:
                try:
                    report["items"].extend(_function_records(entry, run["coverage_path"]))
                except (ReportError, json.JSONDecodeError, OSError) as exc:
                    report["status"] = "failed"
                    report["errors"].append({"language": lang, "kind": "analysis_error", "error_type": type(exc).__name__})

    report["duration_ms"] = round((time.monotonic() - started) * 1000)
    report["summary"]["functions_total"] = len(report["items"])
    report["summary"]["complexity_hotspots"] = sum(item["risk"] == "高" for item in report["items"])
    if not report["items"] and report["status"] == "passed":
        report["status"] = "failed"
        report["errors"].append({"kind": "empty_analysis", "error_type": "ReportError"})
    _assert_no_sensitive_fields(report)
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scope-file", type=Path, default=DEFAULT_SCOPE)
    parser.add_argument("--report-dir", type=Path, default=DEFAULT_REPORT_DIR)
    parser.add_argument("--language", choices=("all", "python", "typescript"), default="all")
    parser.add_argument("--date", help="报告文件名前缀；默认使用本地日期 YYYY-MM-DD")
    parser.add_argument("--overwrite", action="store_true", help="明确允许覆盖同日期的既有报告文件")
    args = parser.parse_args(argv)
    try:
        config_path = args.scope_file.resolve()
        if not config_path.is_file():
            raise ReportError("范围配置文件不存在")
        config = json.loads(config_path.read_text(encoding="utf-8"))
        report = build_report(config, language=args.language)
        report_date = args.date or report["date"]
        try:
            datetime.strptime(report_date, "%Y-%m-%d")
        except ValueError:
            raise ReportError("日期格式必须是 YYYY-MM-DD")
        output_dir = args.report_dir if args.report_dir.is_absolute() else ROOT / args.report_dir
        output_dir.mkdir(parents=True, exist_ok=True)
        stem = REPORT_STEM.format(date=report_date)
        json_path = output_dir / f"{stem}.json"
        markdown_path = output_dir / f"{stem}.md"
        if not args.overwrite and (json_path.exists() or markdown_path.exists()):
            raise ReportError("同名报告已存在；需要替换时请显式传入 --overwrite")
        json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        markdown_path.write_text(_markdown(report), encoding="utf-8")
        print(f"报告状态：{report['status']}")
        print(f"Markdown：{markdown_path.relative_to(ROOT) if markdown_path.is_relative_to(ROOT) else markdown_path}")
        print(f"JSON：{json_path.relative_to(ROOT) if json_path.is_relative_to(ROOT) else json_path}")
        print(f"函数：{report['summary']['functions_total']}；高风险：{report['summary']['complexity_hotspots']}")
        return 0 if report["status"] == "passed" else 1
    except (ReportError, OSError, json.JSONDecodeError, KeyError, ValueError, importlib.metadata.PackageNotFoundError) as exc:
        print(f"CRAP 报告未生成：{type(exc).__name__}: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
