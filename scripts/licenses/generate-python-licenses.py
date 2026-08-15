#!/usr/bin/env python3
"""从当前 Python 环境生成后端依赖许可证清单。"""

from __future__ import annotations

import argparse
import importlib.metadata as metadata
import json
import re
from pathlib import Path
from typing import Any


PACKAGE_NAME = re.compile(r"^\s*([A-Za-z0-9_.-]+)")
REQUIRES_NAME = re.compile(r"^\s*([A-Za-z0-9_.-]+)")


def normalize_name(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def read_requirement_names(path: Path) -> list[str]:
    names: list[str] = []
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.split("#", 1)[0].strip()
        if not line or line.startswith(("-", "git+", "http:" , "https:")):
            continue
        match = PACKAGE_NAME.match(line)
        if match:
            names.append(match.group(1))
    return names


def package_license(dist: metadata.Distribution) -> str:
    expression = (dist.metadata.get("License-Expression") or "").strip()
    if expression:
        return expression
    value = (dist.metadata.get("License") or "").strip()
    if value and value.lower() not in {"unknown", "none"}:
        return value
    classifiers = [item for item in dist.metadata.get_all("Classifier", []) if item.startswith("License ::")]
    if classifiers:
        return classifiers[-1].removeprefix("License :: ")
    return "Unknown"


def package_links(dist: metadata.Distribution) -> tuple[str, str]:
    homepage = dist.metadata.get("Home-page") or ""
    repository = ""
    for item in dist.metadata.get_all("Project-URL", []):
        label, _, url = item.partition(",")
        if label.strip().lower() in {"source", "repository", "homepage"}:
            if label.strip().lower() == "homepage" and not homepage:
                homepage = url.strip()
            elif not repository:
                repository = url.strip()
    return homepage, repository


def collect_dependencies(direct_names: list[str]) -> tuple[list[dict[str, Any]], list[str]]:
    queue = list(direct_names)
    direct_keys = {normalize_name(name) for name in direct_names}
    seen: set[str] = set()
    missing_direct: list[str] = []
    result: dict[str, dict[str, Any]] = {}

    while queue:
        requested = queue.pop(0)
        key = normalize_name(requested)
        if key in seen:
            continue
        seen.add(key)
        try:
            dist = metadata.distribution(requested)
        except metadata.PackageNotFoundError:
            if key in direct_keys:
                missing_direct.append(requested)
            continue

        homepage, repository = package_links(dist)
        item = {
            "name": dist.metadata.get("Name") or requested,
            "version": dist.version,
            "license": package_license(dist),
            "homepage": homepage,
            "repository": repository,
        }
        result[f"{normalize_name(item['name'])}@{item['version']}"] = item
        for requirement in dist.requires or []:
            match = REQUIRES_NAME.match(requirement)
            if match and normalize_name(match.group(1)) not in seen:
                queue.append(match.group(1))

    return sorted(result.values(), key=lambda item: (item["name"].lower(), item["version"])), sorted(set(missing_direct))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    root = args.root.resolve()
    requirement_files = [root / "backend" / "requirements.txt"]
    direct_names = [name for path in requirement_files for name in read_requirement_names(path)]
    dependencies, missing = collect_dependencies(direct_names)
    report = {
        "project": "backend",
        "label": "Gugu-web / 后端",
        "packageManager": "pip",
        "packageManifests": ["backend/requirements.txt"],
        "environment": "当前 Python 环境",
        "dependencies": dependencies,
        "directDependencies": sorted(set(direct_names), key=str.lower),
        "missingDirectDependencies": missing,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Generated backend license report: {len(dependencies)} packages")
    if missing:
        print(f"Missing direct packages: {', '.join(missing)}")


if __name__ == "__main__":
    main()
