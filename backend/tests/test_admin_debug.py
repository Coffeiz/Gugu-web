from datetime import datetime
from pathlib import Path

from app.api.v1.admin_debug import _EPOCH, _fmt_time, _line_dt, _read_log_page


def test_debug_log_time_keeps_date_for_cross_day_tail():
    emitted = datetime(2026, 9, 22, 17, 48, 34)

    assert _fmt_time(emitted) == "09-22 17:48:34"


def test_debug_log_time_keeps_carried_timestamp_for_traceback_lines():
    emitted = _line_dt("09-21 17:48:34 Traceback (most recent call last):", _EPOCH)

    assert _fmt_time(emitted) == "09-21 17:48:34"
    assert _fmt_time(_line_dt("  File \"worker.py\", line 1", emitted)) == "09-21 17:48:34"


def test_debug_log_page_returns_older_cursor_without_reading_the_whole_history(tmp_path: Path):
    path = tmp_path / "worker.log"
    path.write_text("one\ntwo\nthree\nfour\n", encoding="utf-8")

    latest, cursor, _ = _read_log_page(path, None, 2)
    older, older_cursor, _ = _read_log_page(path, cursor, 2)

    assert latest == ["three", "four"]
    assert older == ["one", "two"]
    assert cursor == 8
    assert older_cursor == 0


def test_debug_log_page_inherits_timestamp_when_page_starts_with_traceback_continuation(
    tmp_path: Path,
):
    path = tmp_path / "worker.log"
    path.write_text(
        "09-22 12:00:00 ERROR request failed\n"
        "Traceback (most recent call last):\n"
        "  File \"worker.py\", line 1\n"
        "09-22 12:01:00 INFO recovered\n",
        encoding="utf-8",
    )

    page, _, carried = _read_log_page(path, None, 2)

    assert page == ['  File "worker.py", line 1', "09-22 12:01:00 INFO recovered"]
    assert _fmt_time(carried) == "09-22 12:00:00"
