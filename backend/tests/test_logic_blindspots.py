"""P1 快赢：为 CRAP 全量扫描发现的 0% 覆盖纯逻辑函数补确定性单测。

来源：docs/reports/2026-09-14-INVEST-CRAP全量风险盘点与治理方案.md §4 P1。
只锚定当前真实行为（回归保护），不改变任何实现。
"""

from agent.im.replies import _tool_result_summary
from agent.memory.lens import _similar
from agent.memory.longterm_compaction import _pattern_strength
from agent.memory.reflection import _misperc_regex
from agent.rag.source_text import split_sections
from agent.runtime.loopscope_trace.utils import _classify_followup, _system_message_text
from agent.tools.files.transfer import _fmt_age
from app.core.config import normalize_dimensions


def test_split_sections_empty_and_no_heading():
    assert split_sections("") == []
    assert split_sections(None) == []
    assert split_sections("普通正文没有标题") == [("", "普通正文没有标题")]


def test_split_sections_by_heading_keeps_title_as_context():
    text = "# 标题一\n正文 A\n## 子题\n正文 B"
    assert split_sections(text) == [("标题一", "正文 A"), ("子题", "正文 B")]


def test_split_sections_keeps_preamble_before_first_heading():
    assert split_sections("开场白\n# 标题\n正文") == [("", "开场白"), ("标题", "正文")]


def test_split_sections_drops_headings_without_body():
    assert split_sections("# 空节\n## 有内容\n内容") == [("有内容", "内容")]


def test_normalize_dimensions_maps_empty_and_invalid_to_zero():
    assert normalize_dimensions(None) == 0
    assert normalize_dimensions("") == 0
    assert normalize_dimensions("   ") == 0
    assert normalize_dimensions("abc") == 0
    assert normalize_dimensions(" 36 ") == 36
    assert normalize_dimensions(24) == 24
    assert normalize_dimensions(30.9) == 30


def test_fmt_age_buckets_elapsed_time():
    assert _fmt_age(None, 3600) == "未知"
    assert _fmt_age(-5, 3600) == "未知"
    assert _fmt_age(1800, 3600) == "约30分钟前"
    assert _fmt_age(3600 * 24 - 7200, 3600 * 24) == "约2小时前"
    assert _fmt_age(0, 3600 * 24 * 3) == "约3天前"
    assert _fmt_age(0, 3600) == "约1小时前"


def test_pattern_strength_orders_observed_before_manual_and_tolerates_legacy_fields():
    observed = {"kind": "observed", "conf": 0.4, "importance": 3, "ts": 100.0}
    manual = {"kind": "manual", "conf": 0.9, "importance": 5, "ts": 200.0}
    assert _pattern_strength(observed) > _pattern_strength(manual)
    assert _pattern_strength({"imp": 4}) == (0, 0.0, 4, 0.0)
    assert _pattern_strength({}) == (0, 0.0, 0, 0.0)


def test_system_message_text_extracts_first_system_content():
    assert _system_message_text("not-a-list") == ""
    assert _system_message_text([{"role": "user", "content": "x"}]) == ""
    assert _system_message_text([{"role": "system", "content": "稳定前缀"}]) == "稳定前缀"
    blocks = [
        {"type": "text", "text": "A"},
        {"type": "image", "text": "忽略"},
        {"type": "text", "text": "B"},
    ]
    assert _system_message_text([{"role": "system", "content": blocks}]) == "AB"
    assert _system_message_text(["junk", {"role": "system", "content": "ok"}]) == "ok"


def test_classify_followup_matches_guard_categories():
    assert _classify_followup("内部核验通过") == "verification"
    assert _classify_followup("需要查询数据") == "verification"
    assert _classify_followup("工具 调用受限") == "tool-use guard"
    assert _classify_followup("意图不明确") == "intent guard"
    assert _classify_followup("用户 明确要求了") == "decision guard"
    assert _classify_followup("其他情况") == "follow-up guard"


def test_misperc_regex_matches_correction_markers_only_in_head():
    hit = _misperc_regex("user-abcdef1234", "不对，应该是周三")
    assert hit is not None
    assert hit["via"] == "regex"
    assert hit["marker"] == "不对，"
    assert hit["t"] == "misperc"
    assert hit["kind"] == "未判"
    assert _misperc_regex("u", "今天天气不错") is None
    assert _misperc_regex("u", "") is None
    assert _misperc_regex("u", "这" * 20 + "不对，") is None


def test_tool_result_summary_compacts_whitespace_and_truncates():
    assert _tool_result_summary(None) == ""
    assert _tool_result_summary("  多行\n文本\t折叠  ") == "多行 文本 折叠"
    assert _tool_result_summary({"b": 2, "a": 1}) == '{"b": 2, "a": 1}'
    assert _tool_result_summary("x" * 400) == "x" * 319 + "…"


def test_tool_result_summary_falls_back_to_str_for_unserializable():
    class _Unserializable:
        def __str__(self):
            return "原始字符串"

    assert _tool_result_summary(_Unserializable()) == "原始字符串"


def test_lens_similar_uses_trigger_as_stable_key():
    assert _similar("「没事」→安抚", "「没事」→表示不在意") is True
    assert _similar("「没事」→安抚", "「没事」") is True
    assert _similar("「没事」", "「没事了」→收尾") is True
    # 触发语不同即不同条，即便正文措辞相似
    assert _similar("「没事」→安抚", "「好吧」→安抚") is False


def test_lens_similar_falls_back_to_full_sentence_match_without_trigger():
    assert _similar("不要过度澄清，直接回答", "不要过度澄清，直接回答！") is True
    assert _similar("不要过度澄清直接回答", "不要过度澄清直接回答问题") is True
    assert _similar("", "任意") is False
    assert _similar("短句", "完全不同的另一句") is False
