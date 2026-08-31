"""Agent/provider 测试共用的无状态结果构造器。"""


def probe_result():
    return {
        key: {"status": "支持", "detail": "HTTP 200"}
        for key in ("chat", "stream", "tools", "json_object", "json_schema")
    } | {"reasoning": {"status": "未检测", "detail": "人工确认"}}


async def probe_capabilities(_item):
    """供本地能力探测接口使用的无状态异步替身。"""
    return probe_result()
