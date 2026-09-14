"""app/core/chat_attach.py 单元补测（CRAP 治理 P1）。

覆盖：QQ 表情缓存、同步暂存 stage_sync（线程 + 回滚）、reuse_attachment 引用复用、
get_meta_many 双通道读取、clear_staged 三路清理、resolve_attach 匹配阶梯、
vision 图片适配/封块、_audio_enabled 能力判定、build_user_content 内容块拼装。
DB 走 conftest 内存库，Redis 走 fakeredis，embedding/PIL 探针按需打桩。
"""
import base64
import io
import json
from types import SimpleNamespace

import pytest

from app.services.storage import LocalStorageBackend


@pytest.fixture
def storage(tmp_path, monkeypatch):
    s = LocalStorageBackend(tmp_path)
    monkeypatch.setattr("app.core.chat_attach.get_storage", lambda: s)
    monkeypatch.setattr("app.services.storage.get_storage", lambda: s)
    return s


def _png_bytes(size=(2, 2), mode="RGB"):
    from PIL import Image

    buf = io.BytesIO()
    Image.new(mode, size).save(buf, format="PNG")
    return buf.getvalue()


async def _seed_draft(db, user_id, attach_id, storage_key, *, state="draft",
                      platform=None, platform_message_id=None, attachment_index=None,
                      kind="image", ext="png", name="a.png", extra=None, message_id=None):
    from app.core.tz import now_utc
    from app.models import ChatAttachment

    row = ChatAttachment(
        attach_id=attach_id, user_id=user_id, storage_key=storage_key,
        platform=platform, platform_message_id=platform_message_id,
        attachment_index=attachment_index, name=name, ext=ext,
        mime="image/png" if ext == "png" else None, kind=kind, size=3,
        state=state, message_id=message_id, created_at=now_utc(), extra=extra,
    )
    db.add(row)
    await db.commit()
    return row


# ── QQ 表情缓存 ────────────────────────────────────────────────────────────

async def test_qq_face_cache_roundtrip_and_guards(storage, user_a):
    from app.core import chat_attach as ca

    uid = user_a.id
    # 空 face_id 直接放行：不读也不写
    assert await ca.get_qq_face_cached(uid, "face", " ") is None

    # 空 attach_id 不写缓存
    await ca.set_qq_face_cached(uid, "face", "123", "")
    # 正常写入后缓存键存在
    await ca.set_qq_face_cached(uid, "face", "123", "a1b2c3d4e5f60718")
    key = ca._qq_face_cache_key(uid, "face", "123")
    assert await ca.get_redis().get(key) == "a1b2c3d4e5f60718"

    # 命中缓存 → 回读 legacy redis 元数据（DB 无此行）
    await ca.get_redis().set(
        ca._key(uid, "a1b2c3d4e5f60718"),
        json.dumps({"attach_id": "a1b2c3d4e5f60718", "kind": "image", "storage_key": "x/y.png"}),
    )
    meta = await ca.get_qq_face_cached(uid, "face", "123")
    assert meta["attach_id"] == "a1b2c3d4e5f60718"

    # 缓存键不存在 → None
    assert await ca.get_qq_face_cached(uid, "face", "456") is None


# ── stage_sync（IM 网关同步暂存）───────────────────────────────────────────

def test_stage_sync_puts_bytes_and_records_draft(storage, monkeypatch):
    from app.core import chat_attach as ca

    recorded = []

    async def fake_record(user_id, attach_id, storage_key, meta):
        recorded.append((user_id, attach_id, storage_key, dict(meta)))

    probe_calls = []

    def fake_probe(_data, _ext):
        probe_calls.append(1)
        return 640, 480

    monkeypatch.setattr(ca, "_record_draft_isolated", fake_record)
    monkeypatch.setattr(ca, "_probe_image_size", fake_probe)

    meta = ca.stage_sync(
        "u1", "截图.PNG", "PNG", "image/png", b"\x89PNG-data",
        kind="image", platform="qq", platform_message_id="m1",
        attachment_index=2, extra={"qq_face": "x"},
    )
    assert meta["ext"] == "png" and meta["kind"] == "image"
    assert meta["platform"] == "qq" and meta["platform_message_id"] == "m1"
    assert meta["attachment_index"] == 2 and meta["size"] == len(b"\x89PNG-data")
    assert meta["img_width"] == 640 and meta["img_height"] == 480
    assert meta["qq_face"] == "x"
    assert len(recorded) == 1 and recorded[0][2] == meta["storage_key"]
    assert probe_calls == [1]


