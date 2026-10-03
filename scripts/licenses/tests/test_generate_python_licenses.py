from __future__ import annotations

import importlib.util
from pathlib import Path
from types import SimpleNamespace


SCRIPT = Path(__file__).parents[1] / "generate-python-licenses.py"
SPEC = importlib.util.spec_from_file_location("generate_python_licenses", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class Metadata:
    def __init__(self, name: str, *, license: str = "", classifiers: list[str] | None = None):
        self.values = {"Name": name, "License": license}
        self.classifiers = classifiers or []

    def get(self, key: str) -> str | None:
        return self.values.get(key)

    def get_all(self, key: str, default: list[str] | None = None) -> list[str]:
        return self.classifiers if key == "Classifier" else []


def test_odfpy_uses_documented_project_level_apache_option() -> None:
    dist = SimpleNamespace(
        metadata=Metadata(
            "odfpy",
            classifiers=[
                "License :: OSI Approved :: Apache Software License",
                "License :: OSI Approved :: GNU General Public License (GPL)",
                "License :: OSI Approved :: GNU Library or Lesser General Public License (LGPL)",
            ],
        )
    )

    assert MODULE.package_license(dist) == "Apache-2.0 OR GPL-2.0-or-later"


def test_other_packages_keep_existing_license_metadata_resolution() -> None:
    dist = SimpleNamespace(
        metadata=Metadata(
            "example-package",
            classifiers=["License :: OSI Approved :: MIT License"],
        )
    )

    assert MODULE.package_license(dist) == "OSI Approved :: MIT License"
