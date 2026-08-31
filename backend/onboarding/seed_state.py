"""注册播种状态的读写规则，与弹窗功能引导状态分离。"""


def default_seed_state() -> dict:
    return {
        "seeded": False,
        "project_id": None,
        "project_name": None,
    }


def normalize_seed_state(raw: dict | None) -> dict:
    source = raw if isinstance(raw, dict) else {}
    return {**default_seed_state(), **source}
