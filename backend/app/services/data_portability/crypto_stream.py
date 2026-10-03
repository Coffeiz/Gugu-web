"""可随机读取的分块 AEAD 容器，归档明文不落临时文件。"""
from __future__ import annotations

import hashlib
import io
import os
import struct
from typing import BinaryIO

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from app.core.config import get_settings

_MAGIC = b"GUGUPV1\0"
_FOOTER = b"GGPEND1\0"
_CHUNK_SIZE = 1024 * 1024
_HEADER_SIZE = 8 + 32 + 16 + 12 + 48 + 4
_RECORD_PREFIX_SIZE = 4
_TAG_SIZE = 16


def _master_key(salt: bytes) -> bytes:
    return HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        info=b"gugu-data-portability-envelope-v1",
    ).derive(get_settings().secret_key.encode("utf-8"))


class EncryptedArchiveWriter:
    """ZipFile 可写入的顺序输出流；容器本身只写 AEAD 密文。"""

    def __init__(self, destination: BinaryIO, context: str, *, chunk_size: int = _CHUNK_SIZE):
        if chunk_size < 4096:
            raise ValueError("加密分块不能小于 4096 字节")
        self.destination = destination
        self.context_hash = hashlib.sha256(context.encode("utf-8")).digest()
        self.chunk_size = chunk_size
        self.key = os.urandom(32)
        self.nonce_prefix = os.urandom(4)
        self.buffer = bytearray()
        self.plaintext_size = 0
        self.block_index = 0
        self.finished = False
        salt = os.urandom(16)
        wrap_nonce = os.urandom(12)
        header_prefix = _MAGIC + self.context_hash + salt + wrap_nonce
        wrapped_key = AESGCM(_master_key(salt)).encrypt(wrap_nonce, self.key, header_prefix)
        self.destination.write(header_prefix + wrapped_key + self.nonce_prefix)

    def writable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return False

    def readable(self) -> bool:
        return False

    def tell(self) -> int:
        return self.plaintext_size

    def seek(self, *_args) -> int:
        raise io.UnsupportedOperation("加密归档输出流不可 seek")

    def write(self, data: bytes | bytearray | memoryview) -> int:
        if self.finished:
            raise ValueError("加密归档已完成")
        value = memoryview(data)
        written = len(value)
        self.plaintext_size += written
        offset = 0
        while offset < written:
            available = self.chunk_size - len(self.buffer)
            take = min(available, written - offset)
            self.buffer.extend(value[offset:offset + take])
            offset += take
            if len(self.buffer) == self.chunk_size:
                self._write_block(bytes(self.buffer))
                self.buffer.clear()
        return written

    def flush(self) -> None:
        self.destination.flush()

    def _write_block(self, plaintext: bytes) -> None:
        length = len(plaintext)
        index_bytes = self.block_index.to_bytes(8, "big")
        length_bytes = struct.pack(">I", length)
        nonce = self.nonce_prefix + index_bytes
        aad = self.context_hash + index_bytes + length_bytes
        ciphertext = AESGCM(self.key).encrypt(nonce, plaintext, aad)
        self.destination.write(length_bytes + ciphertext)
        self.block_index += 1

    def finish(self) -> None:
        if self.finished:
            return
        if self.buffer:
            self._write_block(bytes(self.buffer))
            self.buffer.clear()
        self.destination.write(_FOOTER + struct.pack(">Q", self.plaintext_size))
        self.destination.flush()
        self.finished = True