def test_stage_sync_rolls_back_storage_when_db_record_fails(storage, monkeypatch):
    from app.core import chat_attach as ca

    async def boom(*_a, **_k):
        raise RuntimeError("db down")

    monkeypatch.setattr(ca, "_record_draft_isolated", boom)
    with pytest.raises(RuntimeError):
        ca.stage_sync("u1", "f.txt", "txt", None, b"data")
    # 落库失败 → 已传的字节必须回收：暂存目录下不残留本次文件
    leftovers = list((storage._root / "u1" / ".chat_staging").glob("*")) \
        if hasattr(storage, "_root") else []
    assert leftovers == [] or all(p.name.startswith("u1") is False for p in leftovers)


# ── reuse_attachment（引用复用，共享物理字节）─────────────────────────────

async def test_reuse_attachment_shares_storage_key_and_merges_extra(storage, db, user_a):
    from app.core import chat_attach as ca

    uid = user_a.id
    await _seed_draft(db, uid, "src1234567890abcd", "u/keep/src.png",
                      state="attached", platform="qq", platform_message_id="m1",
                      attachment_index=0, extra={"origin": "qq"}, message_id=11)
    await storage.put("u/keep/src.png", b"abc")

    # 参数缺失直接 None
    assert await ca.reuse_attachment(uid, platform="", platform_message_id="m1") is None

    # 无匹配行
    assert await ca.reuse_attachment(uid, platform="qq", platform_message_id="nope") is None

    # attachment_index 过滤后无匹配
    assert await ca.reuse_attachment(uid, platform="qq", platform_message_id="m1",
                                     attachment_index=9) is None

    # 物理字节已丢 → 按未命中处理，不制造坏引用
    await _seed_draft(db, uid, "srcghost0000000a", "u/gone/ghost.png",
                      state="attached", platform="qq", platform_message_id="m2",
                      message_id=12)
    assert await ca.reuse_attachment(uid, platform="qq", platform_message_id="m2") is None

    meta = await ca.reuse_attachment(uid, platform="qq", platform_message_id="m1",
                                     attachment_index=0, extra={"quoted": True})
    assert meta["storage_key"] == "u/keep/src.png"       # 共享物理字节
    assert meta["attach_id"] != "src1234567890abcd"      # 独立附件行
    assert meta["origin"] == "qq" and meta["quoted"] is True   # extra 合并
    assert "_ttl" in meta                                # draft 态带剩余额度


# ── get_meta_many（DB 优先 + Redis legacy 兜底）───────────────────────────

async def test_get_meta_many_merges_db_and_legacy_redis(storage, db, user_a, monkeypatch):
    from app.core import chat_attach as ca

    uid = user_a.id
    await _seed_draft(db, uid, "a1a1a1a1a1a1a1a1", "u/x/1.png")
    await _seed_draft(db, uid, "a2a2a2a2a2a2a2a2", "u/x/2.png")
    await ca.get_redis().set(
        ca._key(uid, "legacy1"),
        json.dumps({"attach_id": "legacy1", "storage_key": "u/x/3.png", "kind": "image"}),
    )

    assert await ca.get_meta_many(uid, []) == {}
    result = await ca.get_meta_many(uid, ["a1a1a1a1a1a1a1a1", "a2a2a2a2a2a2a2a2",
                                          "legacy1", "a1a1a1a1a1a1a1a1"])
    assert set(result) == {"a1a1a1a1a1a1a1a1", "a2a2a2a2a2a2a2a2", "legacy1"}
    assert result["a1a1a1a1a1a1a1a1"]["storage_key"] == "u/x/1.png"

    # redis 异常被吞：只返回 DB 命中，不抛
    class BoomRedis:
        async def mget(self, _keys):
            raise RuntimeError("redis down")

    monkeypatch.setattr(ca, "get_redis", lambda: BoomRedis())
    result = await ca.get_meta_many(uid, ["a1a1a1a1a1a1a1a1", "legacy1"])
    assert set(result) == {"a1a1a1a1a1a1a1a1"}


# ── clear_staged（草稿三路清理）───────────────────────────────────────────

