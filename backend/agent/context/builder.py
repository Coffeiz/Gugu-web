"""System prompt 组装层。

注入顺序：persona.md（咕咕人格，始终最先、所有 profile 共享）→ profile 模板
（default.md，含实时数据与记忆占位符）。persona 定义"咕咕是谁、怎么相处、何时
主动"，模板提供"此刻的项目/日程/记忆"。
"""
from datetime import datetime
from pathlib import Path

_PROMPTS_DIR = Path(__file__).parent.parent / "prompts"


def _files_block(fo: dict | None) -> str:
    """文件/文件夹概览文本（紧凑）。"""
    if not fo or not fo.get("total"):
        return "暂无文件"
    lines = [f"共 {fo['total']} 个文件。"]
    folders = fo.get("folders") or []
    if folders:
        lines.append("文件夹：" + "、".join(
            f"{x['name']}" + (f"(项目#{x['project_id']})" if x.get("project_id") else "")
            for x in folders
        ))
    files = fo.get("files") or []
    if files:
        lines.append(f"最近文件（最多 {len(files)} 个）：")
        for f in files:
            loc = f.get("folder") or ("项目#%s" % f["project_id"] if f.get("project_id") else f.get("space", ""))
            lines.append(f"- [id={f['id']}] {f['name']}（{loc}）")
    return "\n".join(lines)


def build(profile: str, user_name: str, projects: list, events: list,
          memory: dict | None = None, files: dict | None = None) -> str:
    memory = memory or {}
    today = datetime.now().strftime("%Y-%m-%d")

    proj_lines = []
    for p in projects[:25]:
        deadline = f"截止 {p.deadline}" if p.deadline else "无截止"
        done_cnt  = sum(1 for s in p.stages if s.get("done"))
        total_cnt = len(p.stages)
        prog = f"{done_cnt}/{total_cnt}阶段" if total_cnt else "无阶段"
        proj_lines.append(f"- [id={p.id}] [{p.status}] {p.name}（{prog}，{deadline}，客户：{p.client or '无'}）")

    ev_lines   = [f"- {ev.date} {ev.title}" for ev in events[:10]]
    proj_block = "\n".join(proj_lines) if proj_lines else "暂无项目"
    ev_block   = "\n".join(ev_lines)   if ev_lines   else "暂无近期事件"

    prompt_file = _PROMPTS_DIR / f"{profile}.md"
    try:
        template = prompt_file.read_text(encoding="utf-8")
    except FileNotFoundError:
        template = "今天是 {today}。\n\n## 项目\n{projects}\n\n## 日历\n{calendar}"

    replacements = {
        "{today}":    today,
        "{name}":     user_name,
        "{projects}": proj_block,
        "{calendar}": ev_block,
        "{files}":    _files_block(files),
    }
    result = template
    for key, val in replacements.items():
        result = result.replace(key, val)
    result = result.strip()

    # persona 最先加载，所有 profile 共享
    try:
        persona = (_PROMPTS_DIR / "persona.md").read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        persona = ""

    # 工具使用准则（Execution Policy）：行为层指引，紧跟人格、优先级高，所有 profile 共享
    try:
        skills_policy = (_PROMPTS_DIR / "skills.md").read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        skills_policy = ""

    # 内容政策（红线）：独立维护、所有 profile 共享
    try:
        content_policy = (_PROMPTS_DIR / "policy.md").read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        content_policy = ""

    # 顺序：人格 → 工具准则 → 内容政策 → 对用户的了解（仅非空时注入，避免空 section 烧 token）→ 当前状态
    sections = []
    if persona:
        sections.append(persona)
    if skills_policy:
        sections.append(skills_policy)
    if content_policy:
        sections.append(content_policy)
    mem_block = _memory_block(memory)
    if mem_block:
        sections.append(mem_block)
    sections.append(result)
    return "\n\n---\n\n".join(sections)


def _memory_block(memory: dict) -> str:
    """咕咕对用户的记忆，全空时返回空串（不注入）。顺序：稳定事实 → 长期记忆 → 最近。"""
    facts   = (memory.get("facts") or "").strip()
    longterm = (memory.get("memory") or "").strip()
    daily   = (memory.get("daily") or "").strip()
    parts = []
    if facts:
        parts.append("## 我对你的了解\n\n" + facts)
    if longterm:
        parts.append("## 长期记忆\n\n" + longterm)
    if daily:
        parts.append("## 最近的记忆\n\n" + daily)
    return "\n\n".join(parts)
