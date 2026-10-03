"""审计已注册工具的 Schema 规范化状态。

只检查 input_schema 中的 Schema 节点，不把 properties 下的字段名误当成
Schema 元数据。默认只输出脱敏的路径、工具名和统计信息；迁移完成后可用
``--strict`` 作为新增工具的注册前检查。
"""
from __future__ import annotations

import argparse
import sys
from typing import Any, Iterator


REDUNDANT_KEYS = frozenset({"title", "default", "example", "examples"})
DESCRIPTION_KEY = "description"


def _walk_schema(value: Any, path: str = "$") -> Iterator[tuple[str, str, Any]]:
    """遍历 Schema 节点，保留 properties 的字段名语义。"""
    if isinstance(value, list):
        for index, item in enumerate(value):
            yield from _walk_schema(item, f"{path}[{index}]")
        return
    if not isinstance(value, dict):
        return

    for key in REDUNDANT_KEYS:
        if key in value:
            yield path, key, value[key]
    if isinstance(value.get(DESCRIPTION_KEY), str) and value[DESCRIPTION_KEY].strip():
        yield path, DESCRIPTION_KEY, value[DESCRIPTION_KEY]

    properties = value.get("properties")
    if isinstance(properties, dict):
        for field_name, field_schema in properties.items():
            yield from _walk_schema(field_schema, f"{path}.properties.{field_name}")

    handled_keys = {"properties"}
    for key in ("items", "additionalProperties", "if", "then", "else", "not"):
        child = value.get(key)
        if isinstance(child, (dict, list)):
            yield from _walk_schema(child, f"{path}.{key}")
        handled_keys.add(key)
    for key in ("oneOf", "anyOf", "allOf", "prefixItems"):
        child = value.get(key)
        if isinstance(child, list):
            yield from _walk_schema(child, f"{path}.{key}")
        handled_keys.add(key)

    # 保留对未来 JSON Schema 关键字（如 $defs/dependentSchemas）的审计覆盖，
    # 同时不把 properties 的字段名当作元数据键。
    for key, child in value.items():
        if key in handled_keys or not isinstance(child, (dict, list)):
            continue
        yield from _walk_schema(child, f"{path}.{key}")


def main() -> int:
    parser = argparse.ArgumentParser(description="审计工具 input_schema 的规范化状态")
    parser.add_argument("--strict", action="store_true", help="发现冗余元数据或字段说明时返回失败")
    parser.add_argument("--limit", type=int, default=30, help="每个工具最多输出多少条问题")
    args = parser.parse_args()

    from agent.tools import registry

    total = 0
    by_key: dict[str, int] = {}
    failed = False
    print(f"tools={len(registry._tools)}")
    for name, tool in sorted(registry._tools.items()):
        issues = list(_walk_schema(tool.input_schema))
        if not issues:
            continue
        total += len(issues)
        for _, key, _ in issues:
            by_key[key] = by_key.get(key, 0) + 1
        print(f"tool={name}\tissues={len(issues)}")
        for path, key, value in issues[: max(args.limit, 0)]:
            if key == DESCRIPTION_KEY:
                summary = f"chars={len(str(value))}"
            else:
                summary = "present"
            print(f"  {path}.{key}\t{summary}")
        failed = True

    print(f"issues={total}")
    print("by_key=" + ",".join(f"{key}:{by_key[key]}" for key in sorted(by_key)))
    return 1 if args.strict and failed else 0


if __name__ == "__main__":
    sys.exit(main())
