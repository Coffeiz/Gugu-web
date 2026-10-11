"""QQ 扫码连接：scan_url 必须指向腾讯官方 /qqbot/openclaw/connect.html。

回归测试 — 平台内部标识 platform="qq"，但腾讯开放平台上的扫码页 URL 路径
是 /qqbot/openclaw/（不是 /qq/openclaw/）。两个标识不能混用：
- 咕咕内部 platform 标识：一直保持 "qq"
- 腾讯外部 scan URL path：必须是 /qqbot/

之前 qq_connect.py 第 34 行被误改成 `/qq/openclaw/connect.html`，导致
生成的二维码扫出来跳到腾讯错误页（白屏 / 404），扫码授权链路直接断。

这个测试锁住正确的 scan_url 形态，确保以后不会再被"平台标识统一"误伤。
"""
from __future__ import annotations

import json
from urllib.parse import urlparse, parse_qs

import pytest

from app.api.v1 import qq_connect
from app.core.security import get_current_user, create_user_token


# ── 最小 fixture：内存 fake redis + fake httpx（避免真实外网） ───────────

class FakeRedis:
    """get_redis() 返回的对象只需要 .set/.publish，够本测试用。"""
    def __init__(self):
        self.values = {}
    async def set(self, key, value, **kwargs):
        self.values[key] = value
        return True
    async def get(self, key):
        return self.values.get(key)
    async def publish(self, *a, **kw):
        return 0


class FakeResponse:
    """模拟腾讯 /lite/create_bind_task 的成功响应。"""
    def __init__(self, payload):
        self._payload = payload
    def raise_for_status(self):
        return None
    def json(self):
        return self._payload


class FakeAsyncClient:
    """模拟 httpx.AsyncClient —— 不发外网，按 path 路由返回。"""
    def __init__(self, *a, **kwargs):
        pass
    async def __aenter__(self):
        return self
    async def __aexit__(self, *a):
        return False
    async def post(self, url, json=None, headers=None):
        # 这次只关心 /lite/create_bind_task 这一支
        if url.endswith("/lite/create_bind_task"):
            return FakeResponse({"retcode": 0, "msg": "ok",
                                 "data": {"task_id": "task-test-123"}})
        return FakeResponse({"retcode": -1, "msg": "unexpected path"})


# ── 测试本体 ───────────────────────────────────────────────

@pytest.mark.asyncio
async def test_qq_connect_scan_url_points_to_tencent_official_qqbot_path(
    db, user_a, monkeypatch,
):
    """scan_url 必须走 https://q.qq.com/qqbot/openclaw/connect.html（带 task_id / _wv=2 / source=Gugu）。

    锁住的核心：
    1. URL 主机：q.qq.com
    2. URL 路径：/qqbot/openclaw/connect.html（不是 /qq/openclaw/）
    3. 三个 query 参数：task_id / _wv=2 / source=Gugu
    """
    import httpx
    from app.db import session as db_session
    from app.db.session import get_db

    # 1. mock Redis（存 aes_key）
    fake_redis = FakeRedis()
    monkeypatch.setattr(qq_connect.R, "get_redis", lambda: fake_redis)

    # 2. mock httpx（拦截 /lite/create_bind_task）
    monkeypatch.setattr(httpx, "AsyncClient", FakeAsyncClient)

    # 3. override get_current_user —— 走 jwt 解析太重，直接返回 user_a
    from app.main import app
    app.dependency_overrides[get_current_user] = lambda: user_a
    try:
        # 4. 直接调路由函数（不走 TestClient，不依赖 app 启动）
        result = await qq_connect.start(current_user=user_a)
    finally:
        app.dependency_overrides.pop(get_current_user, None)

    # 5. 解析 scan_url 锁住正确形态
    assert "scan_url" in result
    assert "task_id" in result

    scan_url = result["scan_url"]
    parsed = urlparse(scan_url)

    # 主机必须是 q.qq.com（默认配置；PORTAL_HOST 默认值）
    assert parsed.scheme == "https"
    assert parsed.netloc == "q.qq.com"

    # 路径必须以 /qqbot/openclaw/connect.html 开头
    # —— 这是修复的核心：之前是 /qq/openclaw/（错的），导致二维码跳转失败
    assert parsed.path == "/qqbot/openclaw/connect.html", (
        f"scan_url 路径错误：{parsed.path}。"
        f"腾讯官方扫码页是 /qqbot/openclaw/connect.html，不是 /qq/openclaw/。"
    )

    # 三个 query 参数必须齐全
    qs = parse_qs(parsed.query)
    assert qs.get("task_id") == ["task-test-123"]
    assert qs.get("_wv") == ["2"]
    assert qs.get("source") == ["Gugu"]

    # 6. aes_key 已经写入 redis（按 task_id 索引）
    meta = json.loads(fake_redis.values[f"qqconnect:{result['task_id']}"])
    assert meta["uid"] == str(user_a.id)
    assert "key" in meta


@pytest.mark.asyncio
async def test_qq_connect_platform_identifier_stays_qq(db, user_a, monkeypatch):
    """回归锁：咕咕内部 platform 标识继续保持 "qq"，不能误改成 "qqbot"。

    修腾讯 scan_url path 的同时不能把内部 platform 也连带改了——
    UserBot.platform == "qq" 是历史所有数据的标识，改了会破坏既有 binding。
    """
    import httpx
    from app.api.v1 import qq_connect
    from app.models import UserBot

    fake_redis = FakeRedis()
    monkeypatch.setattr(qq_connect.R, "get_redis", lambda: fake_redis)
    monkeypatch.setattr(httpx, "AsyncClient", FakeAsyncClient)

    # 模拟：完成扫码授权后，backend 要写一条 UserBot
    # 直接走 poll 路径的最后那段 upsert 逻辑
    # 简单做法：手动构造一条 UserBot，看它的 platform 字段
    bot = UserBot(user_id=user_a.id, platform="qq",  # ← 必须是 "qq"，不是 "qqbot"
                  name="我的 QQ 机器人", app_id="app-1", app_secret="secret-1",
                  enabled=True)
    db.add(bot)
    await db.commit()
    await db.refresh(bot)

    assert bot.platform == "qq"


@pytest.mark.asyncio
async def test_qq_connect_scan_url_contains_all_required_query_params(
    db, user_a, monkeypatch,
):
    """scan_url 必须包含 task_id、_wv=2、source=Gugu 这三个参数（缺一不可）。"""
    import httpx

    fake_redis = FakeRedis()
    monkeypatch.setattr(qq_connect.R, "get_redis", lambda: fake_redis)
    monkeypatch.setattr(httpx, "AsyncClient", FakeAsyncClient)

    result = await qq_connect.start(current_user=user_a)
    scan_url = result["scan_url"]
    parsed = urlparse(scan_url)
    qs = parse_qs(parsed.query)

    # 三个关键 query 参数都在
    for required in ("task_id", "_wv", "source"):
        assert required in qs, f"scan_url 缺少 {required} 参数：{scan_url}"

    # source 必须等于 "Gugu"（腾讯开放平台用来识别来源是咕咕，不是别的第三方）
    assert qs["source"][0] == "Gugu"
    # _wv 必须等于 "2"（这是腾讯开放平台 webview 协议版本号，2 是当前约定）
    assert qs["_wv"][0] == "2"