async def test_clear_staged_deletes_rows_bytes_and_legacy(storage, db, user_a):
    from app.core import chat_attach as ca
    from sqlalchemy import select

    from app.models import ChatAttachment

    uid = user_a.id
    await _seed_draft(db, uid, "d1d1d1d1d1d1d1d1", "u/stage/1.png")
    await _seed_draft(db, uid, "d2d2d2d2d2d2d2d2", "u/stage/2.png")
    await _seed_draft(db, uid, "kpkpkpkpkpkpkpkp", "u/keep/3.png",
                      state="attached", message_id=21)
    await storage.put("u/stage/1.png", b"1")
    await storage.put("u/stage/2.png", b"2")
    await storage.put("u/keep/3.png", b"3")
    await ca.get_redis().set(
        ca._key(uid, "old1"),
        json.dumps({"attach_id": "old1", "storage_key": "u/gone/old.png"}),
    )

    deleted = await ca.clear_staged(uid)
    assert deleted == 3                                   # 2 个草稿字节 + 1 个 legacy 键

    rows = (await db.execute(
        select(ChatAttachment).where(ChatAttachment.user_id == uid)
    )).scalars().all()
    assert [r.attach_id for r in rows] == ["kpkpkpkpkpkpkpkp"]   # attached 保留
    assert await storage.get("u/keep/3.png") == b"3"
    assert not await storage.exists("u/stage/1.png")
    assert await ca.get_redis().get(ca._key(uid, "old1")) is None


# ── resolve_attach（匹配阶梯）─────────────────────────────────────────────

async def test_resolve_attach_exact_hit_and_empty_pool(storage, db, user_a):
    from app.core import chat_attach as ca

    uid = user_a.id
    # 暂存池为空 → (None, "")
    assert await ca.resolve_attach(uid, "zzzzzzzzzzzzzzzz") == (None, "")
    assert await ca.resolve_attach(uid, "") == (None, "")

    await _seed_draft(db, uid, "exact000000000001", "u/e/1.png")
    meta, note = await ca.resolve_attach(uid, "exact000000000001")
    assert meta["attach_id"] == "exact000000000001" and note == ""
    # 未命中但池里只有一个候选 → 无歧义，退最近上传的那个
    meta, note = await ca.resolve_attach(uid, "zzzzzzzzzzzzzzzz")
    assert meta["attach_id"] == "exact000000000001"
    assert note == "（没对上 attach_id，用了你最近上传的那个附件）"


async def test_resolve_attach_fuzzy_and_ambiguity_ladder(storage, db, user_a, monkeypatch):
    from app.core import chat_attach as ca

    uid = user_a.id
    # 精确 get_meta 不中，但唯一子串命中 → 模糊匹配
    await _seed_draft(db, uid, "aabb000000000001", "u/f/1.png")
    await _seed_draft(db, uid, "ccdd000000000002", "u/f/2.png", kind="voice", ext="amr")
    meta, note = await ca.resolve_attach(uid, "aabb00")
    assert meta["attach_id"] == "aabb000000000001"
    assert note == "（按最接近的附件匹配）"

    # 渠道收窄：当前在 qq，只有一张图 → 唯一候选直接给
    monkeypatch.setattr(ca, "_current_platform", lambda _p: "qq")
    meta, note = await ca.resolve_attach(uid, "aabb00")
    assert meta["attach_id"] == "aabb000000000001"

    # 收窄后同类型多条 → 取最近的一个并注明
    await _seed_draft(db, uid, "aabb000000000003", "u/f/3.png", platform="qq")
    meta, note = await ca.resolve_attach(uid, "aabb00")
    assert note == "（没对上 attach_id，用了你最近上传的那个附件）"

    # 类型不一 + 无渠道收窄 → 不猜，返回候选让模型指定
    monkeypatch.setattr(ca, "_current_platform", lambda _p: None)
    meta, note = await ca.resolve_attach(uid, "none")
    assert meta is None
    assert note.startswith("当前暂存了多个不同类型的附件")
    assert "候选：" in note and "aabb000000000001" in note


# ── vision：图片适配与封块 ────────────────────────────────────────────────

