"""管理员邮件编辑、预览、测试与发布接口。"""
from __future__ import annotations

import asyncio
import json
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
from app.models import User, UserPreferences
from app.services.email import render_email, send_email_with_status

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/admin/email", tags=["admin-email"])

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
TemplateName = Literal["notification", "reminder", "report", "security", "test"]
ThemeName = Literal["light", "dark"]
PaletteName = Literal["mist", "cafe", "rose", "sky", "sage"]
LocaleName = Literal["zh-CN", "ja-JP", "en-US"]


class EmailSection(BaseModel):
    heading: str = Field(default="", max_length=120)
    text: str = Field(min_length=1, max_length=5000)


class EmailAction(BaseModel):
    label: str = Field(min_length=1, max_length=80)
    url: str = Field(min_length=1, max_length=2048)


class LocalizedEmailContent(BaseModel):
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


class EmailDraft(LocalizedEmailContent):
    template: TemplateName = "notification"
    theme: ThemeName = "light"
    palette: PaletteName = "mist"
    translations: dict[LocaleName, LocalizedEmailContent] = Field(default_factory=dict)

    @field_validator("translations")
    @classmethod
    def validate_translation_count(cls, value: dict) -> dict:
        if len(value) > 3:
            raise ValueError("最多支持三种邮件语言")
        return value


class EmailTestRequest(EmailDraft):
    recipient: str = Field(min_length=3, max_length=300)
    test_locale: LocaleName = "zh-CN"

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
    return draft.model_dump(exclude={"recipient", "confirm", "translations", "test_locale"}, exclude_none=True)


def _localized_kwargs(content: LocalizedEmailContent) -> dict:
    return content.model_dump(exclude_none=True)


def _content_for_locale(draft: EmailDraft, locale: str) -> LocalizedEmailContent:
    if locale == "zh-CN":
        return LocalizedEmailContent.model_validate(_draft_kwargs(draft))
    return draft.translations.get(locale) or LocalizedEmailContent.model_validate(_draft_kwargs(draft))


async def _active_recipient_emails(db: AsyncSession) -> dict[str, list[str]]:
    rows = (await db.execute(
        select(User.email, UserPreferences.data_json)
        .outerjoin(UserPreferences, UserPreferences.user_id == User.id)
        .where(User.is_active.is_(True), User.account_status == "active", User.email_subscribed.is_(True))
    )).all()
    grouped: dict[str, list[str]] = {"zh-CN": [], "ja-JP": [], "en-US": []}
    for email, data_json in rows:
        value = (email or "").strip()
        if not _EMAIL_RE.fullmatch(value):
            continue
        try:
            locale = json.loads(data_json or "{}").get("locale")
        except (TypeError, ValueError, AttributeError):
            locale = None
        grouped[locale if locale in grouped else "zh-CN"].append(value)
    return grouped


async def _deliver_bulk(recipients: dict[str, list[str]], draft: EmailDraft) -> None:
    """后台逐封发送，避免把 SMTP 阻塞时间占在管理员 HTTP 请求上。"""
    settings = get_settings().smtp
    semaphore = asyncio.Semaphore(8)

    async def deliver(recipient: str, locale: str) -> dict:
        content = _content_for_locale(draft, locale)
        async with semaphore:
            return await run_in_threadpool(
                send_email_with_status,
                content.subject,
                content.body,
                to_addr=recipient,
                smtp_config=settings,
                template=draft.template,
                title=content.title,
                preheader=content.preheader,
                sections=[item.model_dump() for item in content.sections],
                actions=[item.model_dump() for item in content.actions],
                theme=draft.theme,
                palette=draft.palette,
            )

    results = await asyncio.gather(*(deliver(email, locale) for locale, emails in recipients.items() for email in emails), return_exceptions=True)
    sent = sum(isinstance(result, dict) and result.get("status") == "sent" for result in results)
    failed = len(results) - sent
    logger.info("管理员邮件发布完成: recipients=%d sent=%d failed=%d locales=%s", len(results), sent, failed, {key: len(value) for key, value in recipients.items()})


