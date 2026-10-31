"""开发算法沙盒必须调用 v3 生产判定器并隐藏输入明文。"""
import pytest
from pydantic import ValidationError

from app.api.v1.dev_attention import AttentionScoreRequest, attention_defaults, score_attention


@pytest.mark.asyncio
async def test_dev_attention_defaults_match_v3_contract():
    defaults = await attention_defaults(_user=object())

    assert defaults == {
        "algorithm_version": "attention-v3.0.6",
        "thresholds": {"quiet": 85, "natural": 65, "active": 55},
        "topic_ttl_seconds": 600,
        "topic_half_life_seconds": 360,
        "member_active_ttl_seconds": 180,
    }


@pytest.mark.asyncio
async def test_dev_attention_uses_accepted_anchor_and_returns_only_safe_diagnostics():
    request = AttentionScoreRequest(
        anchor_text="翻个跟斗——来了，落地了",
        text="他哪会翻跟斗",
        gap_seconds=124,
    )

    result = await score_attention(request, _user=object())

    assert result["algorithm_version"] == "attention-v3.0.6"
    assert result["state"] == "TOPIC"
    assert result["scene_score"] == 0
    assert result["topic_raw_score"] == pytest.approx(.75)
    assert result["score"] == pytest.approx(68.34, abs=.2)
    assert result["kind"] == "PROACTIVE"
    assert "他哪会翻跟斗" not in repr(result)
    assert "翻个跟斗" not in repr(result)
    assert "matched_spans" not in result


@pytest.mark.asyncio
async def test_dev_attention_reproduces_member_active_and_expiry_with_synthetic_receipt():
    active = await score_attention(
        AttentionScoreRequest(text="改成明天吧", member_active_age_seconds=179),
        _user=object(),
    )
    expired = await score_attention(
        AttentionScoreRequest(text="改成明天吧", member_active_age_seconds=180),
        _user=object(),
    )
    reaction = await score_attention(
        AttentionScoreRequest(text="谢谢", member_active_age_seconds=20),
        _user=object(),
    )

    assert active["kind"] == "MEMBER_ACTIVE"
    assert active["score"] == 100
    assert active["threshold"] is None
    assert expired["kind"] == "PASSIVE"
    assert reaction["kind"] == "PASSIVE"


@pytest.mark.asyncio
async def test_dev_attention_expired_anchor_becomes_cold_and_open_question_survives():
    result = await score_attention(
        AttentionScoreRequest(
            anchor_text="今晚音乐真好听",
            text="Python 连接池超时怎么处理？",
            gap_seconds=600,
        ),
        _user=object(),
    )

    assert result["state"] == "COLD"
    assert result["scene_type"] == "ASK"
    assert result["score"] == pytest.approx(90)


@pytest.mark.asyncio
async def test_dev_attention_exposes_long_ask_and_capability_evidence_without_text():
    ask_text = "背景资料" * 300 + "。这个项目为什么延期？。" + "补充材料" * 300
    ask = await score_attention(AttentionScoreRequest(text=ask_text), _user=object())
    assert ask["ask_raw_score"] == pytest.approx(.90)
    assert ask["ask_position_weight"] == pytest.approx(.55, abs=.01)
    assert ask["ask_punctuation_weight"] == pytest.approx(1.0)
    assert ask["ask_adjusted_score"] == pytest.approx(.495, abs=.01)
    assert ask["ask_span_start"] is not None
    assert ask["ask_span_end"] > ask["ask_span_start"]
    assert ask["score"] == pytest.approx(49.5, abs=1)
    assert ask["kind"] == "PASSIVE"
    assert ask["threshold"] == 65
    assert ask_text not in repr(ask)

    punctuated = await score_attention(
        AttentionScoreRequest(text="为什么延期。"), _user=object(),
    )
    assert punctuated["ask_punctuation_weight"] == pytest.approx(.65)
    assert punctuated["ask_adjusted_score"] == pytest.approx(.585)
    assert punctuated["score"] == pytest.approx(58.5)

    cap_text = "背景资料" * 300 + "。咕咕帮我创建项目。" + "补充材料" * 300
    cap = await score_attention(AttentionScoreRequest(text=cap_text), _user=object())
    assert cap["kind"] == "CAPABILITY_ACTION"
    assert cap["capability_strength"] == "strong"
    assert cap["capability_position_weight"] is not None
    assert cap["capability_span_start"] is not None
    assert cap_text not in repr(cap)


def test_dev_attention_rejects_removed_v2_parameters():
    with pytest.raises(ValidationError):
        AttentionScoreRequest(text="event loop", idf_window_size=101)
