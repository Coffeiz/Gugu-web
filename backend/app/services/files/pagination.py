"""文件库列表的有界 keyset 分页和签名游标。"""

import base64
import binascii
import hashlib
import json
import os
from datetime import datetime
from typing import Any

from fastapi import HTTPException
from sqlalchemy import tuple_
from sqlalchemy.sql.elements import ColumnElement
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.core.config import get_settings

DEFAULT_PAGE_SIZE = 100
MAX_PAGE_SIZE = 200
_CURSOR_VERSION = 1


def _canonical_json(value: dict[str, Any]) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()


def encode_cursor(*, user_id: Any, scope: dict[str, Any], sort_value: Any, entity_id: int) -> str:
    if isinstance(sort_value, datetime):
        sort_value = sort_value.isoformat()
    payload = _canonical_json({
        "v": _CURSOR_VERSION,
        "user": str(user_id),
        "scope": scope,
        "value": sort_value,
        "id": int(entity_id),
    })
    key = hashlib.sha256(b"file-page-cursor:" + get_settings().secret_key.encode()).digest()
    nonce = os.urandom(12)
    encrypted = AESGCM(key).encrypt(nonce, payload, b"gugu-file-page-cursor-v1")
    return base64.urlsafe_b64encode(nonce + encrypted).rstrip(b"=").decode()


def decode_cursor(token: str | None, *, user_id: Any, scope: dict[str, Any]) -> tuple[Any, int] | None:
    if token is None:
        return None
    try:
        if len(token) > 4096:
            raise ValueError("cursor too long")
        encrypted = base64.urlsafe_b64decode(token + "=" * (-len(token) % 4))
        if len(encrypted) < 29:
            raise ValueError("cursor too short")
        key = hashlib.sha256(b"file-page-cursor:" + get_settings().secret_key.encode()).digest()
        payload_bytes = AESGCM(key).decrypt(
            encrypted[:12], encrypted[12:], b"gugu-file-page-cursor-v1",
        )
        payload = json.loads(payload_bytes)
        if not isinstance(payload, dict):
            raise ValueError("invalid cursor payload")
        if payload.get("v") != _CURSOR_VERSION or payload.get("user") != str(user_id):
            raise ValueError("cursor boundary mismatch")
        if payload.get("scope") != scope:
            raise ValueError("cursor scope mismatch")
        value = payload["value"]
        if not isinstance(value, (str, int, float)) or isinstance(value, bool):
            raise ValueError("invalid sort value")
        entity_id = int(payload["id"])
        if entity_id < 1:
            raise ValueError("invalid entity id")
        return value, entity_id
    except (ValueError, KeyError, TypeError, json.JSONDecodeError, binascii.Error, UnicodeDecodeError, InvalidTag):
        raise HTTPException(status_code=422, detail="分页游标无效或已失效") from None


def apply_keyset(stmt, *, model, sort_column: ColumnElement, sort_value: Any,
                 entity_id: int, direction: str):
    """为稳定的 (排序值, ID) 排序添加 keyset 边界。"""
    if sort_column.compare(model.id):
        return stmt.where(model.id > entity_id if direction == "asc" else model.id < entity_id)
    boundary = tuple_(sort_column, model.id)
    value = tuple_(sort_value, entity_id)
    return stmt.where(boundary > value if direction == "asc" else boundary < value)
