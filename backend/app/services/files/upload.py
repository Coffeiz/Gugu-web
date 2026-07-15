from typing import Tuple


def parse_upload_filename(filename: str) -> Tuple[str, str]:
    parts = filename.rsplit('.', 1)
    return parts[0], parts[1].upper()[:10] if len(parts) > 1 else 'FILE'