@router.post("/preview")
async def preview_email(draft: EmailDraft):
    try:
        content = render_email(**_draft_kwargs(draft))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"html": content.html, "plain": content.plain}


@router.get("/recipient-count")
async def recipient_count(db: AsyncSession = Depends(get_db)):
    grouped = await _active_recipient_emails(db)
    return {"count": sum(map(len, grouped.values())), "locale_counts": {key: len(value) for key, value in grouped.items()}}


async def _translate_with_model(draft: EmailDraft, target_locales: list[LocaleName]) -> dict[str, LocalizedEmailContent]:
    from agent import providers
    from agent.llm.llm_select import use_anthropic_for
    import httpx

    settings = get_settings()
    ai = settings.ai
    source = json.dumps(_draft_kwargs(draft), ensure_ascii=False)
    prompt = (
        "你是专业邮件本地化编辑。请把下面这封邮件翻译成指定语言，并只返回一个 JSON 对象。"
        "不要输出 Markdown 代码围栏、解释或 HTML；保留 sections/actions 数量和 action.url，"
        "只翻译 subject/title/preheader/body/sections.heading/sections.text/actions.label。"
        f"目标语言代码：{', '.join(target_locales)}。JSON 顶层键必须是语言代码，每个值必须包含 "
        "subject,title,preheader,body,sections,actions。原邮件：\n{source}"
    )
    adapter = providers.adapter_for(ai)
    timeout = httpx.Timeout(30.0)
    if use_anthropic_for(ai):
        client = providers.build_anthropic_client(ai, timeout)
        response = await client.messages.create(model=ai.model, max_tokens=5000,
            messages=[{"role": "user", "content": prompt}], **adapter.build_anthropic_thinking_params(ai))
        raw = "".join(getattr(block, "text", "") for block in response.content if getattr(block, "type", "") == "text")
    else:
        client = providers.build_openai_client(ai, timeout)
        response = await client.chat.completions.create(model=ai.model, max_tokens=5000,
            messages=[{"role": "user", "content": prompt}], **adapter.build_openai_thinking_kwargs(ai))
        raw = response.choices[0].message.content or ""
    raw = re.sub(r"^\s*```(?:json)?\s*|\s*```\s*$", "", raw.strip(), flags=re.IGNORECASE)
    parsed = json.loads(raw)
    return {locale: LocalizedEmailContent.model_validate(parsed[locale]) for locale in target_locales}


@router.post("/translate")
async def translate_email(draft: EmailDraft):
    targets = [locale for locale in ("ja-JP", "en-US") if locale not in draft.translations]
    if not targets:
        return {"translations": {key: value.model_dump() for key, value in draft.translations.items()}}
    try:
        translations = await _translate_with_model(draft, targets)
    except Exception as exc:
        logger.warning("管理员邮件多语言生成失败: %s", type(exc).__name__)
        raise HTTPException(status_code=502, detail="多语言邮件生成失败，请检查当前模型配置") from exc
    return {"translations": {key: value.model_dump() for key, value in translations.items()}}


@router.post("/test")
async def test_email(request: EmailTestRequest):
    result = await run_in_threadpool(
        send_email_with_status,
        _content_for_locale(request, request.test_locale).subject,
        _content_for_locale(request, request.test_locale).body,
        to_addr=request.recipient,
        smtp_config=get_settings().smtp,
        template=request.template,
        title=_content_for_locale(request, request.test_locale).title,
        preheader=_content_for_locale(request, request.test_locale).preheader,
        sections=[item.model_dump() for item in _content_for_locale(request, request.test_locale).sections],
        actions=[item.model_dump() for item in _content_for_locale(request, request.test_locale).actions],
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
    if not any(recipients.values()):
        raise HTTPException(status_code=400, detail="没有可发送的有效注册邮箱")
    background_tasks.add_task(_deliver_bulk, recipients, request)
    return {"ok": True, "status": "queued", "recipient_count": sum(map(len, recipients.values())), "locale_counts": {key: len(value) for key, value in recipients.items()}}
