"""send_file 的 title 全分支支持与 schema 校验回归。

线上事故：模型用 file_id + title 发文件库文件，撞上「title 强制要求 url」
的 schema 条款被拒、原样重试再拒，只能绕道贴图。title 现在是所有来源通用
的展示名覆盖，file_id + title 这个自然组合必须一次通过。
"""

from agent.tools import registry
from agent.tools.files.transfer import _apply_title
from agent.tools.tool_contract import build_validator, validate_input


def _issues(payload: dict) -> list[dict]:
    tool = registry.get("send_file")
    return validate_input(build_validator(tool.input_schema), payload)


def test_send_file_accepts_file_id_with_title():
    """回归：file_id + title（当时的线上失败组合）必须通过校验。"""
    assert _issues({
        "file_id": 5998, "source_type": "file_id",
        "title": "南京 9/13 逐小时降水与概率",
    }) == []


def test_send_file_title_optional_on_every_source():
    assert _issues({"file_id": 1}) == []
    assert _issues({"url": "https://example.com/a.png"}) == []
    assert _issues({"url": "https://example.com/a.png", "title": "图"}) == []
    assert _issues({"file": "/workspace/out/chart.png", "title": "图表"}) == []
    assert _issues({"attach_id": "a1", "title": "旧图"}) == []


def test_send_file_mutually_exclusive_sources_still_rejected():
    """title 条款移除不影响来源互斥。"""
    issues = _issues({"file_id": 1, "url": "https://example.com/a.png"})
    assert issues


def test_send_file_conflicting_sources_named_in_issue():
    """回归：file+url 同时给出时，oneOf 报错要点名冲突字段与全部可选项。"""
    issues = _issues({
        "file": "正赛-长距离图.png",
        "url": "file:///workspace/F1/charts/正赛-长距离图.png",
        "title": "马德里站正赛长距离图",
    })
    assert any("file 和 url" in issue["message"] for issue in issues)
    assert any("file / file_id / url / attach_id" in issue["message"] for issue in issues)


def test_apply_title_overrides_display_name():
    artifact = {"file_id": 1, "name": "chart", "ext": "png"}
    assert _apply_title(artifact, "南京降水")["name"] == "南京降水"


def test_apply_title_strips_matching_extension():
    """title 自带与文件一致的后缀时剥掉，前端不会拼出 .png.png。"""
    artifact = {"name": "chart", "ext": "png"}
    assert _apply_title(artifact, "南京降水.png")["name"] == "南京降水"
    # 后缀不一致时保留原样（它是名字的一部分）。
    artifact = {"name": "chart", "ext": "png"}
    assert _apply_title(artifact, "南京降水.jpg")["name"] == "南京降水.jpg"


def test_apply_title_empty_or_blank_is_noop():
    artifact = {"name": "chart", "ext": "png"}
    assert _apply_title(artifact, None)["name"] == "chart"
    assert _apply_title(artifact, "   ")["name"] == "chart"


def test_apply_title_truncates_to_80_chars():
    artifact = {"name": "chart", "ext": "png"}
    long_title = "长" * 120
    assert len(_apply_title(artifact, long_title)["name"]) == 80
