"""定时任务报告阶段的提示词构造。"""
from __future__ import annotations


def build_prompt(task_prompt: str, execution_text: str, files: list | None = None) -> str:
    """把完整执行结果交给报告阶段整理，不重新推断或执行任务。

    files：execution 阶段 send_file 暂存下来的附件列表（_artifact 结构，含 attach_id/
    name/ext）。系统会在投递阶段随文字一起发到 IM 群，报告阶段不需要担心图片是否真的
    发出——有了 files 参数后，咕咕能看到「N 张附件会在投递阶段随文字一起发出」，回执里
    不会再问图片有没有真的附上去。"""
    files_section = ""
    if files:
        names = [f.get("name") or f.get("attach_id") or "附件" for f in files]
        files_section = (
            f"\n\n附件：execution 阶段已通过 send_file 暂存了 {len(files)} 张附件"
            f"（{', '.join(str(n) for n in names)}），系统会在投递阶段随这段文字一起发到 IM 群。"
            "你不需要在正文里描述「图片已发送」，也不需要担心图片是否真的发出——"
            "已确认会在投递阶段由系统自动投出。"
        )
    return (
        "[定时任务报告阶段]\n"
        "下面是刚刚完整执行阶段得到的结果。请只根据这些结果生成要投递给用户的正文。\n"
        "不要调用工具，不要声称结果中没有出现的操作已经完成；如果结果不完整，明确说明缺少什么。\n\n"
        f"原任务：\n{task_prompt}\n\n"
        f"执行结果：\n---\n{execution_text}\n---"
        f"{files_section}"
    )
