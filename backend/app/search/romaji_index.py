"""文件与文件夹拼音搜索别名的生成和 ORM 同步。"""

from sqlalchemy import event, inspect
from sqlalchemy.orm import Session

from app.models import File, Folder
from app.utils.romaji import indexed_romaji_candidates


def build_romaji_search_text(*parts: str | None) -> str:
    """把名称字段转成可被 trigram 子串索引查询的候选串。"""
    candidates = []
    for part in parts:
        candidates.extend(indexed_romaji_candidates(part or ""))
    return " ".join(dict.fromkeys(candidates))


def _sync_changed_names(session: Session, _flush_context, _instances) -> None:
    for obj in session.new:
        if isinstance(obj, File):
            obj.search_romaji = build_romaji_search_text(obj.display_name, obj.ext)
        elif isinstance(obj, Folder):
            obj.search_romaji = build_romaji_search_text(obj.name)

    for obj in session.dirty:
        if isinstance(obj, File):
            state = inspect(obj)
            if any(state.attrs[name].history.has_changes() for name in ("display_name", "ext")):
                obj.search_romaji = build_romaji_search_text(obj.display_name, obj.ext)
        elif isinstance(obj, Folder):
            state = inspect(obj)
            if state.attrs.name.history.has_changes():
                obj.search_romaji = build_romaji_search_text(obj.name)


def register_romaji_search_alias_listener() -> None:
    """在应用 AsyncSession 使用的同步 Session 上幂等注册名称同步钩子。"""
    if not event.contains(Session, "before_flush", _sync_changed_names):
        event.listen(Session, "before_flush", _sync_changed_names)
