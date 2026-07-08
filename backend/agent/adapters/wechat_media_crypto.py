"""微信 iLink Bot 媒体加解密 + CDN 上传下载（2026-07-09 接入）。

iLink 协议规定所有 CDN 上的媒体**强制 AES-128-ECB + PKCS7** 加密。
OpenClaw 已经有完整 TS 实现（`@tencent-weixin/openclaw-weixin/src/cdn/*`），
本模块照搬其设计用 Python 重写。

## 上传流程（4 步）
1. **本模块 `encrypt_for_upload(plaintext)` → `ciphertext` + PKCS7 padded size**
2. **`ILinkClient.get_upload_url(filekey, aeskey_hex, media_type, to_user_id,
   rawsize, rawfilemd5, filesize_padded, no_need_thumb=True)` → `upload_full_url` 或 `upload_param`**
3. **POST `ciphertext` 到 CDN URL（Content-Type: application/octet-stream）**
   → 响应头 `x-encrypted-param` 是下载参数
4. **拼到 `sendmessage.item_list`**：
   - 图片：`{"type": 2, "image_item": {"aes_key": base64, "encrypt_query_param": ..., "hd_length": padded_size, ...}}`
   - 文件：`{"type": 4, "file_item": {"aes_key": base64, "encrypt_query_param": ..., "file_size": padded_size, "file_name": "..."}}`

## 解密（入站图片）
入站图片下载 + 解密逻辑**已在 `wechat.py:_aes128_ecb_decrypt` 实现**（CDN 返回
AES-128-ECB + PKCS7），本模块 `decrypt_aes_ecb` 提供给其他路径复用（如未来直调
iLink 下载历史消息）。

## 入参约定
- `aeskey`：16 字节 raw bytes（生成时用 `secrets.token_bytes(16)`）
- `aeskey_hex`：hex 字符串（喂给 getuploadurl 时用这个）
- `aeskey_b64`：base64 字符串（拼到 sendmessage.item_list.aes_key 时用这个——iLink 协议要求 base64）
"""
from __future__ import annotations

import base64
import hashlib
import secrets

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

# AES-128 = 16 字节 key
_AES_KEY_BYTES = 16
_AES_BLOCK_BYTES = 16
CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c"   # 与 OpenClaw cdn/cdn-url.ts 一致

# 上传重试上限（OpenClaw cdn-upload.ts 默认 3 次）
UPLOAD_MAX_RETRIES = 3


def gen_aes_key() -> bytes:
    """生成 16 字节 AES-128 key（raw bytes）。"""
    return secrets.token_bytes(_AES_KEY_BYTES)


def aeskey_to_hex(key: bytes) -> str:
    """raw bytes → hex 字符串（喂给 getuploadurl.aeskey）。"""
    return key.hex()


def aeskey_to_b64(key: bytes) -> str:
    """raw bytes → base64 字符串（喂给 sendmessage.item_list.*.aes_key）。"""
    return base64.b64encode(key).decode()


def aes_ecb_padded_size(plaintext_size: int) -> int:
    """AES-128-ECB + PKCS7 加密后的字节数（向上取整到 16 倍数 + 至少 16 字节填充）。

    与 OpenClaw `aesEcbPaddedSize`：ceil((n+1)/16)*16
    """
    return ((plaintext_size + 1 + _AES_BLOCK_BYTES - 1) // _AES_BLOCK_BYTES) * _AES_BLOCK_BYTES


def encrypt_aes_ecb(plaintext: bytes, key: bytes) -> bytes:
    """AES-128-ECB + PKCS7 加密。key 必须是 16 字节。"""
    if len(key) != _AES_KEY_BYTES:
        raise ValueError(f"AES-128 key must be {_AES_KEY_BYTES} bytes, got {len(key)}")
    cipher = Cipher(algorithms.AES(key), modes.ECB())
    enc = cipher.encryptor()
    return enc.update(plaintext) + enc.finalize()


def decrypt_aes_ecb(ciphertext: bytes, key: bytes) -> bytes:
    """AES-128-ECB + PKCS7 解密。key 必须是 16 字节。"""
    if len(key) != _AES_KEY_BYTES:
        raise ValueError(f"AES-128 key must be {_AES_KEY_BYTES} bytes, got {len(key)}")
    cipher = Cipher(algorithms.AES(key), modes.ECB())
    dec = cipher.decryptor()
    out = dec.update(ciphertext) + dec.finalize()
    # PKCS7 去填充
    if out:
        pad = out[-1]
        if 1 <= pad <= _AES_BLOCK_BYTES and out[-pad:] == bytes([pad]) * pad:
            out = out[:-pad]
    return out


def gen_filekey_hex() -> str:
    """生成 32 字符 hex filekey（CDN 上唯一标识一次上传，16 random bytes → 32 hex）。"""
    return secrets.token_hex(_AES_KEY_BYTES)


def md5_hex(data: bytes) -> str:
    """明文 MD5（喂给 getuploadurl.rawfilemd5）。"""
    return hashlib.md5(data).hexdigest()


def encrypt_for_upload(plaintext: bytes) -> tuple[bytes, int]:
    """便捷：随机生成 aeskey + 加密，返回 (aeskey_raw, ciphertext, padded_size)。

    返回的 ciphertext 直接 POST 给 CDN；aeskey_raw 调 `aeskey_to_b64` 拼到
    sendmessage.item_list，aeskey_to_hex 喂给 getuploadurl。
    """
    key = gen_aes_key()
    ciphertext = encrypt_aes_ecb(plaintext, key)
    return key, ciphertext, len(ciphertext)


__all__ = [
    "CDN_BASE_URL",
    "UPLOAD_MAX_RETRIES",
    "gen_aes_key",
    "aeskey_to_hex",
    "aeskey_to_b64",
    "aes_ecb_padded_size",
    "encrypt_aes_ecb",
    "decrypt_aes_ecb",
    "gen_filekey_hex",
    "md5_hex",
    "encrypt_for_upload",
]