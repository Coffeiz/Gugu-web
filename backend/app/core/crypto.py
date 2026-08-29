"""静态加密：IM Bot 凭据（目前是 UserBot.app_secret）落库前加密，读出时透明解密。

密钥从 settings.secret_key 用 HKDF 派生一把独立的 AEAD key（不复用同一把 key
既签 JWT 又做加密），派生用固定 info 标签做用途隔离。

只加密 app_secret，不加密 app_id：app_id 是机器人的公开标识符（类似 client_id），
qq_connect.py / feishu_connect.py 的 upsert 逻辑会用 `UserBot.app_id == xxx` 做 SQL
等值查询去重——AES-GCM 每次加密都带随机 IV，密文不等值，加密 app_id 会直接打断
这个去重匹配（同一个 app_id 每次重新绑定都会插入新行而不是更新）。app_secret 不
参与任何等值查询，加密不影响现有逻辑。
"""
import base64
import os

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from sqlalchemy.types import Text, TypeDecorator

from app.core.config import get_settings

_HKDF_INFO = b"gugu-user-bot-secret-v1"
_PREFIX = "gcm1:"


def _derive_key() -> bytes:
    secret = get_settings().secret_key.encode("utf-8")
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=_HKDF_INFO).derive(secret)


def is_encrypted(value: str) -> bool:
    return bool(value) and value.startswith(_PREFIX)


def encrypt_secret(plaintext: str) -> str:
    """空值保持空值（未配置态）；已经是密文（幂等重跑迁移）原样返回。"""
    if not plaintext:
        return ""
    if is_encrypted(plaintext):
        return plaintext
    key = _derive_key()
    iv = os.urandom(12)
    ct = AESGCM(key).encrypt(iv, plaintext.encode("utf-8"), None)
    return _PREFIX + base64.b64encode(iv + ct).decode("ascii")


def decrypt_secret(token: str) -> str:
    """非密文（历史明文行/迁移窗口内）原样返回；密钥不匹配或数据损坏也原样返回而不抛错——
    交给上层（bot 登录）因凭据不对自然失败，好过在 ORM 读取层直接炸掉整个请求。"""
    if not token or not is_encrypted(token):
        return token
    key = _derive_key()
    try:
        raw = base64.b64decode(token[len(_PREFIX):])
        iv, ct = raw[:12], raw[12:]
        return AESGCM(key).decrypt(iv, ct, None).decode("utf-8")
    except Exception:
        return token


class EncryptedString(TypeDecorator):
    """透明加解密的字符串列：写入前加密、读出后解密，业务代码零改动。"""
    impl = Text
    cache_ok = True

    def process_bind_param(self, value, dialect):
        if value is None:
            return None
        return encrypt_secret(value)

    def process_result_value(self, value, dialect):
        if value is None:
            return None
        return decrypt_secret(value)
