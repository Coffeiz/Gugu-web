from pathlib import Path

from app.core.config import get_settings


THUMB_SIZE_MAP = {"tiny": (20, 75), "card": (192, 82)}


def thumb_dir() -> Path:
    path = Path(get_settings().storage.local_path) / ".thumbs"
    path.mkdir(parents=True, exist_ok=True)
    return path


def thumb_path(file_id: int, size: str) -> Path:
    return thumb_dir() / f"{file_id}_{size}.webp"


def delete_thumb_cache(file_id: int) -> None:
    for size in ("tiny", "card"):
        for extension in (".webp", ".jpg"):
            path = thumb_dir() / f"{file_id}_{size}{extension}"
            try:
                if path.exists():
                    path.unlink()
            except OSError:
                pass
