"""共享的 run/round 历史保护策略。

字符/token 预算只决定何时压缩及压缩请求容量；常规历史保留统一按完整轮次划界。
"""
from __future__ import annotations

import re
from collections.abc import Sequence
from typing import Any


PROTECTED_ROUNDS_PER_RUN = 10
_ROUND_NUMBER = re.compile(r"^round-(\d+)$")


def _round_number(value: Any) -> int | None:
    match = _ROUND_NUMBER.fullmatch(str(value or ""))
    return int(match.group(1)) if match else None


def rolling_round_start(
    round_starts: Sequence[tuple[int, int]], current_round: int,
    keep_rounds: int = PROTECTED_ROUNDS_PER_RUN,
) -> int | None:
    """当前 run 保留最近 N 个已完成 provider round 的 history 起点。"""
    first_round = max(1, int(current_round) - max(1, int(keep_rounds)))
    return next(
        (index for round_number, index in round_starts if round_number == first_round),
        None,
    )


def protected_message_ids(
    rows: Sequence[Any], keep_rounds: int = PROTECTED_ROUNDS_PER_RUN,
) -> set[int]:
    """选择最近一个已完成 run 的最后 N 个 round 所属消息行。

    尚未标注 run/round 的旧数据不猜测归属；它们会进入压缩区，由既有摘要承接。
    """
    latest_run_id = next(
        (str(getattr(row, "run_id", "") or "") for row in reversed(rows)
         if getattr(row, "run_id", None)),
        "",
    )
    if not latest_run_id:
        # 旧数据没有 run/round 标识时，将连续的 canonical batch 作为完整单元，
        # 普通消息各自作为兼容单元；不再退回字符窗口。
        units: list[list[Any]] = []
        for row in rows:
            batch_id = getattr(row, "canonical_batch_id", None)
            if batch_id is not None and units and getattr(units[-1][0], "canonical_batch_id", None) == batch_id:
                units[-1].append(row)
            else:
                units.append([row])
        return {
            int(row.id)
            for unit in units[-max(1, int(keep_rounds)):]
            for row in unit
            if getattr(row, "id", None) is not None
        }

    run_rows = [row for row in rows if str(getattr(row, "run_id", "") or "") == latest_run_id]
    round_numbers = sorted({
        number for row in run_rows
        if (number := _round_number(getattr(row, "round_id", None))) is not None
    })
    protected_rounds = set(round_numbers[-max(1, int(keep_rounds)):])
    return {
        int(row.id) for row in run_rows
        if _round_number(getattr(row, "round_id", None)) in protected_rounds
        and getattr(row, "id", None) is not None
    }


def protected_unit_offset(
    units: Sequence[Sequence[int]], keep_rounds: int = PROTECTED_ROUNDS_PER_RUN,
) -> int:
    """返回无 run 元数据历史中最近 N 个完整单元的起始单元下标。"""
    if not units:
        return 0
    return max(0, len(units) - max(1, int(keep_rounds)))
