#!/usr/bin/env python3
"""手动执行显式范围的变异测试并生成 JSON/Markdown 结果。"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import date
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
SCOPE_PATH = ROOT / "scripts/quality/mutation_scope.json"
REPORT_DIR = ROOT / "docs/reports"
REPORT_STEM = "{date}-VERIFY-PRD-TEST-2-MUTATION-PHASE2"
STATUS_KEYS = ("killed", "survived", "timeout", "error", "compile_error", "no_coverage", "equivalent", "not_checked")
SECRET_ENV = re.compile(
    r"(API.?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|DATABASE|POSTGRES|REDIS|"
    r"MINIMAX|OPENAI|DEEPSEEK|ANTHROPIC|QQ|WECHAT|FEISHU|BYOK|CHAT.?ID)",
    re.IGNORECASE,
)


class MutationReportError(ValueError):
    """范围或报告数据无效。"""


def normalize_mutmut_status(value: str) -> str:
    normalized = value.strip().lower().replace(" ", "_")
    aliases = {
        "killed": "killed",
        "survived": "survived",
        "timeout": "timeout",
        "error": "error",
        "no_tests": "no_coverage",
        "no_coverage": "no_coverage",
        "not_checked": "not_checked",
    }
    return aliases.get(normalized, "error")


def normalize_stryker_status(value: str) -> str:
    normalized = value.strip().lower().replace("_", "")
    aliases = {
        "killed": "killed",
        "survived": "survived",
        "timeout": "timeout",
        "error": "error",
        "noco": "no_coverage",
        "nocoverage": "no_coverage",
        "compileerror": "compile_error",
        "runtimeerror": "error",
        "ignored": "not_checked",
        "pending": "not_checked",
    }
    return aliases.get(normalized, "error")


def summarize_statuses(statuses: list[str]) -> dict[str, int | float]:
    counts = Counter(statuses)
    summary: dict[str, int | float] = {key: counts[key] for key in STATUS_KEYS}
    eligible = counts["killed"] + counts["survived"]
    summary["eligible"] = eligible
    summary["mutation_score"] = round(counts["killed"] / eligible * 100, 2) if eligible else 0.0
    return summary


def _safe_env() -> dict[str, str]:
    env = {key: value for key, value in os.environ.items() if not SECRET_ENV.search(key)}
    env["PYTEST_ADDOPTS"] = ""
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    return env


def _load_scope(path: Path = SCOPE_PATH) -> dict[str, Any]:
    config = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(config, dict) or config.get("version") != 1:
        raise MutationReportError("mutation scope 格式无效")
    if config.get("policy") != "periodic-manual-no-automatic-ci":
        raise MutationReportError("变异测试必须明确保持周期性手动、非自动 CI 策略")
    for language in ("python", "typescript"):
        section = config.get(language)
        if not isinstance(section, dict) or not section.get("targets"):
            raise MutationReportError(f"{language} mutation scope 为空")
        for target in section["targets"]:
            for key in (("pattern", "source", "tests") if language == "python" else ("source", "tests")):
                if not target.get(key):
                    raise MutationReportError(f"{language} target 缺少 {key}")
            for relative in [target["source"], *target["tests"]]:
                candidate = Path(relative)
                if candidate.is_absolute() or ".." in candidate.parts:
                    raise MutationReportError("mutation scope 路径必须是仓库内相对路径")
                resolved = (ROOT / candidate).resolve()
                if not resolved.is_relative_to(ROOT.resolve()) or not resolved.is_file():
                    raise MutationReportError(f"mutation scope 文件不存在或越界：{relative}")
    return config


def _run(command: list[str], *, cwd: Path, timeout: int = 1800) -> dict[str, Any]:
    started = time.monotonic()
    try:
        completed = subprocess.run(
            command, cwd=cwd, env=_safe_env(), stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, text=True, timeout=timeout, check=False,
        )
    except subprocess.TimeoutExpired:
        return {"status": "timeout", "exit_code": None, "duration_ms": round((time.monotonic() - started) * 1000)}
    except OSError as exc:
        return {"status": "error", "exit_code": None, "duration_ms": round((time.monotonic() - started) * 1000), "error_type": type(exc).__name__}
    return {
        "status": "passed" if completed.returncode == 0 else "failed",
        "exit_code": completed.returncode,
        "duration_ms": round((time.monotonic() - started) * 1000),
        "_output": completed.stdout,
    }


def _parse_mutmut(output: str, targets: list[dict[str, Any]], equivalent: set[str]) -> list[dict[str, str]]:
    records = []
    for line in output.splitlines():
        match = re.match(r"\s+([^:]+):\s+(.+?)\s*$", line)
        if not match:
            continue
        mutant, raw_status = match.groups()
        matched = next((target for target in targets if (
            mutant.startswith(target["pattern"].removesuffix("*"))
            if target["pattern"].endswith("*") else mutant == target["pattern"]
        )), None)
        if matched is None:
            continue
        status = "equivalent" if mutant in equivalent else normalize_mutmut_status(raw_status)
        records.append({"id": mutant, "status": status})
    for target in targets:
        pattern = target["pattern"]
        if not any(
            item["id"].startswith(pattern.removesuffix("*"))
            if pattern.endswith("*") else item["id"] == pattern
            for item in records
        ):
            records.append({"id": pattern, "status": "not_checked"})
    return records


def _parse_stryker(path: Path, targets: list[dict[str, Any]], equivalent: set[str]) -> list[dict[str, Any]]:
    result = json.loads(path.read_text(encoding="utf-8"))
    source_paths = {target["source"] for target in targets}
    records = []
    for source, file_record in result.get("files", {}).items():
        normalized_source = Path(source).as_posix()
        if not any(normalized_source.endswith(Path(target).name) for target in source_paths):
            continue
        for mutant in file_record.get("mutants", []):
            mutant_id = str(mutant.get("id", ""))
            records.append({
                "id": mutant_id,
                "source": next((target for target in source_paths if normalized_source.endswith(Path(target).name)), normalized_source),
                "line": mutant.get("location", {}).get("start", {}).get("line"),
                "mutator": mutant.get("mutatorName"),
                "status": "equivalent" if mutant_id in equivalent else normalize_stryker_status(str(mutant.get("status", "Error"))),
                "reason": str(mutant.get("statusReason") or "")[:300],
            })
    return records


def _git_state() -> dict[str, Any]:
    commit = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, text=True, capture_output=True, check=False)
    dirty = subprocess.run(["git", "status", "--porcelain"], cwd=ROOT, text=True, capture_output=True, check=False)
    return {"commit": commit.stdout.strip() if commit.returncode == 0 else None,
            "worktree_dirty": bool(dirty.stdout.strip()) if dirty.returncode == 0 else None}


def _resolve_report_dir(path: Path) -> Path:
    report_dir = path if path.is_absolute() else ROOT / path
    resolved = report_dir.resolve()
    reports_root = (ROOT / "docs/reports").resolve()
    if not resolved.is_relative_to(reports_root):
        raise MutationReportError("报告目录必须位于 docs/reports/ 内")
    return resolved


def _markdown(report: dict[str, Any]) -> str:
    lines = [
        "# PRD-TEST-2 Phase 2 变异测试报告", "",
        f"- 日期：{report['date']}", f"- 基线提交：`{report['commit'] or 'unknown'}`（运行时工作树{'有' if report['worktree_dirty'] else '无'}未提交修改）",
        "- 策略：周期性手动运行；不属于自动 CI，不阻断既有 CI。", "",
    ]
    for language, section in report["languages"].items():
        lines.extend([f"## {language}", "", f"- 执行状态：{section['run']['status']}；耗时 {section['run']['duration_ms']} ms；退出码 {section['run']['exit_code']}"])
        summary = section["summary"]
        lines.append(
                "- 变异：总数 {total}；杀死 {killed}；存活 {survived}；超时 {timeout}；编译错误 {compile_error}；运行错误 {error}；无覆盖 {no_coverage}；等价 {equivalent}；未检查 {not_checked}；mutation score {mutation_score}%（仅以 killed+survived 为分母）".format(
                total=len(section["mutants"]), **summary,
            )
        )
        lines.extend(["- 范围：", *[f"  - `{target['source']}` → `{', '.join(target['tests'])}`：{target['behavior']}" for target in section["targets"]], ""])
        non_killed = [item for item in section["mutants"] if item["status"] in {"survived", "timeout", "error", "no_coverage", "not_checked"}]
        compile_errors = [item for item in section["mutants"] if item["status"] == "compile_error"]
        if non_killed:
            lines.extend(["- 需人工复核的非 killed 项：", *[
                f"  - `{item['id']}`：{item['status']}" + (f"（{item['reason']}）" if item.get("reason") else "")
                for item in non_killed
            ], ""])
        if compile_errors:
            lines.extend(["- 编译错误变异（TypeScript 检查器拦截，未进入测试判定）：", *[
                f"  - `{item['id']}`：{item.get('reason') or '编译失败'}" for item in compile_errors
            ], ""])
        if not non_killed and not compile_errors and section["run"]["status"] == "passed":
            lines.extend(["- 结果：本次选定变异全部被测试杀死，无等价项。", ""])
    return "\n".join(lines).rstrip() + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--language", choices=("python", "typescript", "both"), default="both")
    parser.add_argument("--date", default=date.today().isoformat())
    parser.add_argument("--report-dir", type=Path, default=REPORT_DIR)
    parser.add_argument("--overwrite", action="store_true")
    args = parser.parse_args(argv)

    try:
        scope = _load_scope()
    except (OSError, json.JSONDecodeError, MutationReportError) as exc:
        print(f"mutation scope 错误：{type(exc).__name__}", file=sys.stderr)
        return 2

    try:
        report_dir = _resolve_report_dir(args.report_dir)
    except MutationReportError as exc:
        print(f"mutation 报告目录错误：{exc}", file=sys.stderr)
        return 2

    stem = REPORT_STEM.format(date=args.date)
    json_path, markdown_path = report_dir / f"{stem}.json", report_dir / f"{stem}.md"
    if not args.overwrite and (json_path.exists() or markdown_path.exists()):
        print("报告已存在；需要显式传入 --overwrite 才会替换", file=sys.stderr)
        return 2

    selected = ("python", "typescript") if args.language == "both" else (args.language,)
    language_results: dict[str, Any] = {}
    for language in selected:
        config = scope[language]
        equivalent = {str(item.get("id")) for item in config.get("equivalent_mutants", [])}
        if language == "python":
            backend = ROOT / "backend"
            executable = backend / ".venv/bin/mutmut"
            if not executable.is_file():
                run = None
                command_result = {"status": "error", "duration_ms": 0, "exit_code": None, "error_type": "mutmut_not_installed"}
            else:
                patterns = [target["pattern"] for target in config["targets"]]
                run = _run([str(executable), "run", *patterns, "--max-children", "2"], cwd=backend)
                command_result = {key: value for key, value in run.items() if key != "_output"}
            if run is not None and run["status"] == "passed":
                results = _run([str(backend / ".venv/bin/mutmut"), "results", "--all", "true"], cwd=backend)
                command_result["duration_ms"] += results["duration_ms"]
                if results["status"] != "passed":
                    command_result.update({key: value for key, value in results.items() if key != "_output"})
                    mutants = []
                else:
                    mutants = _parse_mutmut(results.pop("_output", ""), config["targets"], equivalent)
            else:
                mutants = []
        else:
            frontend = ROOT / "frontend"
            run = _run(["corepack", "pnpm", "exec", "stryker", "run", "stryker.config.mjs"], cwd=frontend)
            command_result = {key: value for key, value in run.items() if key != "_output"}
            result_path = frontend / ".stryker-report/mutation.json"
            if result_path.is_file():
                try:
                    mutants = _parse_stryker(result_path, config["targets"], equivalent)
                except (OSError, json.JSONDecodeError):
                    mutants = []
                    command_result["status"] = "error"
                    command_result["error_type"] = "invalid_stryker_report"
            else:
                mutants = []
                command_result["status"] = "error"
                command_result["error_type"] = "missing_stryker_report"

        if command_result["status"] == "passed" and any(item["status"] == "not_checked" for item in mutants):
            command_result["status"] = "failed"
            command_result["error_type"] = "mutation_target_not_checked"

        language_results[language] = {
            "run": command_result,
            "targets": config["targets"],
            "mutants": mutants,
            "summary": summarize_statuses([item["status"] for item in mutants]),
        }

    report = {
        "schema_version": 1,
        "date": args.date,
        **_git_state(),
        "policy": scope["policy"],
        "status": "passed" if all(section["run"]["status"] == "passed" for section in language_results.values()) else "failed",
        "languages": language_results,
    }
    report_dir.mkdir(parents=True, exist_ok=True)
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    markdown_path.write_text(_markdown(report), encoding="utf-8")
    print(f"变异测试报告：{markdown_path}")
    print(f"机器可读报告：{json_path}")
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
