"""保护主 Agent 的连接复用及 run 结束后的有界回收。"""
import asyncio

from agent.providers.client_pool import ProviderClientPool


class _FakeClient:
    def __init__(self):
        self.close_count = 0
        self.is_closed = False

    async def close(self):
        self.close_count += 1
        self.is_closed = True


def test_provider_client_reuses_between_runs_and_closes_after_idle_ttl():
    pool = ProviderClientPool(idle_close_seconds=0.02)
    created = []

    def factory():
        client = _FakeClient()
        created.append(client)
        return client

    async def exercise():
        first_scope = pool.new_run_scope()
        with pool.activate(first_scope):
            first = pool.get_or_create("same-config", factory)
        pool.finish_run_scope(first_scope)
        await asyncio.sleep(0.005)
        second_scope = pool.new_run_scope()
        with pool.activate(second_scope):
            second = pool.get_or_create("same-config", factory)
        pool.finish_run_scope(second_scope)
        assert second is first
        assert len(created) == 1
        await asyncio.sleep(0.04)
        assert first.close_count == 1
        third_scope = pool.new_run_scope()
        with pool.activate(third_scope):
            third = pool.get_or_create("same-config", factory)
        pool.finish_run_scope(third_scope)
        assert third is not first
        assert len(created) == 2

    asyncio.run(exercise())


def test_provider_client_waits_until_all_active_runs_release_it():
    pool = ProviderClientPool(idle_close_seconds=0.01)
    created = []

    def factory():
        client = _FakeClient()
        created.append(client)
        return client

    async def exercise():
        first_entered = asyncio.Event()
        release_first = asyncio.Event()

        async def first_run():
            scope = pool.new_run_scope()
            with pool.activate(scope):
                first = pool.get_or_create("same-config", factory)
                first_entered.set()
                await release_first.wait()
            pool.finish_run_scope(scope)
            return first

        task = asyncio.create_task(first_run())
        await first_entered.wait()
        second_scope = pool.new_run_scope()
        with pool.activate(second_scope):
            second = pool.get_or_create("same-config", factory)
        pool.finish_run_scope(second_scope)
        await asyncio.sleep(0.02)
        assert second.close_count == 0
        release_first.set()
        first = await task
        assert first is second
        await asyncio.sleep(0.02)
        assert second.close_count == 1

    asyncio.run(exercise())


def test_provider_config_key_does_not_contain_api_key():
    from agent.providers.client_pool import config_key

    secret = "synthetic-secret-for-test"
    key = config_key(
        "openai",
        base_url="https://provider.example/v1",
        api_key=secret,
        headers={"X-Provider": "synthetic"},
        timeout=30.0,
    )
    assert secret not in key
    assert len(key) == 64


def test_provider_builders_share_sdk_transport_with_ten_minute_idle_limit(monkeypatch):
    from types import SimpleNamespace

    from agent import providers
    from agent.providers import client_pool as client_pool_module

    pool = ProviderClientPool(idle_close_seconds=0.01)
    monkeypatch.setattr(client_pool_module, "provider_client_pool", pool)
    ai = SimpleNamespace(
        provider="custom",
        model="synthetic-model",
        api_key="synthetic-key",
        base_url="https://provider.example/v1",
    )

    async def exercise():
        scope = pool.new_run_scope()
        with pool.activate(scope):
            openai_first = providers.build_openai_client(ai, 12.0)
            openai_second = providers.build_openai_client(ai, 12.0)
            anthropic_first = providers.build_anthropic_client(ai, 12.0)
            anthropic_second = providers.build_anthropic_client(ai, 12.0)

            assert openai_first is openai_second
            assert anthropic_first is anthropic_second
            assert openai_first._client._transport._pool._keepalive_expiry == 600.0
            assert anthropic_first._client._transport._pool._keepalive_expiry == 600.0

        pool.finish_run_scope(scope)
        await asyncio.sleep(0.03)
        assert openai_first.is_closed()
        assert anthropic_first.is_closed()

    asyncio.run(exercise())
