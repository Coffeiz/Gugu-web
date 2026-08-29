"""审计已注册工具的完整 description，生成 Schema 文案优化清单。

只输出工具名、字段路径、字符数和脱敏后的文案摘要，不输出运行参数或用户数据。
"""
from __future__ import annotations

import argparse
import sys
from typing import Any


def _walk(value: Any, path: str = "$"):
    if isinstance(value, dict):
        description = value.get("description")
        if isinstance(description, str) and description.strip():
            yield path, description.strip()
        for key, child in value.items():
            if key != "description":
                yield from _walk(child, f"{path}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from _walk(child, f"{path}[{index}]")


def main() -> int:
    parser = argparse.ArgumentParser(description="审计工具 Schema 的 description 文案")
    parser.add_argument("--limit", type=int, default=20, help="输出字符总量最高的工具数")
    args = parser.parse_args()

    from agent.tools import registry

    rows = []
    for tool in registry._tools.values():
        fields = list(_walk(tool.input_schema))
        rows.append({
            "name": tool.name,
            "description_chars": len(tool.description or ""),
            "field_count": len(fields),
            "field_description_chars": sum(len(text) for _, text in fields),
            "fields": fields,
        })
    rows.sort(key=lambda row: (row["field_description_chars"], row["description_chars"]), reverse=True)

    print(f"tools={len(rows)}")
    print(f"field_description_chars={sum(row['field_description_chars'] for row in rows)}")
    print("rank\ttool\ttotal_chars\tfield_count\ttop_fields")
    for index, row in enumerate(rows[: max(args.limit, 0)], 1):
        top_fields = ", ".join(
            f"{path}({len(text)})" for path, text in sorted(row["fields"], key=lambda item: len(item[1]), reverse=True)[:5]
        )
        print(f"{index}\t{row['name']}\t{row['field_description_chars']}\t{row['field_count']}\t{top_fields}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
