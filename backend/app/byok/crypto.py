"""BYOK 专用信封加密；与 JWT 签名和 UserBot 历史加密实现隔离。"""
import base64
import hashlib
import os
from pathlib import Path
import secrets

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.core.config import get_settings

_INFO = b"gugu-byok-envelope-v1"


def _persistent_master_key() -> str:
    """首次运行自动生成并复用主密钥，避免本地部署必须手动改 .env。"""
    path = Path(os.getenv(
        "CREDENTIALS_MASTER_KEY_FILE",
        str(Path(__file__).resolve().parents[2] / "data" / ".byok-master-key"),
    ))
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        raw = path.read_text(encoding="ascii").strip()
        if raw:
            os.chmod(path, 0o600)
            return raw
    except FileNotFoundError:
        pass
    generated = secrets.token_urlsafe(32)
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="ascii") as handle:
            handle.write(generated + "\n")
        return generated
    except FileExistsError:
        # 多 worker 同时首次启动时，胜出的进程写入后直接读取同一份密钥。
        return path.read_text(encoding="ascii").strip()


def _master_key(version: int = 1) -> bytes:
    current_version = int(os.getenv("CREDENTIALS_MASTER_KEY_VERSION", "1"))
    raw = (os.getenv("CREDENTIALS_MASTER_KEY_PREVIOUS", "")
           if version == current_version - 1 else "")
    raw = raw or os.getenv("CREDENTIALS_MASTER_KEY", "") or get_settings().byok.master_key
    if not raw:
        raw = _persistent_master_key()
    try:
        decoded = base64.b64decode(raw, validate=True)
        if len(decoded) == 32:
            return decoded
    except Exception:
        pass
    if len(raw) == 64:
        try:
            decoded = bytes.fromhex(raw)
            if len(decoded) == 32:
                return decoded
        except ValueError:
            pass
    return hashlib.sha256(raw.encode("utf-8")).digest()


def encrypt_envelope(plaintext: str, *, key_version: int | None = None) -> tuple[str, str, str]:
    if not plaintext:
        raise ValueError("凭据不能为空")
    key_version = key_version or int(os.getenv("CREDENTIALS_MASTER_KEY_VERSION", "1"))
    data_key = AESGCM.generate_key(bit_length=256)
    nonce = os.urandom(12)
    ciphertext = AESGCM(data_key).encrypt(nonce, plaintext.encode("utf-8"), _INFO)
    wrap_nonce = os.urandom(12)
    wrapped = wrap_nonce + AESGCM(_master_key(key_version)).encrypt(
        wrap_nonce, data_key, f"{_INFO}:{key_version}".encode("ascii"))
    return (base64.b64encode(ciphertext).decode("ascii"),
            base64.b64encode(nonce).decode("ascii"),
            base64.b64encode(wrapped).decode("ascii"))


def decrypt_envelope(ciphertext: str, nonce: str, encrypted_data_key: str, *, key_version: int = 1) -> str:
    wrapped = base64.b64decode(encrypted_data_key)
    wrap_nonce, wrapped_key = wrapped[:12], wrapped[12:]
    data_key = AESGCM(_master_key(key_version)).decrypt(
        wrap_nonce, wrapped_key, f"{_INFO}:{key_version}".encode("ascii"))
    return AESGCM(data_key).decrypt(
        base64.b64decode(nonce), base64.b64decode(ciphertext), _INFO).decode("utf-8")
