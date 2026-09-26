"""交互暂停与恢复的判定与收尾（PRD-LLM-25 LLM25-010 / FR-LLM25-004）。

交互的创建、等待、消费和确认授权事实源仍在 `app.services.interactions` 与
`agent.interactions.confirmations`；本模块只做答案分类和取消收尾帧这类
纯判定/编码，供 `_run_loop` 的确认、用户回答与取消路径共用。
"""
from __future__ import annotations

import json


PAUSE_CLOSE_TEXT = "好的，任务先停在这里，前面的进展仍然有效，想继续随时说一声。"
CANCEL_CLOSE_TEXT = (
    "好的，已取消这项操作，任务停在这里；前面完成的部分仍然有效，需要继续随时说一声。"
)


def user_cancel(answer) -> bool:
    """判断交互结果是否为「用户主动点取消」（原 core._user_cancel）。

    交互服务把用户点击的取消动作标成 ``option_id="cancel"``；IM 侧 cancel_check
    关单不带 option_id，属于真正的异常终止。两者在调用方的收尾语义完全不同，
    判定只此一处，避免各交互路径重复实现后漂移。
    """
    return (
        isinstance(answer, dict)
        and answer.get("status") == "cancelled"
        and answer.get("option_id") == "cancel"
    )


def classify_interaction_answer(answer) -> str:
    """把交互等待结果归类为统一的状态转移信号（FR-LLM25-004）。

    - ``user_cancelled``：用户在弹窗点取消＝正常收尾（补收尾正文、正常持久化）；
    - ``aborted``：IM/Web 侧取消或关单＝异常终止（发 _cancelled 事件）；
    - ``expired``：等待超时/过期，由调用方按交互场景结束等待；
    - ``resolved``：普通回答，恢复 run 继续执行。
    """
    if user_cancel(answer):
        return "user_cancelled"
    if isinstance(answer, dict) and answer.get("status") == "cancelled":
        return "aborted"
    if answer is None:
        return "expired"
    return "resolved"


def closing_frames(text: str, *, next_round: int) -> list[str]:
    """用户取消后的收尾帧：先另起一轮，再发收尾正文（原 core._closing_frames）。

    前端按轮切分气泡（见 useChatStream.ts 的 finishRoundMessage），同一轮里的 token
    会被追加到「工具调用前那条气泡」上——那样用户在底部看不到任何新内容，只看到
    「取消没有下文」。取消是运行侧直接收尾、不走模型，所以必须自己补这次分帧。

    这里必须发 ``round_start`` 而不是 ``_new_round``：后者在
    ``_recover_interrupted_continuation`` 里表示「模型续轮还没开始」，收尾后紧接着
    结束流会被判成续轮中断，于是凭空再发一次模型请求，用户会看到取消文案后面又
    跟一条自我解释。``round_start`` 既同样切气泡，也让恢复逻辑认为续轮已开始。
    """
    return [
        f"data: {json.dumps({'type': 'round_start', 'round_id': f'round-{next_round}', 'next_round': next_round}, ensure_ascii=False)}\n\n",
        f"data: {json.dumps({'type': 'token', 'content': text}, ensure_ascii=False)}\n\n",
    ]
