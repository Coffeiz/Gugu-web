"""CRAP 报告计算与输入/脱敏边界回归。"""

import json
from pathlib import Path
import subprocess

import pytest

import scripts.quality.crap_report as crap_report
from scripts.quality.crap_report import (
    ReportError,
    _run_test,
    _assert_no_sensitive_fields,
    _function_coverage_span,
    _function_records,
    coverage_ratio_for_span,
    crap_score,
    main,
    risk_level,
    validate_scope,
)


ROOT = Path(__file__).resolve().parents[2]


def test_crap_formula_and_display_risk_are_reproducible():
    assert crap_score(2, 0.5) == pytest.approx(2.5)
    assert risk_level(2.5) == "低"
    assert risk_level(15) == "中"
    assert risk_level(30) == "高"


def test_function_coverage_uses_only_executable_lines_in_span():
    assert coverage_ratio_for_span({1, 2, 3, 8}, {1, 3}, 2, 4) == pytest.approx(0.5)
    assert coverage_ratio_for_span({1, 8}, {1}, 2, 4) is None


def test_scope_is_explicit_repo_relative_and_files_exist():
    config = json.loads((ROOT / "scripts/quality/crap_scope.json").read_text(encoding="utf-8"))
    validated = validate_scope(config, ROOT)
    assert [(entry["language"], entry["source"]) for entry in validated] == [
        ("python", "backend/agent/context/budget.py"),
        ("typescript", "frontend/src/utils/optimisticMutation.ts"),
    ]
    assert validated[0]["tests"] == [
        "backend/tests/test_context_budget.py",
        "backend/tests/test_session_history.py",
    ]
    assert validated[0]["function_tests"]["truncate_messages"] == [
        "backend/tests/test_context_budget.py"
    ]


@pytest.mark.parametrize("config", [{"version": 1, "scopes": []}, {"version": 1, "scopes": ""}])
def test_empty_scope_fails_without_creating_a_report(config):
    with pytest.raises(ReportError, match="范围为空"):
        validate_scope(config, ROOT)


def test_scope_rejects_missing_absolute_and_parent_paths(tmp_path):
    base = {
        "version": 1,
        "scopes": [{
            "language": "python", "source": "missing.py", "test": "missing_test.py",
            "domain": "测试", "layer": "L0", "ci": "不阻断",
        }],
    }
    with pytest.raises(ReportError, match="不存在"):
        validate_scope(base, tmp_path)
    base["scopes"][0]["source"] = "/tmp/private.py"
    with pytest.raises(ReportError, match="相对路径"):
        validate_scope(base, tmp_path)
    base["scopes"][0]["source"] = "../private.py"
    with pytest.raises(ReportError, match="相对路径"):
        validate_scope(base, tmp_path)


def test_function_test_mapping_must_be_part_of_declared_source_test_scope(tmp_path):
    (tmp_path / "backend").mkdir()
    (tmp_path / "tests").mkdir()
    (tmp_path / "backend/sample.py").write_text("def sample():\n    return 1\n", encoding="utf-8")
    (tmp_path / "tests/test_sample.py").write_text("def test_sample():\n    assert True\n", encoding="utf-8")
    (tmp_path / "tests/test_other.py").write_text("def test_other():\n    assert True\n", encoding="utf-8")
    config = {
        "version": 1,
        "scopes": [{
            "language": "python",
            "source": "backend/sample.py",
            "tests": ["tests/test_sample.py"],
            "function_tests": {"sample": ["tests/test_other.py"]},
            "domain": "测试",
            "layer": "L0",
            "ci": "不阻断",
        }],
    }

    with pytest.raises(ReportError, match="登记的 tests"):
        validate_scope(config, tmp_path)


def test_python_function_coverage_excludes_imported_definition_line(tmp_path):
    source = tmp_path / "sample.py"
    source.write_text(
        "def not_called(\n"
        "    value: int,\n"
        "):\n"
        "    return value + 1\n",
        encoding="utf-8",
    )

    start, end = _function_coverage_span(source, "python", "not_called", 1, 4)

    assert (start, end) == (4, 4)
    assert coverage_ratio_for_span({1, 4}, {1}, start, end) == 0.0


