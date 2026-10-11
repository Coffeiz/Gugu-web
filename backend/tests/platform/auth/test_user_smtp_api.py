import pytest


@pytest.mark.asyncio
async def test_get_user_smtp_uses_service_query_without_handler_name_collision(db, user_a):
    from app.api.v1 import preferences as preferences_api
    from app.models import UserSmtpConfig

    db.add(UserSmtpConfig(
        user_id=user_a.id,
        host="smtp.example.test",
        port=465,
        user="mailer@example.test",
        password="secret",
        from_addr="mailer@example.test",
        use_ssl=True,
        enabled=True,
    ))
    await db.commit()

    result = await preferences_api.get_user_smtp(user_a, db)

    assert result.host == "smtp.example.test"
    assert result.user == "mailer@example.test"
    assert result.port == 465
