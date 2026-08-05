"""定时任务报告阶段的提示词构造。"""
from __future__ import annotations


def build_prompt(task_prompt: str, execution_text: str) -> str:
    """把完整执行结果交给报告阶段整理，不重新推断或执行任务。"""
    return (
        "[定时任务报告阶段]\n"
        "下面是刚刚完整执行阶段得到的结果。请只根据这些结果生成要投递给用户的正文。\n"
        "不要调用工具，不要声称结果中没有出现的操作已经完成；如果结果不完整，明确说明缺少什么。\n\n"
        f"原任务：\n{task_prompt}\n\n"
        f"执行结果：\n---\n{execution_text}\n---"
    )
