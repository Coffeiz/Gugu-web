"""定时任务报告阶段的提示词构造。"""
from __future__ import annotations


def build_prompt(task_prompt: str, execution_text: str, files: list | None = None) -> str:
    """把完整执行结果交给报告阶段整理，不重新推断或执行任务。

    files：execution 阶段 send_file 暂存下来的附件列表（_artifact 结构，含 attach_id/
    name/ext）。系统会在投递阶段尝试随文字一起发到 IM 群——是否真的送达以投递结果为准
    （网络问题、附件过期等都可能导致失败），report 阶段生成的这段文字不需要纠结这件事，
    正常写就行，不用在正文里替系统打包票说"图片已发送"。"""
    files_section = ""
    if files:
        names = [f.get("name") or f.get("attach_id") or "附件" for f in files]
        files_section = (
            f"\n\n附件：execution 阶段已通过 send_file 暂存了 {len(files)} 张附件"
            f"（{', '.join(str(n) for n in names)}），系统会在投递阶段尝试随这段文字一起发到 IM 群"
            "（网页通知渠道不支持附件，图片只会出现在 IM 群里）。"
            "你不需要在正文里描述「图片已发送」或做任何承诺——是否真的送达系统会另外记录，"
            "不是这段回执文字要负责的事。"
        )
    return (
        "[定时任务报告阶段]\n"
        "下面是刚刚完整执行阶段得到的结果。请只根据这些结果生成要投递给用户的正文。\n"
        "不要调用工具，不要声称结果中没有出现的操作已经完成；如果结果不完整，明确说明缺少什么。\n\n"
        f"原任务：\n{task_prompt}\n\n"
        f"执行结果：\n---\n{execution_text}\n---"
        f"{files_section}"
    )
