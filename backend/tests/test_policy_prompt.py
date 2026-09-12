"""policy.md 行为原则内容钉：提示词契约与既定行为决策保持同步，防止漂移。"""

from pathlib import Path

_POLICY = Path(__file__).resolve().parents[1] / "agent" / "prompts" / "policy.md"


def test_policy_pins_short_affirmation_rule():
    """简短肯定=同意并立即执行（2026-09 定稿：裸「可以」被误读成「收下了/回头再说」的案例驱动）。"""
    text = _POLICY.read_text(encoding="utf-8")
    assert "简短肯定 = 同意并立即执行" in text
    assert "现在就做" in text
    assert "回头再说" in text