class EncryptedArchiveReader(io.RawIOBase):
    """对分块密文提供 seek/read，供 zipfile 校验中心目录而不落明文盘。"""

    def __init__(self, source: BinaryIO, context: str, *, chunk_size: int = _CHUNK_SIZE):
        super().__init__()
        self.source = source
        self.chunk_size = chunk_size
        self.context_hash = hashlib.sha256(context.encode("utf-8")).digest()
        source.seek(0, os.SEEK_END)
        source_size = source.tell()
        if source_size < _HEADER_SIZE + 16:
            raise ValueError("加密归档头部不完整")
        source.seek(source_size - 16)
        footer = source.read(16)
        if footer[:8] != _FOOTER:
            raise ValueError("加密归档结尾标记无效")
        self.plaintext_size = struct.unpack(">Q", footer[8:])[0]
        self.block_count = (self.plaintext_size + chunk_size - 1) // chunk_size
        self.data_end = source_size - 16
        expected_size = _HEADER_SIZE + self.plaintext_size + self.block_count * (_RECORD_PREFIX_SIZE + _TAG_SIZE) + 16
        if source_size != expected_size:
            raise ValueError("加密归档长度与封装数据不一致")

        source.seek(0)
        header = source.read(_HEADER_SIZE)
        if len(header) != _HEADER_SIZE or header[:8] != _MAGIC:
            raise ValueError("加密归档格式无效")
        stored_context_hash = header[8:40]
        if stored_context_hash != self.context_hash:
            raise ValueError("加密归档不属于当前任务")
        salt = header[40:56]
        wrap_nonce = header[56:68]
        wrapped_key = header[68:116]
        self.nonce_prefix = header[116:120]
        try:
            self.key = AESGCM(_master_key(salt)).decrypt(
                wrap_nonce, wrapped_key, header[:68]
            )
        except Exception as exc:
            raise ValueError("加密归档密钥校验失败") from exc
        self.position = 0
        self._cached_block_index: int | None = None
        self._cached_block = b""

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def tell(self) -> int:
        return self.position

    def seek(self, offset: int, whence: int = os.SEEK_SET) -> int:
        if whence == os.SEEK_SET:
            position = offset
        elif whence == os.SEEK_CUR:
            position = self.position + offset
        elif whence == os.SEEK_END:
            position = self.plaintext_size + offset
        else:
            raise ValueError("无效的 seek whence")
        if position < 0:
            raise ValueError("不能 seek 到负偏移")
        self.position = min(position, self.plaintext_size)
        return self.position

    def readinto(self, buffer) -> int:
        view = memoryview(buffer).cast("B")
        data = self.read(len(view))
        view[:len(data)] = data
        return len(data)

    def read(self, size: int = -1) -> bytes:
        if self.closed:
            raise ValueError("读取已关闭的加密归档")
        if size is None or size < 0:
            size = self.plaintext_size - self.position
        size = min(size, self.plaintext_size - self.position)
        if size <= 0:
            return b""
        output = bytearray()
        remaining = size
        while remaining:
            index = self.position // self.chunk_size
            block = self._load_block(index)
            within = self.position % self.chunk_size
            take = min(remaining, len(block) - within)
            if take <= 0:
                raise ValueError("加密归档分块长度无效")
            output.extend(block[within:within + take])
            self.position += take
            remaining -= take
        return bytes(output)

    def _load_block(self, index: int) -> bytes:
        if index == self._cached_block_index:
            return self._cached_block
        if index < 0 or index >= self.block_count:
            raise ValueError("加密归档分块索引超界")
        full_record_size = _RECORD_PREFIX_SIZE + self.chunk_size + _TAG_SIZE
        offset = _HEADER_SIZE + index * full_record_size
        self.source.seek(offset)
        prefix = self.source.read(_RECORD_PREFIX_SIZE)
        if len(prefix) != _RECORD_PREFIX_SIZE:
            raise ValueError("加密归档分块头部不完整")
        length = struct.unpack(">I", prefix)[0]
        expected_length = min(self.chunk_size, self.plaintext_size - index * self.chunk_size)
        if length != expected_length:
            raise ValueError("加密归档分块长度无效")
        ciphertext = self.source.read(length + _TAG_SIZE)
        if len(ciphertext) != length + _TAG_SIZE:
            raise ValueError("加密归档分块不完整")
        index_bytes = index.to_bytes(8, "big")
        aad = self.context_hash + index_bytes + prefix
        try:
            plaintext = AESGCM(self.key).decrypt(
                self.nonce_prefix + index_bytes, ciphertext, aad
            )
        except Exception as exc:
            raise ValueError("加密归档内容校验失败") from exc
        self._cached_block_index = index
        self._cached_block = plaintext
        return plaintext
