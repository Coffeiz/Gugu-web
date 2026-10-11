import pytest

from scripts.checks.check_orm_boundaries import _has_bare_orm_constructor


@pytest.mark.parametrize(
    ("line", "expected"),
    [
        ("def update(override: dict, presets: dict) -> dict:", False),
        ("async def delete(_override: dict, presets: dict) -> None:", False),
        ("update(File).where(File.id == file_id)", True),
        ("result.update({'name': value})", False),
        ("def mutate() -> None: return delete(File).where(File.id == file_id)", True),
    ],
)
def test_orm_boundary_detector_distinguishes_constructor_calls_from_definitions(line, expected):
    assert _has_bare_orm_constructor(line) is expected
