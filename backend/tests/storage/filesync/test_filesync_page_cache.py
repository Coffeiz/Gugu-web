"""全量文件校验避免把大型冷文件留在 page cache 的回归测试。"""

import hashlib

from app.services.filesync import reconcile


def test_forced_large_file_hash_advises_cache_drop_in_bounded_ranges(tmp_path, monkeypatch):
    content = b"page-cache-test" * (1024 * 1024)
    path = tmp_path / "large.bin"
    path.write_bytes(content)
    calls = []

    def record_advice(fd, offset, length, advice):
        calls.append((fd, offset, length, advice))

    monkeypatch.setattr(reconcile.os, "posix_fadvise", record_advice, raising=False)
    monkeypatch.setattr(reconcile.os, "POSIX_FADV_DONTNEED", 4, raising=False)

    digest = reconcile._stable_fingerprint(path, discard_cache=True)

    assert digest == hashlib.sha256(content).hexdigest()
    assert calls
    assert all(offset % (1024 * 1024) == 0 for _, offset, _, _ in calls)
    assert all(length <= 8 * 1024 * 1024 for _, _, length, _ in calls)
    assert all(advice == 4 for _, _, _, advice in calls)


def test_incremental_or_small_file_hash_does_not_advise_cache(tmp_path, monkeypatch):
    path = tmp_path / "small.txt"
    path.write_text("small", encoding="utf-8")
    calls = []
    monkeypatch.setattr(
        reconcile.os, "posix_fadvise",
        lambda *args: calls.append(args), raising=False,
    )
    monkeypatch.setattr(reconcile.os, "POSIX_FADV_DONTNEED", 4, raising=False)

    reconcile._stable_fingerprint(path, discard_cache=True)
    assert calls == []

    large_path = tmp_path / "large-incremental.bin"
    large_path.write_bytes(b"incremental" * (1024 * 1024))
    reconcile._stable_fingerprint(large_path)
    assert calls == []


def test_cache_advice_failure_does_not_fail_hash(tmp_path, monkeypatch):
    content = b"page-cache-test" * (1024 * 1024)
    path = tmp_path / "large.bin"
    path.write_bytes(content)
    diagnostics = []

    def fail_advice(*_args):
        raise OSError("advice unsupported")

    monkeypatch.setattr(reconcile.os, "posix_fadvise", fail_advice, raising=False)
    monkeypatch.setattr(reconcile.os, "POSIX_FADV_DONTNEED", 4, raising=False)
    monkeypatch.setattr(reconcile, "diag_log", lambda event, exc: diagnostics.append((event, exc)))

    actual = reconcile._stable_fingerprint(path, discard_cache=True)

    assert actual == hashlib.sha256(content).hexdigest()
    assert len(diagnostics) == 1
    assert diagnostics[0][0] == "filesync.cache_advice_failed"
