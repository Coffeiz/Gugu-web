from sqlalchemy import select
import pytest

from app.models import EmailChangeRequest
from app.services.email.email_change import (
    create_email_change_request,
    hash_email_change_token,
    normalize_email,
)


def test_normalize_email_rejects_display_names_and_invalid_addresses():
    assert normalize_email("  User@Example.com ") == "user@example.com"

    with pytest.raises(ValueError):
        normalize_email("用户 <user@example.com>")
    with pytest.raises(ValueError):
        normalize_email("invalid")


@pytest.mark.asyncio
async def test_email_change_request_does_not_modify_user_and_replaces_old_request(db, user_a):
    old_email = user_a.email
    first, first_token = await create_email_change_request(db, user_a, "first@example.com")
    await db.commit()

    second, second_token = await create_email_change_request(db, user_a, "second@example.com")
    await db.commit()
    await db.refresh(user_a)

    rows = (await db.execute(select(EmailChangeRequest).where(EmailChangeRequest.user_id == user_a.id))).scalars().all()
    assert user_a.email == old_email
    assert first.revoked_at is not None
    assert second.revoked_at is None
    assert first_token != second_token
    assert first.token_hash == hash_email_change_token(first_token)
    assert second.token_hash == hash_email_change_token(second_token)
    assert first_token not in first.token_hash
    assert second_token not in second.token_hash
    assert len(rows) == 2
