import pytest

from agent.gateway import qq


@pytest.mark.parametrize(
    ("requires_at", "read_enabled", "expected"),
    [
        (True, False, True),
        (True, True, False),
        (False, False, False),
        (False, True, False),
    ],
)
def test_platform_requires_mention_maps_local_group_switches(
    requires_at, read_enabled, expected
):
    assert qq._platform_requires_mention((True, requires_at, read_enabled)) is expected


def test_build_claw_config_uses_platform_mode():
    assert qq._build_claw_config(True)["require_mention"] == "mention"
    assert qq._build_claw_config(False)["require_mention"] == "always"


@pytest.mark.asyncio
async def test_interaction_query_acks_with_derived_mode(monkeypatch):
    acked = []

    async def fake_settings(_channel_id):
        return True, True, True

    async def fake_ack(channel_id, interaction_id, *, code=0, data=None):
        acked.append((channel_id, interaction_id, code, data))

    monkeypatch.setattr(qq, "_group_settings", fake_settings)
    monkeypatch.setattr(qq, "_ack_qq_interaction", fake_ack)

    await qq._handle_qq_interaction(
        {
            "id": "interaction-1",
            "data": {"type": qq._INTERACTION_QUERY},
        },
        "bot-1",
    )

    assert acked == [
        (
            "bot-1",
            "interaction-1",
            0,
            {"claw_cfg": qq._build_claw_config(False)},
        )
    ]


@pytest.mark.asyncio
async def test_interaction_update_does_not_disable_always_mode_for_read_only(monkeypatch):
    updates = []
    acked = []

    async def fake_settings(_channel_id):
        return True, True, True

    async def fake_update(channel_id, requires_at):
        updates.append((channel_id, requires_at))

    async def fake_ack(channel_id, interaction_id, *, code=0, data=None):
        acked.append((channel_id, interaction_id, code, data))

    monkeypatch.setattr(qq, "_group_settings", fake_settings)
    monkeypatch.setattr(qq, "_set_group_requires_at", fake_update)
    monkeypatch.setattr(qq, "_ack_qq_interaction", fake_ack)

    await qq._handle_qq_interaction(
        {
            "id": "interaction-2",
            "data": {
                "type": qq._INTERACTION_UPDATE,
                "resolved": {"claw_cfg": {"require_mention": "mention"}},
            },
        },
        "bot-1",
    )

    assert updates == [("bot-1", True)]
    assert acked[0][3] == {"claw_cfg": qq._build_claw_config(False)}
