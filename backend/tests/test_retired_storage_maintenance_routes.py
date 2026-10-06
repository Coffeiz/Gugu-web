"""退役旧维护接口，保留现行存储对账及记忆维护路由契约。"""

import pytest

from app.api.v1 import agent_admin, config


@pytest.mark.parametrize(
    "router,retired,retained",
    [
        (config.router, {"/migrate-trash"}, {"/reconcile-storage", "/memory-cleanup/preview", "/memory-cleanup/apply"}),
        (agent_admin.router, {"/memory/legacy-files", "/memory/legacy-files/cleanup"}, {"/memory/im-scopes"}),
    ],
)
def test_retired_routes_are_not_exposed_and_current_routes_remain(router, retired, retained):
    paths = {route.path.removeprefix(router.prefix) for route in router.routes}
    assert not paths & retired
    assert retained <= paths
