"""migrate_qqbot_runtime_keys.py 的 fake Redis 回归测试。

历史 bug：imreach:<uid>:qqbot 这类 key 以 "qqbot" 结尾、后面没有冒号，中缀替换
":qqbot:" 永远匹配不到，new_key 会等于 old_key；_move_key() 把"跟自己相同"误判成
"已存在"，直接把唯一一份数据删掉——不是迁移，是误删。这里用一个最小的内存版
fake redis 复现真实 key 形态，确保修复后数据被正确迁移、不会被删。
"""
import json

import pytest


class FakeRedis:
    def __init__(self):
        self.store: dict[str, str] = {}
        self.ttls: dict[str, int] = {}

    async def scan_iter(self, match: str):
        import fnmatch
        for key in list(self.store):
            if fnmatch.fnmatch(key, match):
                yield key

    async def exists(self, key: str) -> bool:
        return key in self.store

    async def get(self, key: str):
        return self.store.get(key)

    async def set(self, key: str, value: str, ex: int | None = None):
        self.store[key] = value
        if ex:
            self.ttls[key] = ex

    async def delete(self, key: str) -> int:
        existed = key in self.store
        self.store.pop(key, None)
        self.ttls.pop(key, None)
        return 1 if existed else 0

    async def ttl(self, key: str) -> int:
        return self.ttls.get(key, -1)

    async def renamenx(self, old_key: str, new_key: str) -> bool:
        if new_key in self.store:
            return False
        self.store[new_key] = self.store.pop(old_key)
        if old_key in self.ttls:
            self.ttls[new_key] = self.ttls.pop(old_key)
        return True


@pytest.fixture
def fake_redis(monkeypatch):
    import scripts.migrate_qqbot_runtime_keys as migrate_mod

    redis = FakeRedis()
    monkeypatch.setattr(migrate_mod, "get_redis", lambda: redis)
    return redis


@pytest.mark.asyncio
async def test_imreach_platform_suffixed_key_migrates_without_data_loss(fake_redis):
    """imreach:<uid>:qqbot 这类 key 迁移后必须真的搬到 imreach:<uid>:qq，不能被删掉。"""
    from scripts.migrate_qqbot_runtime_keys import migrate

    payload = json.dumps({"platform": "qqbot", "channel_id": "1", "chat_id": "g1", "puid": "u1"})
    await fake_redis.set("imreach:42:qqbot", payload, ex=1000)

    moved = await migrate(dry_run=False)

    assert moved == 1
    assert "imreach:42:qqbot" not in fake_redis.store
    new_value = json.loads(fake_redis.store["imreach:42:qq"])
    assert new_value["platform"] == "qq"
    assert new_value["chat_id"] == "g1"
    assert fake_redis.ttls.get("imreach:42:qq") == 1000


@pytest.mark.asyncio
async def test_imsession_key_migrates():
    from scripts.migrate_qqbot_runtime_keys import migrate
    import scripts.migrate_qqbot_runtime_keys as migrate_mod

    redis = FakeRedis()
    migrate_mod.get_redis = lambda: redis
    await redis.set("imsession:qqbot:group-1", "123")

    moved = await migrate(dry_run=False)

    assert moved == 1
    assert "imsession:qqbot:group-1" not in redis.store
    assert redis.store["imsession:qq:group-1"] == "123"


@pytest.mark.asyncio
async def test_bare_imreach_key_platform_field_rewritten_in_place(fake_redis):
    """无平台后缀的兜底 imreach:<uid> 不改 key，只在 JSON 里把 platform 字段改掉。"""
    from scripts.migrate_qqbot_runtime_keys import migrate

    payload = json.dumps({"platform": "qqbot", "channel_id": "1"})
    await fake_redis.set("imreach:99", payload, ex=500)

    moved = await migrate(dry_run=False)

    assert moved == 1
    assert "imreach:99" in fake_redis.store   # key 本身没变
    value = json.loads(fake_redis.store["imreach:99"])
    assert value["platform"] == "qq"
    assert fake_redis.ttls.get("imreach:99") == 500


@pytest.mark.asyncio
async def test_bare_imreach_key_untouched_when_not_qq(fake_redis):
    """兜底 key 如果最近一次触达是别的平台，不能被这个脚本动。"""
    from scripts.migrate_qqbot_runtime_keys import migrate

    payload = json.dumps({"platform": "feishu", "channel_id": "1"})
    await fake_redis.set("imreach:7", payload)

    moved = await migrate(dry_run=False)

    assert moved == 0
    assert json.loads(fake_redis.store["imreach:7"])["platform"] == "feishu"


@pytest.mark.asyncio
async def test_dry_run_does_not_modify_redis(fake_redis):
    from scripts.migrate_qqbot_runtime_keys import migrate

    payload = json.dumps({"platform": "qqbot"})
    await fake_redis.set("imreach:1:qqbot", payload)
    await fake_redis.set("imreach:1", payload)

    moved = await migrate(dry_run=True)

    assert moved == 2
    assert "imreach:1:qqbot" in fake_redis.store
    assert json.loads(fake_redis.store["imreach:1"])["platform"] == "qqbot"


@pytest.mark.asyncio
async def test_move_key_skips_instead_of_deleting_when_old_equals_new(fake_redis):
    """防御性回归：即便未来又出现一次 old_key == new_key，也必须跳过而不是删数据。"""
    from scripts.migrate_qqbot_runtime_keys import _move_key

    await fake_redis.set("imreach:5:qq", "payload")

    result = await _move_key(fake_redis, "imreach:5:qq", "imreach:5:qq", dry_run=False)

    assert result is False
    assert fake_redis.store["imreach:5:qq"] == "payload"
