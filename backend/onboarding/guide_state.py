"""弹窗功能引导的状态规则，与注册播种状态分离。"""

GUIDE_VERSION = 1
GUIDE_STEPS = ("locale", "features", "style", "model", "im", "complete")


def default_guide_state() -> dict:
    return {
        "enabled": False,
        "version": GUIDE_VERSION,
        "current_step": "locale",
        "completed_steps": [],
        "dismissed": False,
        "completed_at": None,
    }


def normalize_guide_state(raw: dict | None) -> dict:
    source = raw if isinstance(raw, dict) else {}
    result = {**default_guide_state(), **source}
    try:
        result["version"] = max(1, int(result["version"]))
    except (TypeError, ValueError):
        result["version"] = GUIDE_VERSION
    result["completed_steps"] = [
        step for step in result.get("completed_steps", []) if step in GUIDE_STEPS
    ] if isinstance(result.get("completed_steps"), list) else []
    if result.get("current_step") not in GUIDE_STEPS:
        result["current_step"] = "locale"
    result["enabled"] = bool(result.get("enabled", False))
    result["dismissed"] = bool(result.get("dismissed", False))
    return result


def should_show(raw: dict | None) -> bool:
    guide = normalize_guide_state(raw)
    return bool(
        guide["enabled"]
        and not guide["dismissed"]
        and not guide.get("completed_at")
        and guide["version"] == GUIDE_VERSION
    )


def validate_patch(patch: dict) -> dict:
    allowed = {"current_step", "completed_steps", "dismissed", "completed_at", "version"}
    if set(patch) - allowed:
        raise ValueError("引导状态包含不允许的字段")
    result = dict(patch)
    if "current_step" in result and result["current_step"] not in GUIDE_STEPS:
        raise ValueError("引导步骤无效")
    if "completed_steps" in result:
        steps = result["completed_steps"]
        if not isinstance(steps, list) or any(step not in GUIDE_STEPS for step in steps):
            raise ValueError("已完成引导步骤无效")
        result["completed_steps"] = list(dict.fromkeys(steps))
    if "dismissed" in result and not isinstance(result["dismissed"], bool):
        raise ValueError("dismissed 必须是布尔值")
    if "version" in result:
        try:
            result["version"] = max(1, int(result["version"]))
        except (TypeError, ValueError) as exc:
            raise ValueError("引导版本无效") from exc
    return result
