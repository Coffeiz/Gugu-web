"""跨项目/文件/文件夹/日程/客户/对话的站内全局搜索，供咕咕定位「东西在哪」用。

复用 `app/api/v1/search.py`（顶栏全局搜索框同一套查询逻辑，ILIKE 子串匹配，
天然不分大小写）。网页下拉框每类只给 6 条方便展示；这里给模型用，每类给更多条
（20），并支持按 types 缩小范围，减少无关噪音。

只匹配名称/标题/客户名等字段，**不搜文件内容**——找到候选后要读内容/看详情/
发文件，仍需调用对应专用工具（read_file / send_file 等）。
"""
from app.api.v1.search import ALL_TYPES, run_global_search
from agent.tools.base import BaseSkill, Tool

_TOOL_PER_TYPE = 20


async def _global_search(db, user_id, args: dict):
    q = (args.get("q") or "").strip()
    if not q:
        return {"error": "需要提供搜索关键词 q"}
    types = args.get("types")
    if isinstance(types, list):
        types = [str(t) for t in types if t in ALL_TYPES] or None
    else:
        types = None
    result = await run_global_search(db, user_id, q, per_type=_TOOL_PER_TYPE, types=types)
    if result["total"] == 0:
        result["note"] = ("没搜到任何匹配——这只按名称/标题/客户名等字段匹配，不搜文件内容；"
                          "搜不到不代表数据库里真的没有相关内容，只是名字/标题对不上关键词")
    return result


class GlobalSearchSkill(BaseSkill):
    name = "global_search"
    tools = [
        Tool(
            name="global_search", label="站内全局搜索",
            description="按关键词跨项目/文件/文件夹/日程/客户/对话**一次性**搜索，用于「有没有 XX」"
                        "「XX 在哪」「找一下 XX」这类不确定东西在哪的模糊定位问题——**优先用这个**，"
                        "比分别调 list_files/list_projects 等专用工具挨个试更快更全，天然不区分大小写"
                        "（文件扩展名大小写不一致也能搜到）。"
                        "只匹配名称/标题/客户名/备注等字段，**不搜文件内容**——如果这里没搜到，只说明"
                        "没有名字/标题匹配的东西，不代表某个文件内容里真的没提到，别因为搜不到就断定"
                        "「没有」，措辞上要说清楚「没搜到同名/同标题的」。"
                        "用户明确给了范围（比如「这个文件夹下的文件」「这周的日程」）时，直接用对应"
                        "专用工具列出来，不必先过一遍这个。"
                        "搜到候选后，要读内容/看详情/发文件等操作仍需调用对应专用工具"
                        "（如 read_file、send_file、get_project）。"
                        "可选 types 缩小范围到某几类，不传则全搜。",
            input_schema={
                "type": "object",
                "properties": {
                    "q": {"type": "string", "description": "搜索关键词"},
                    "types": {"type": "array", "items": {"type": "string", "enum": ALL_TYPES},
                              "description": "可选，限定只搜这些类型（project/file/folder/event/"
                                            "client/conversation）；不传则全搜"},
                },
                "required": ["q"],
            },
            handler=_global_search,
        ),
    ]


GlobalSearchSkill().register()