def test_function_report_only_claims_explicit_test_associations(tmp_path, monkeypatch):
    source = tmp_path / "sample.py"
    source.write_text(
        "def mapped(value):\n"
        "    return value\n"
        "\n"
        "def pending(value):\n"
        "    return value + 1\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(crap_report, "ROOT", tmp_path)
    monkeypatch.setattr(crap_report, "_coverage_for_file", lambda *_: ({2, 5}, {2, 5}))
    entry = {
        "language": "python",
        "source": "sample.py",
        "tests": ["tests/test_sample.py"],
        "function_tests": {"mapped": ["tests/test_sample.py"]},
        "domain": "测试",
        "layer": "L0",
        "ci": "不阻断",
    }

    records = _function_records(entry, tmp_path / "coverage.json")

    mapped, pending = records
    assert mapped["tests"] == ["tests/test_sample.py"]
    assert mapped["test_association"] == "registered"
    assert pending["tests"] == []
    assert pending["test_association"] == "pending_manual"
    markdown = crap_report._markdown({
        "date": "2026-09-13",
        "commit": "test-commit",
        "worktree_dirty": False,
        "status": "passed",
        "duration_ms": 1,
        "runs": [],
        "items": records,
        "summary": {"functions_total": 2, "complexity_hotspots": 0},
        "tools": {
            "lizard": "test",
            "pytest_cov": "test",
            "coverage": "test",
            "vitest": "test",
            "vitest_coverage_v8": "test",
        },
        "exclusions": [],
    })
    assert "待人工关联" in markdown


def test_report_rejects_sensitive_payload_fields():
    with pytest.raises(ReportError, match="敏感字段"):
        _assert_no_sensitive_fields({"items": [{"api_key": "redacted"}]})
    _assert_no_sensitive_fields({"items": [{"cc": 3, "coverage": 0.75, "source": "backend/sample.py"}]})


def test_failed_test_process_is_reported_without_capturing_output(monkeypatch, tmp_path):
    monkeypatch.setattr(
        "scripts.quality.crap_report.subprocess.run",
        lambda *args, **kwargs: subprocess.CompletedProcess(args[0], 7, stdout="private payload"),
    )
    entry = {
        "language": "python",
        "source": "backend/agent/context/budget.py",
        "tests": ["backend/tests/test_context_budget.py"],
        "domain": "测试",
        "layer": "L0",
        "ci": "不阻断",
    }

    result = _run_test("python", [entry], tmp_path)

    assert result["status"] == "failed"
    assert result["exit_code"] == 7
    assert "stdout" not in result
    assert "private payload" not in str(result)
    assert "<TEMP>" in result["command"]


def test_test_timeout_has_its_own_status(monkeypatch, tmp_path):
    def timeout(*args, **kwargs):
        raise subprocess.TimeoutExpired(args[0], timeout=300)

    monkeypatch.setattr("scripts.quality.crap_report.subprocess.run", timeout)
    entry = {
        "language": "typescript",
        "source": "frontend/src/utils/optimisticMutation.ts",
        "tests": ["frontend/test/optimisticMutation.test.ts"],
        "domain": "测试",
        "layer": "L0",
        "ci": "不阻断",
    }

    result = _run_test("typescript", [entry], tmp_path)

    assert result["status"] == "timeout"
    assert result["exit_code"] is None


def test_cli_writes_explicit_failed_report_when_test_runner_fails(tmp_path, monkeypatch):
    monkeypatch.setattr(crap_report, "_tool_versions", lambda: {
        "python": "3.x",
        "lizard": "test",
        "pytest_cov": "test",
        "coverage": "test",
        "vitest": "test",
        "vitest_coverage_v8": "test",
    })
    monkeypatch.setattr(crap_report, "_run_test", lambda *_: {
        "status": "failed",
        "exit_code": 7,
        "duration_ms": 1,
        "coverage_path": tmp_path / "missing-coverage.json",
        "command": "pytest <TEMP>",
    })
    output_dir = tmp_path / "reports"

    exit_code = main([
        "--scope-file", str(ROOT / "scripts/quality/crap_scope.json"),
        "--report-dir", str(output_dir),
        "--language", "python",
        "--date", "2026-09-13",
    ])

    stem = crap_report.REPORT_STEM.format(date="2026-09-13")
    json_report = json.loads((output_dir / f"{stem}.json").read_text(encoding="utf-8"))
    markdown_report = (output_dir / f"{stem}.md").read_text(encoding="utf-8")
    assert exit_code == 1
    assert json_report["status"] == "failed"
    assert json_report["runs"][0]["status"] == "failed"
    assert json_report["errors"][0]["kind"] == "failed"
    assert "状态：failed" in markdown_report


def test_cli_empty_scope_exits_without_writing_a_report(tmp_path, capsys):
    scope_file = tmp_path / "empty-scope.json"
    scope_file.write_text(json.dumps({"version": 1, "scopes": []}), encoding="utf-8")
    report_dir = tmp_path / "reports"

    assert main(["--scope-file", str(scope_file), "--report-dir", str(report_dir)]) == 2
    assert not report_dir.exists()
    assert "范围为空" in capsys.readouterr().err
