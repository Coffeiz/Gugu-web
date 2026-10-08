"""账户注销的存储前缀清理契约。"""

import pytest


@pytest.mark.asyncio
async def test_delete_account_cleans_legacy_onboarding_prefix(monkeypatch, db, user_a):
    from app.services.account_deletion import delete_account

    class StorageStub:
        def __init__(self):
            self.prefixes = []

        async def delete_prefix(self, prefix):
            self.prefixes.append(prefix)
            return 1

    storage = StorageStub()
    monkeypatch.setattr("app.services.storage.get_storage", lambda: storage)

    removed = await delete_account(db, user_a)

    assert removed == 2
    assert storage.prefixes == [f"{user_a.id}/", f"u/{user_a.id}/"]
