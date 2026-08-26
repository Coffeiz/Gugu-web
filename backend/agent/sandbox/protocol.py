"""sandboxd 的最小 JSON Lines 协议。"""
from __future__ import annotations

import json
import math
import time
from dataclasses import dataclass
from typing import Any, Literal


@dataclass(frozen=True)
class ExecuteRequest:
    root: str
    command: str
    cwd: str = "."
    timeout: float = 30
    max_output_chars: int = 12_000
    quota_root: str | None = None
    quota_bytes: int | None = None
    network_profile: Literal["none", "egress"] = "none"
    egress_expires_at: float | None = None

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "ExecuteRequest":
        root = str(value.get("root") or "").strip()
        command = str(value.get("command") or "").strip()
        if not root or not command:
            raise ValueError("sandboxd 请求缺少 root 或 command")
        timeout = float(value.get("timeout", 30))
        max_output_chars = int(value.get("max_output_chars", 12_000))
        quota_root = str(value.get("quota_root") or "").strip() or None
        quota_value = value.get("quota_bytes")
        quota_bytes = int(quota_value) if quota_value is not None else None
        network_profile = str(value.get("network_profile") or "none")
        if network_profile not in ("none", "egress"):
            raise ValueError("sandboxd network_profile 无效")
        expires_value = value.get("egress_expires_at")
        egress_expires_at = float(expires_value) if expires_value is not None else None
        if network_profile == "egress":
            if (
                egress_expires_at is None
                or not math.isfinite(egress_expires_at)
                or egress_expires_at <= time.time()
            ):
                raise ValueError("sandboxd egress 授权已过期")
        elif egress_expires_at is not None:
            raise ValueError("断网请求不能携带 egress 授权")
        if quota_bytes is not None and quota_bytes < 1:
            raise ValueError("sandboxd quota_bytes 无效")
        if quota_bytes is not None and not quota_root:
            raise ValueError("sandboxd quota_bytes 缺少 quota_root")
        if not 0.1 <= timeout <= 300:
            raise ValueError("sandboxd timeout 超出允许范围")
        if not 1 <= max_output_chars <= 120_000:
            raise ValueError("sandboxd 输出上限超出允许范围")
        return cls(
            root=root,
            command=command,
            cwd=str(value.get("cwd") or "."),
            timeout=timeout,
            max_output_chars=max_output_chars,
            quota_root=quota_root,
            quota_bytes=quota_bytes,
            network_profile=network_profile,
            egress_expires_at=egress_expires_at,
        )

    def to_json(self) -> bytes:
        return (json.dumps({
            "operation": "execute",
            "root": self.root,
            "command": self.command,
            "cwd": self.cwd,
            "timeout": self.timeout,
            "max_output_chars": self.max_output_chars,
            "quota_root": self.quota_root,
            "quota_bytes": self.quota_bytes,
            "network_profile": self.network_profile,
            "egress_expires_at": self.egress_expires_at,
        }, ensure_ascii=False) + "\n").encode("utf-8")


def encode_response(value: dict[str, Any]) -> bytes:
    return (json.dumps(value, ensure_ascii=False) + "\n").encode("utf-8")
