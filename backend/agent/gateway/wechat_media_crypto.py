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

from cryptography.hazmat.primitives import padding as _crypto_padding
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
    """raw bytes → hex 字符串 → utf-8 字节 → base64 编码（44 字符）。

    仿 OpenClaw `messaging/send.ts` 写法：
        aes_key: Buffer.from(uploaded.aeskey).toString("base64")
    其中 `uploaded.aeskey` 是 hex string，`Buffer.from(hex).toString("base64")` 就是
    「把 hex 字符串当 ASCII 字节再 base64 编码」= 44 字符。

    **为什么不是直接 base64(raw 16 bytes)**：iLink 服务端对 `aes_key` 字段的解码路径是
    「base64 decode → hex decode → 16 字节 raw」，期望 base64 解码后是 32 字节 ASCII。
    传 24 字符 base64(raw) 的话 base64 decode 后只有 16 字节 raw，服务端 hex-decode 失败，
    客户端用错 key 解密 → 微信收到「灰色打不开」的占位图（2026-07-09 实测《海边码头.jpg》）。

    入站方向（`wechat.py:_ingest_wechat_media`）也是 hex 字符串格式（`bytes.fromhex(aeskey)`），
    两边对称。
    """
    return base64.b64encode(key.hex().encode("utf-8")).decode()


def aes_ecb_padded_size(plaintext_size: int) -> int:
    """AES-128-ECB + PKCS7 加密后的字节数（向上取整到 16 倍数 + 至少 16 字节填充）。

    与 OpenClaw `aesEcbPaddedSize`：ceil((n+1)/16)*16
    """
    return ((plaintext_size + 1 + _AES_BLOCK_BYTES - 1) // _AES_BLOCK_BYTES) * _AES_BLOCK_BYTES


def encrypt_aes_ecb(plaintext: bytes, key: bytes) -> bytes:
    """AES-128-ECB + PKCS7 加密。key 必须是 16 字节。

    ⚠️ **必须显式 PKCS7 padding**：cryptography 库的 ECB 模式**不会自动 padding**——
    plaintext 不是 16 字节倍数时 `cipher.update()` 直接抛
    `ValueError: The length of the provided data is not a multiple of the block length`。
    跟 OpenSSL 默认行为一致（ECB 没规定 padding，得显式加）。
    """
    if len(key) != _AES_KEY_BYTES:
        raise ValueError(f"AES-128 key must be {_AES_KEY_BYTES} bytes, got {len(key)}")
    padder = _crypto_padding.PKCS7(_AES_BLOCK_BYTES * 8).padder()  # 块大小按 bit
    padded = padder.update(plaintext) + padder.finalize()
    cipher = Cipher(algorithms.AES(key), modes.ECB())
    enc = cipher.encryptor()
    return enc.update(padded) + enc.finalize()


def decrypt_aes_ecb(ciphertext: bytes, key: bytes) -> bytes:
    """AES-128-ECB + PKCS7 解密。key 必须是 16 字节。

    入站数据 iLink 服务端已经 pad 过，ciphertext 必是 16 倍数；用 cryptography 自带
    Unpadder 去掉 PKCS7 填充（保留旧的 manual unpadding 兼容路径在 `_aes128_ecb_decrypt` 里）。
    """
    if len(key) != _AES_KEY_BYTES:
        raise ValueError(f"AES-128 key must be {_AES_KEY_BYTES} bytes, got {len(key)}")
    if len(ciphertext) % _AES_BLOCK_BYTES != 0:
        raise ValueError(f"ciphertext length {len(ciphertext)} is not a multiple of {_AES_BLOCK_BYTES}")
    cipher = Cipher(algorithms.AES(key), modes.ECB())
    dec = cipher.decryptor()
    padded_out = dec.update(ciphertext) + dec.finalize()
    unpadder = _crypto_padding.PKCS7(_AES_BLOCK_BYTES * 8).unpadder()
    return unpadder.update(padded_out) + unpadder.finalize()


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