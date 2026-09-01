"""画布自动布局引擎。

这里只处理可复用的几何规则；权限、数据库读写和用户明确指定的位置仍由调用方负责。
"""
from __future__ import annotations

import json
from typing import Any


class CanvasLayoutEngine:
    DEFAULT_ITEM_SIZES = {
        "canvas_note": (244, 148),
        "project": (240, 120),
        "file": (156, 140),
        "event": (220, 96),
    }
    SAFE_EDGE_GAP = 150
    SAFE_CENTER_DISTANCE = 750

    @staticmethod
    def finite_number(value: Any) -> bool:
        return isinstance(value, (int, float)) and not isinstance(value, bool)

    def default_size(self, node: Any = None, *, kind: str | None = None, ref_type: str | None = None) -> tuple[int, int]:
        node_kind = kind if kind is not None else getattr(node, "kind", None)
        node_ref_type = ref_type if ref_type is not None else getattr(node, "ref_type", None)
        return self.DEFAULT_ITEM_SIZES.get(
            "canvas_note" if node_kind == "canvas_note" else node_ref_type,
            self.DEFAULT_ITEM_SIZES["event"],
        )

    def effective_size(self, node: Any, item: Any = None) -> tuple[int | float, int | float]:
        default_w, default_h = self.default_size(node)
        return (
            getattr(item, "w", None) if item is not None and getattr(item, "w", None) is not None else default_w,
            getattr(item, "h", None) if item is not None and getattr(item, "h", None) is not None else default_h,
        )

    def recommended_relation_sides(self, source_node: Any, source_item: Any, target_node: Any, target_item: Any) -> tuple[str, str]:
        source_w, _ = self.effective_size(source_node, source_item)
        target_w, _ = self.effective_size(target_node, target_item)
        source_left = float(source_item.x)
        source_right = source_left + source_w
        target_left = float(target_item.x)
        target_right = target_left + target_w
        source_center = float(source_item.x) + source_w / 2
        target_center = float(target_item.x) + target_w / 2
        if source_right <= target_left:
            return "right", "left"
        if target_right <= source_left:
            return "left", "right"
        # 卡片水平投影重叠时，通常是上下编排。两端使用同一侧，避免连线穿过卡片间隙后绕成回环。
        side = "right" if target_center >= source_center else "left"
        return side, side

    def resolve_position(
        self,
        position: Any,
        canvas_data: dict[str, Any],
        *,
        last_item: Any = None,
        near_item: Any = None,
    ) -> tuple[float, float]:
        """将语义锚点转换为世界坐标，保持旧工具的坐标契约。"""
        position = position if isinstance(position, dict) else {}
        x, y = position.get("x"), position.get("y")
        if self.finite_number(x) and self.finite_number(y):
            return float(x), float(y)
        anchor = position.get("anchor", "auto")
        allowed = {"auto", "viewport_center", "viewport_top_left", "viewport_top_right", "viewport_bottom_left", "viewport_bottom_right", "near_node"}
        if anchor not in allowed:
            raise ValueError("不支持的画布位置锚点")

        camera = {key: canvas_data.get(key) for key in ("x", "y", "scale")}
        scale = float(camera["scale"]) if self.finite_number(camera.get("scale")) and camera["scale"] > 0 else 1.0
        camera_x = float(camera["x"]) if self.finite_number(camera.get("x")) else 0.0
        camera_y = float(camera["y"]) if self.finite_number(camera.get("y")) else 0.0
        viewport = canvas_data.get("viewport") if isinstance(canvas_data.get("viewport"), dict) else None
        width = viewport.get("width") if viewport else None
        height = viewport.get("height") if viewport else None
        if anchor.startswith("viewport_"):
            if not (self.finite_number(width) and self.finite_number(height)):
                raise ValueError("画布尚未保存视口尺寸，暂时不能按当前视野定位")
            world_w, world_h = float(width) / scale, float(height) / scale
            world_x, world_y = -camera_x / scale, -camera_y / scale
            if anchor.endswith("center"):
                world_x += world_w / 2 - 110
                world_y += world_h / 2 - 60
            elif anchor.endswith("top_right"):
                world_x += world_w - 240
                world_y += 24
            elif anchor.endswith("bottom_left"):
                world_x += 24
                world_y += world_h - 144
            elif anchor.endswith("bottom_right"):
                world_x += world_w - 240
                world_y += world_h - 144
            else:
                world_x += 24
                world_y += 24
            return world_x + float(position.get("offset_x", 0) or 0), world_y + float(position.get("offset_y", 0) or 0)
        if anchor == "near_node":
            if near_item is None:
                raise ValueError("找不到要靠近的画布节点")
            near_w = near_item.w or 220
            return (
                float(near_item.x + near_w + self.SAFE_EDGE_GAP + (position.get("offset_x", 0) or 0)),
                float(near_item.y + (position.get("offset_y", 0) or 0)),
            )
        if last_item is None:
            return -camera_x / scale + 40, -camera_y / scale + 40
        return float(last_item.x + (last_item.w or 220) + self.SAFE_EDGE_GAP), float(last_item.y)


canvas_layout = CanvasLayoutEngine()


def parse_canvas_data(raw: str | None) -> dict[str, Any]:
    try:
        data = json.loads(raw or "{}")
    except (TypeError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}
