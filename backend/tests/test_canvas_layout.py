from types import SimpleNamespace

import pytest

from app.services.canvas.layout_engine import CanvasLayoutEngine


def test_effective_size_uses_explicit_dimensions_and_type_defaults():
    engine = CanvasLayoutEngine()
    note = SimpleNamespace(kind="canvas_note", ref_type=None)
    item = SimpleNamespace(w=None, h=None)
    assert engine.effective_size(note, item) == (244, 148)
    item.w, item.h = 300, 180
    assert engine.effective_size(note, item) == (300, 180)


def test_relation_sides_use_card_centers_not_node_ids():
    engine = CanvasLayoutEngine()
    node = SimpleNamespace(kind="ref", ref_type="project")
    left = SimpleNamespace(x=-669, y=0, w=None, h=None)
    right = SimpleNamespace(x=-394, y=0, w=None, h=None)
    assert engine.recommended_relation_sides(node, left, node, right) == ("right", "left")
    assert engine.recommended_relation_sides(node, right, node, left) == ("left", "right")


def test_resolve_position_supports_viewport_and_auto_without_database_access():
    engine = CanvasLayoutEngine()
    viewport = {"x": -100, "y": 50, "scale": 2, "viewport": {"width": 1200, "height": 800}}
    assert engine.resolve_position({"anchor": "viewport_center"}, viewport) == (240.0, 115.0)
    last = SimpleNamespace(x=100, y=20, w=None)
    assert engine.resolve_position({"anchor": "auto"}, viewport, last_item=last) == (470.0, 20.0)


def test_resolve_position_rejects_unknown_anchor():
    with pytest.raises(ValueError, match="不支持的画布位置锚点"):
        CanvasLayoutEngine().resolve_position({"anchor": "unknown"}, {})
