"""兼容旧导入路径；实现位于 `agent.gateway.wechat.media_crypto`。"""

from .wechat.media_crypto import (
    CDN_BASE_URL,
    UPLOAD_MAX_RETRIES,
    aes_ecb_padded_size,
    aeskey_to_b64,
    aeskey_to_hex,
    decrypt_aes_ecb,
    encrypt_aes_ecb,
    encrypt_for_upload,
    gen_aes_key,
    gen_filekey_hex,
    md5_hex,
)

__all__ = [
    "CDN_BASE_URL",
    "UPLOAD_MAX_RETRIES",
    "aes_ecb_padded_size",
    "aeskey_to_b64",
    "aeskey_to_hex",
    "decrypt_aes_ecb",
    "encrypt_aes_ecb",
    "encrypt_for_upload",
    "gen_aes_key",
    "gen_filekey_hex",
    "md5_hex",
]
