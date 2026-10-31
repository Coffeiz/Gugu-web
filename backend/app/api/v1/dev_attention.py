"""开发环境使用的 IM-17 v3.0.6 注意力算法沙盒。"""
from __future__ import annotations

from time import time
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field

from agent.im.auto_reply.attention import (
    ATTENTION_ALGORITHM_VERSION,
    AttentionMessage,
    AttentionMode,
    AttentionSnapshot,
    BotReplyFact,
    decide_attention,
)
from app.core.security import get_current_user

router = APIRouter(prefix="/dev/attention", tags=["dev-attention"])


class AttentionScoreRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str = Field(max_length=20_000)
    anchor_text: str = Field(default="", max_length=20_000)
    before_anchor: list[str] = Field(default_factory=list, max_length=5)
    after_anchor: list[str] = Field(default_factory=list, max_length=5)
    gap_seconds: int = Field(default=30, ge=0, le=600)
    member_active_age_seconds: int | None = Field(default=None, ge=0, le=600)
    aliases: list[str] = Field(default_factory=lambda: ["咕咕"], max_length=20)
    mode: Literal["quiet", "natural", "active", "autonomous"] = "natural"
    snapshot_complete: bool = True


def _message(text: str, event_ms: int, ordinal: int, *, sender: str, is_bot: bool = False) -> AttentionMessage:
    return AttentionMessage.from_payload(f"{event_ms}-{ordinal}", {
        "platform": "sandbox", "channel_id": "sandbox", "chat_id": "sandbox",
        "platform_user_id": sender, "sender_is_bot": is_bot, "text": text,
        "native_bot_mentioned": False, "mentions_other_bot": False,
        "mentions_other_member": False,
    })


@router.post("/score")
async def score_attention(request: AttentionScoreRequest, _user=Depends(get_current_user)):
    """用合成因果窗口调用生产 scorer；不返回输入正文或匹配片段。"""
    now_ms = int(time() * 1000)
    anchor_ms = now_ms - request.gap_seconds * 1_000
    messages: list[AttentionMessage] = []
    for index, text in enumerate(request.before_anchor[-5:]):
        messages.append(_message(text, anchor_ms - (len(request.before_anchor[-5:]) - index) * 1_000, index + 1, sender=f"member-{index + 1}"))
    for index, text in enumerate(request.after_anchor[:5]):
        at_ms = min(now_ms - 1, anchor_ms + (index + 1) * 1_000)
        if at_ms > anchor_ms:
            messages.append(_message(text, at_ms, index + 20, sender=f"member-{index + 20}"))
    current = _message(request.text, now_ms, 99, sender="member-current")
    anchor = BotReplyFact(
        platform_message_id="sandbox-accepted-anchor",
        sent_at_ms=anchor_ms,
        recipient_sender_id=None,
        accepted=bool(request.anchor_text),
        source_attention_kind="proactive",
        final_text=request.anchor_text or None,
        delivery_id="sandbox-delivery",
    )
    snapshot = AttentionSnapshot(
        messages=tuple(messages), complete=request.snapshot_complete,
        latest_accepted_final=anchor if request.anchor_text else None,
        accepted_outbound_facts=tuple(
            fact for fact in (
                anchor if request.anchor_text else None,
                BotReplyFact(
                    platform_message_id="sandbox-member-active",
                    sent_at_ms=now_ms - request.member_active_age_seconds * 1_000,
                    recipient_sender_id="member-current",
                    accepted=True,
                    source_attention_kind="member_ACTIVE",
                    final_text=None,
                    delivery_id="sandbox-member-active-delivery",
                ) if request.member_active_age_seconds is not None else None,
            ) if fact is not None
        ),
    )
    decision = decide_attention(current, snapshot, AttentionMode(request.mode), bot_aliases=tuple(request.aliases))
    return {
        "algorithm_version": ATTENTION_ALGORITHM_VERSION,
        "kind": decision.kind.value,
        "score": decision.score,
        "threshold": decision.threshold,
        "state": decision.state,
        "scene_type": decision.scene_type,
        "scene_score": decision.scene_score,
        "ask_raw_score": decision.ask_raw_score,
        "ask_position_weight": decision.ask_position_weight,
        "ask_punctuation_weight": decision.ask_punctuation_weight,
        "ask_adjusted_score": decision.ask_adjusted_score,
        "ask_span_start": decision.ask_span_start,
        "ask_span_end": decision.ask_span_end,
        "capability_strength": decision.capability_strength,
        "capability_span_start": decision.capability_span_start,
        "capability_span_end": decision.capability_span_end,
        "capability_position_weight": decision.capability_position_weight,
        "topic_score": decision.topic_score,
        "topic_raw_score": decision.topic_raw_score,
        "reasons": list(decision.reasons),
        "score_breakdown": [{"rule": key, "weight": value} for key, value in decision.score_breakdown],
        "anchor_event_id": decision.anchor_event_id,
        "topic_match_event_id": decision.topic_match_event_id,
        "matched_span_lengths": decision.matched_span_lengths,
        "snapshot_complete": snapshot.complete,
    }


@router.get("/defaults")
async def attention_defaults(_user=Depends(get_current_user)):
    return {
        "algorithm_version": ATTENTION_ALGORITHM_VERSION,
        "thresholds": {"quiet": 85, "natural": 65, "active": 55},
        "topic_ttl_seconds": 600,
        "topic_half_life_seconds": 360,
        "member_active_ttl_seconds": 180,
    }
