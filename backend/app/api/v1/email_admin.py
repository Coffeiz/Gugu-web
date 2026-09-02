"""管理员邮件编辑、预览、测试与发布接口。"""
from __future__ import annotations

import asyncio
import logging
import re
from typing import Literal

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel, Field, field_validator
from starlette.concurrency import run_in_threadpool

from app.core.config import get_settings
from app.db.session import get_db
from app.models import User
from app.services.email import render_email, send_email_with_status

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/admin/email", tags=["admin-email"])

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
TemplateName = Literal["notification", "reminder", "report", "security", "test"]
ThemeName = Literal["light", "dark"]
PaletteName = Literal["mist", "cafe", "rose", "sky", "sage"]


class EmailSection(BaseModel):
    heading: str = Field(default="", max_length=120)
    text: str = Field(min_length=1, max_length=5000)


class EmailAction(BaseModel):
    label: str = Field(min_length=1, max_length=80)
    url: str = Field(min_length=1, max_length=2048)


class EmailDraft(BaseModel):
    template: TemplateName = "notification"
    theme: ThemeName = "light"
    palette: PaletteName = "mist"
    subject: str = Field(min_length=1, max_length=200)
    title: str = Field(min_length=1, max_length=200)
    preheader: str = Field(default="", max_length=180)
    body: str = Field(min_length=1, max_length=20000)
    sections: list[EmailSection] = Field(default_factory=list, max_length=8)
    actions: list[EmailAction] = Field(default_factory=list, max_length=3)

    @field_validator("subject", "title", "preheader", "body")
    @classmethod
    def trim_text(cls, value: str) -> str:
        return value.strip()


class EmailTestRequest(EmailDraft):
    recipient: str = Field(min_length=3, max_length=300)

    @field_validator("recipient")
    @classmethod
    def validate_recipient(cls, value: str) -> str:
        value = value.strip()
        if not _EMAIL_RE.fullmatch(value):
            raise ValueError("测试收件人邮箱格式无效")
        return value


class EmailPublishRequest(EmailDraft):
    confirm: bool = False


def _draft_kwargs(draft: EmailDraft) -> dict:
    return draft.model_dump(exclude={"recipient", "confirm"}, exclude_none=True)


async def _active_recipient_emails(db: AsyncSession) -> list[str]:
    rows = await db.scalars(
        select(User.email).where(User.is_active.is_(True), User.account_status == "active")
    )
    return [email.strip() for email in rows.all() if email and _EMAIL_RE.fullmatch(email.strip())]


async def _deliver_bulk(recipients: list[str], draft: EmailDraft) -> None:
    """后台逐封发送，避免把 SMTP 阻塞时间占在管理员 HTTP 请求上。"""
    settings = get_settings().smtp
    semaphore = asyncio.Semaphore(8)

    async def deliver(recipient: str) -> dict:
        async with semaphore:
            return await run_in_threadpool(
                send_email_with_status,
                draft.subject,
                draft.body,
                to_addr=recipient,
                smtp_config=settings,
                template=draft.template,
                title=draft.title,
                preheader=draft.preheader,
                sections=[item.model_dump() for item in draft.sections],
                actions=[item.model_dump() for item in draft.actions],
                theme=draft.theme,
                palette=draft.palette,
            )

    results = await asyncio.gather(*(deliver(email) for email in recipients), return_exceptions=True)
    sent = sum(isinstance(result, dict) and result.get("status") == "sent" for result in results)
    failed = len(results) - sent
    logger.info("管理员邮件发布完成: recipients=%d sent=%d failed=%d", len(recipients), sent, failed)


@router.post("/preview")
async def preview_email(draft: EmailDraft):
    try:
        content = render_email(**_draft_kwargs(draft))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"html": content.html, "plain": content.plain}


@router.get("/recipient-count")
async def recipient_count(db: AsyncSession = Depends(get_db)):
    count = await db.scalar(
        select(func.count(User.id)).where(User.is_active.is_(True), User.account_status == "active")
    )
    return {"count": int(count or 0)}


@router.post("/test")
async def test_email(request: EmailTestRequest):
    result = await run_in_threadpool(
        send_email_with_status,
        request.subject,
        request.body,
        to_addr=request.recipient,
        smtp_config=get_settings().smtp,
        template=request.template,
        title=request.title,
        preheader=request.preheader,
        sections=[item.model_dump() for item in request.sections],
        actions=[item.model_dump() for item in request.actions],
        theme=request.theme,
        palette=request.palette,
    )
    return {"ok": result.get("status") == "sent", **result}


@router.post("/publish")
async def publish_email(
    request: EmailPublishRequest,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
):
    if not request.confirm:
        raise HTTPException(status_code=400, detail="正式发布必须显式确认")
    recipients = await _active_recipient_emails(db)
    if not recipients:
        raise HTTPException(status_code=400, detail="没有可发送的有效注册邮箱")
    background_tasks.add_task(_deliver_bulk, recipients, request)
    return {"ok": True, "status": "queued", "recipient_count": len(recipients)}
