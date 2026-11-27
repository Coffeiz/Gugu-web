"""引用索引流式恢复的兼容性与有界读取回归。"""
from contextlib import contextmanager
import json
from pathlib import Path

from agent.im import qq_ref_index
from agent.im.qq_ref_index import QQRefIndex


def test_loading_preserves_latest_value_expiry_and_unterminated_final_record(tmp_path, monkeypatch):
    monkeypatch.setenv("QQ_REF_INDEX_DIR", str(tmp_path))
    monkeypatch.setattr(qq_ref_index.time, "time", lambda: 1000000)
    index = QQRefIndex(owner="synthetic-owner", bot_id="synthetic-bot")
    records = [
        {"k": "repeated", "t": 1000000, "v": {"content": "旧值", "_stored_at": 1000000}},
        {"k": "expired", "t": 1, "v": {"content": "过期", "_stored_at": 1}},
        {"k": "repeated", "t": 1000000, "v": {"content": "新值", "_stored_at": 1000000}},
    ]
    text = "\n".join(json.dumps(record) for record in records)
    final = {"k": "last", "t": 1000000, "v": {"content": "末行", "_stored_at": 1000000}}
    index._path.write_text(text + '\n\n{"truncated":\n' + json.dumps(final), encoding="utf-8")

    assert index.get("repeated")["content"] == "新值"
    assert index.get("expired") is None
    assert index.get("last")["content"] == "末行"


def test_restored_line_count_still_triggers_compaction(tmp_path, monkeypatch):
    monkeypatch.setenv("QQ_REF_INDEX_DIR", str(tmp_path))
    monkeypatch.setattr(qq_ref_index, "_COMPACT_LINES", 2)
    monkeypatch.setattr(qq_ref_index.time, "time", lambda: 1000000)
    index = QQRefIndex(owner="synthetic-owner", bot_id="synthetic-bot")
    record = {"k": "existing", "t": 1000000, "v": {"content": "已有", "_stored_at": 1000000}}
    index._path.write_text((json.dumps(record) + "\n") * 5, encoding="utf-8")

    index.set("new", {"content": "新增"})

    assert len(index._path.read_text(encoding="utf-8").splitlines()) == 2
    reopened = QQRefIndex(owner="synthetic-owner", bot_id="synthetic-bot")
    assert reopened.get("existing")["content"] == "已有"
    assert reopened.get("new")["content"] == "新增"


def test_loading_avoids_unbounded_reads(tmp_path, monkeypatch):
    """通过实际文件接口阻止整文件读取，保护大索引恢复时的内存上界。"""
    monkeypatch.setenv("QQ_REF_INDEX_DIR", str(tmp_path))
    first = QQRefIndex(owner="synthetic-owner", bot_id="synthetic-bot")
    first.set("message", {"content": "小北", "attachments": [{"url": "https://example.com/file"}]})
    original_open = Path.open

    class BoundedReader:
        def __init__(self, handle):
            self.handle = handle

        def __iter__(self):
            return iter(self.handle)

        def read(self, size=-1):
            assert size >= 0, "引用索引不得整文件读入内存"
            return self.handle.read(size)

    @contextmanager
    def bounded_open(path, *args, **kwargs):
        with original_open(path, *args, **kwargs) as handle:
            yield BoundedReader(handle) if path == first._path else handle

    monkeypatch.setattr(Path, "open", bounded_open)
    reopened = QQRefIndex(owner="synthetic-owner", bot_id="synthetic-bot")
    assert reopened.get("message")["attachments"] == [{"url": "https://example.com/file"}]
