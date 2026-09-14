"""变异测试报告解析逻辑回归。"""
import json
from pathlib import Path

import pytest

from scripts.quality.mutation_report import (
    MutationReportError,
    _load_scope,
    _parse_mutmut,
    _resolve_report_dir,
    normalize_mutmut_status,
    normalize_stryker_status,
    summarize_statuses,
)


@pytest.mark.parametrize(("raw", "expected"), [
    ("killed", "killed"),
    ("survived", "survived"),
    ("timeout", "timeout"),
    ("no tests", "no_coverage"),
    ("not checked", "not_checked"),
])
def test_mutmut_statuses_remain_distinct(raw, expected):
    assert normalize_mutmut_status(raw) == expected


@pytest.mark.parametrize(("raw", "expected"), [
    ("Killed", "killed"),
    ("Survived", "survived"),
    ("Timeout", "timeout"),
    ("NoCoverage", "no_coverage"),
    ("CompileError", "compile_error"),
    ("RuntimeError", "error"),
    ("Ignored", "not_checked"),
])
def test_stryker_statuses_remain_distinct(raw, expected):
    assert normalize_stryker_status(raw) == expected


def test_score_excludes_timeout_error_and_unchecked_from_mutation_denominator():
    summary = summarize_statuses(["killed", "killed", "survived", "timeout", "error", "not_checked"])
    assert summary == {
        "killed": 2, "survived": 1, "timeout": 1, "error": 1,
        "compile_error": 0, "no_coverage": 0, "equivalent": 0, "not_checked": 1,
        "eligible": 3, "mutation_score": 66.67,
    }


def test_mutmut_exact_target_does_not_match_a_numbered_sibling():
    records = _parse_mutmut(
        "  module.x_fn__mutmut_1: killed\n  module.x_fn__mutmut_10: survived",
        [{"pattern": "module.x_fn__mutmut_1"}],
        set(),
    )
    assert records == [{"id": "module.x_fn__mutmut_1", "status": "killed"}]


def test_missing_exact_mutmut_target_is_reported_as_not_checked():
    assert _parse_mutmut("", [{"pattern": "module.x_fn__mutmut_1"}], set()) == [
        {"id": "module.x_fn__mutmut_1", "status": "not_checked"},
    ]


def test_scope_is_explicit_and_manual_only():
    scope = _load_scope()
    assert scope["policy"] == "periodic-manual-no-automatic-ci"
    assert len(scope["python"]["targets"]) == 7
    assert scope["typescript"]["targets"][0]["tests"] == ["frontend/test/optimisticMutation.test.ts"]


def test_scope_rejects_automatic_ci_policy(tmp_path, monkeypatch):
    from scripts.quality import mutation_report

    path = tmp_path / "scope.json"
    path.write_text(json.dumps({"version": 1, "policy": "automatic-ci", "python": {}, "typescript": {}}), encoding="utf-8")
    monkeypatch.setattr(mutation_report, "ROOT", tmp_path)
    with pytest.raises(MutationReportError, match="手动"):
        _load_scope(path)


def test_mutation_report_dir_supports_archived_reruns_under_reports(tmp_path, monkeypatch):
    from scripts.quality import mutation_report

    reports = tmp_path / "docs" / "reports"
    reports.mkdir(parents=True)
    monkeypatch.setattr(mutation_report, "ROOT", tmp_path)
    assert _resolve_report_dir(Path("docs/reports/phase3-rerun")) == reports / "phase3-rerun"


def test_mutation_report_dir_rejects_paths_outside_reports(tmp_path, monkeypatch):
    from scripts.quality import mutation_report

    (tmp_path / "docs" / "reports").mkdir(parents=True)
    monkeypatch.setattr(mutation_report, "ROOT", tmp_path)
    with pytest.raises(MutationReportError, match="docs/reports"):
        _resolve_report_dir(Path("backend"))