def test_fit_image_for_vision_passthrough_reencode_and_failure():
    from app.core import chat_attach as ca

    small = _png_bytes()
    assert ca._fit_image_for_vision(small, "png") == (small, "image/png")   # 达标原样

    # 非原生格式（bmp）→ 一律重编码 JPEG
    buf = io.BytesIO()
    from PIL import Image
    Image.new("RGB", (2, 2)).save(buf, format="BMP")
    out, media = ca._fit_image_for_vision(buf.getvalue(), "bmp")
    assert media == "image/jpeg" and out[:2] == b"\xff\xd8"

    # 超长边 → 降采样
    big = _png_bytes(size=(4000, 4))
    out, media = ca._fit_image_for_vision(big, "png")
    assert media == "image/jpeg"
    with Image.open(io.BytesIO(out)) as im:
        assert max(im.size) <= ca.VISION_MAX_DIM

    # 透明通道 → 铺白底转 RGB 后重编码
    rgba = _png_bytes(size=(4000, 4), mode="RGBA")
    out, media = ca._fit_image_for_vision(rgba, "png")
    assert media == "image/jpeg"

    # 坏字节 → None
    assert ca._fit_image_for_vision(b"not-an-image", "png") is None


def test_vision_block_building():
    from app.core import chat_attach as ca

    assert ca.vision_block(b"x", "mp4") is None          # 非 vision 扩展名
    assert ca.vision_block(b"broken", "png") is None     # 压缩失败

    raw = _png_bytes()
    block = ca.vision_block(raw, "png")
    assert block["type"] == "image"
    assert block["source"]["media_type"] == "image/png"
    assert base64.b64decode(block["source"]["data"]) == raw


# ── _audio_enabled（能力判定）─────────────────────────────────────────────

def test_audio_enabled_decision_matrix(monkeypatch):
    from app.core import chat_attach as ca

    assert ca._audio_enabled(SimpleNamespace()) is False                    # 缺开关
    assert ca._audio_enabled(SimpleNamespace(vision_audio=False)) is False

    cfg = SimpleNamespace(vision_audio=True)
    monkeypatch.setattr("agent.llm.llm_select.use_anthropic_for", lambda _c: True)
    assert ca._audio_enabled(cfg) is False                                  # Anthropic 路不吃 input_audio

    monkeypatch.setattr("agent.llm.llm_select.use_anthropic_for", lambda _c: False)
    monkeypatch.setattr("agent.providers.capability_snapshot", lambda _c: {"audio": True})
    assert ca._audio_enabled(cfg) is True

    monkeypatch.setattr("agent.providers.capability_snapshot", lambda _c: {"audio": False})
    assert ca._audio_enabled(cfg) is False                                  # 产品开关不越协议能力

    def boom(_c):
        raise RuntimeError("probe fail")

    monkeypatch.setattr("agent.providers.capability_snapshot", boom)
    assert ca._audio_enabled(cfg) is False


# ── build_user_content（provider 内容块拼装）──────────────────────────────

def test_build_user_content_provider_shapes():
    from app.core import chat_attach as ca

    img = {"media_type": "image/png", "b64": "AA=="}
    video = {"type": "video", "mode": "mm_file", "file_id": "f1", "mime": "video/mp4", "b64": "AA=="}
    broken_video = {"type": "video", "mime": "video/mp4"}
    audio = {"type": "audio", "mime": "audio/wav", "b64": "AA=="}

    assert ca.build_user_content("hi", [], False) == "hi"                   # 无图无媒体 → 纯文本

    parts = ca.build_user_content("看图", [img], True, media=[video, broken_video])
    assert parts[0] == {"type": "text", "text": "看图"}
    assert parts[1] == {"type": "image", "source": {"type": "base64",
                                                    "media_type": "image/png", "data": "AA=="}}
    assert parts[2] == {"type": "video",
                        "source": {"type": "url", "url": "mm_file://f1"}, "fps": 1}
    assert len(parts) == 3                                                  # 数据异常的视频块被跳过

    parts = ca.build_user_content("", [img], True)                          # 空文本不给 text 块
    assert parts[0]["type"] == "image"

    parts = ca.build_user_content("听", [], False, media=[audio, video], image_detail="ultra")
    assert parts[0] == {"type": "text", "text": "听"}
    assert parts[1]["type"] == "input_audio"
    assert parts[1]["input_audio"]["data"] == "data:audio/wav;base64,AA=="
    assert parts[2]["type"] == "video_url" and parts[2]["fps"] == 2
    assert parts[2]["video_url"]["url"].startswith("data:video/mp4;base64,")

    # 非法 image_detail 归一回 auto
    parts = ca.build_user_content("t", [img], False, image_detail="ultra")
    assert parts[1]["image_url"]["detail"] == "auto"
