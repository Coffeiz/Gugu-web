from datetime import datetime, timezone
from types import SimpleNamespace

from app.services.files.response import to_file_response


def test_file_response_preserves_utc_timestamp_for_viewer_timezone_conversion():
    file = SimpleNamespace(
        id=1,
        display_name="weather_hour_南京_2026-09-21",
        ext="PNG",
        space="personal",
        workspace_directory_id=None,
        project_id=None,
        folder_id=None,
        stage_name="",
        mind_map_id=None,
        size="401 KB",
        size_bytes=410624,
        mime_type="image/png",
        created_at=datetime(2026, 9, 20, 21, 20, tzinfo=timezone.utc),
        deleted_at=None,
        img_width=1200,
        img_height=800,
        version=1,
    )

    response = to_file_response(file)

    assert response.created_at == "2026-09-20T21:20:00Z"
