"""用户 BYOK 凭据管理接口；只返回元数据和掩码状态。"""
from datetime import datetime
import os
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import get_current_user
from app.core.config import get_settings
from app.db.session import get_db
from app.models import User, UserProviderCredential
from app.byok.policy import require_byok_enabled
from app.byok.schemas import CredentialCreate, CredentialModelsPreview, CredentialPatch, CredentialTestPreview, CredentialVisionProbe
from app.byok.service import credential_view, decrypt_value, encrypt_value, list_credentials, master_key_status_for_credentials

router = APIRouter(prefix="/byok", tags=["byok"])


def _gate() -> None:
    try:
        require_byok_enabled()
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc


@router.get("")
async def get_credentials(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    _gate()
    rows = await list_credentials(db, user.id)
    return {"enabled": True, "status": master_key_status_for_credentials(rows), "items": [credential_view(row) for row in rows]}


@router.post("", status_code=201)
async def create_credential(body: CredentialCreate, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    _gate()
    existing = (await db.execute(select(UserProviderCredential).where(
        UserProviderCredential.user_id == user.id,
        UserProviderCredential.capability == body.capability,
        UserProviderCredential.enabled.is_(True),
    ))).scalars().all()
    for item in existing:
        item.enabled = False
    try:
        encrypted, nonce, wrapped = encrypt_value(body.value)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail="BYOK 加密服务未配置，请先设置 CREDENTIALS_MASTER_KEY") from exc
    row = UserProviderCredential(
        user_id=user.id, provider=body.provider, api_format=body.api_format,
        capability=body.capability,
        encrypted_value=encrypted, nonce=nonce, encrypted_data_key=wrapped,
        key_version=int(os.getenv("CREDENTIALS_MASTER_KEY_VERSION", "1")),
        base_url=body.base_url, model=body.model, max_tokens=body.max_tokens,
        context_tokens=body.context_tokens,
        thinking=body.thinking, reasoning_effort=body.reasoning_effort,
        reasoning_persistence=body.reasoning_persistence,
        vision=body.vision,
        vision_video=body.vision_video, vision_audio=body.vision_audio,
        vision_detail=body.vision_detail,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return credential_view(row)


@router.post("/models-preview")
async def preview_models(body: CredentialModelsPreview, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """用当前表单或已保存凭据读取 Provider 模型列表，不保存配置。"""
    _gate()
    api_key = body.api_key
    if not api_key and body.credential_id is not None:
        row = await db.get(UserProviderCredential, body.credential_id)  # ownership-exempt: 下方按当前用户校验凭据归属
        if row is None or row.user_id != user.id:
            raise HTTPException(status_code=404, detail="凭据不存在")
        api_key = decrypt_value(row)
    if not api_key:
        raise HTTPException(status_code=422, detail="请先填写 API Key 或保存后再获取模型列表")
    from app.api.v1.agent_admin import _fetch_provider_models
    try:
        models = await _fetch_provider_models(body.base_url, body.provider, api_key, body.api_format)
    except Exception as exc:
        raise HTTPException(status_code=502, detail="无法获取 Provider 模型列表") from exc
    return {"models": models}


@router.post("/vision-probe")
async def probe_vision(body: CredentialVisionProbe, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """检测用户模型的单项多模态能力，不修改配置。"""
    _gate()
    api_key = body.api_key
    if not api_key and body.credential_id is not None:
        row = await db.get(UserProviderCredential, body.credential_id)  # ownership-exempt: 下方按当前用户校验凭据归属
        if row is None or row.user_id != user.id:
            raise HTTPException(status_code=404, detail="凭据不存在")
        api_key = decrypt_value(row)
    if not api_key:
        raise HTTPException(status_code=422, detail="请先填写 API Key 或保存后再检测")
    from app.api.v1.agent_admin import _do_vision_probe
    try:
        supported, status, detail = await _do_vision_probe(body.provider, api_key, body.base_url.rstrip("/"), body.model, body.api_format, body.dim)
    except Exception as exc:
        # 只写入受限诊断日志；响应仅暴露异常类型，不泄漏 URL、Key 或上游正文。
        from app.core.redaction import diag_log
        diag_log("byok.vision_probe", exc)
        raise HTTPException(status_code=502, detail=f"多模态能力检测失败（{type(exc).__name__}），请检查配置") from exc
    return {"dim": body.dim, "supported": supported, "status": status, "detail": detail}


@router.patch("/{credential_id}")
async def patch_credential(credential_id: int, body: CredentialPatch, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    _gate()
    row = await db.get(UserProviderCredential, credential_id)  # ownership-exempt: 下方按当前用户校验凭据归属
    if row is None or row.user_id != user.id:
        raise HTTPException(status_code=404, detail="凭据不存在")
    if body.enabled is True:
        siblings = (await db.execute(select(UserProviderCredential).where(
            UserProviderCredential.user_id == user.id,
            UserProviderCredential.capability == row.capability,
            UserProviderCredential.id != row.id,
        ))).scalars().all()
        for item in siblings:
            item.enabled = False
    for field in ("provider", "api_format", "base_url", "model", "max_tokens", "context_tokens", "thinking", "reasoning_effort", "reasoning_persistence", "vision", "vision_video", "vision_audio", "vision_detail", "enabled"):
        value = getattr(body, field)
        if value is not None:
            setattr(row, field, value)
    if body.value is not None:
        try:
            row.encrypted_value, row.nonce, row.encrypted_data_key = encrypt_value(body.value)
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail="BYOK 加密服务未配置，请先设置 CREDENTIALS_MASTER_KEY") from exc
        row.key_version = int(os.getenv("CREDENTIALS_MASTER_KEY_VERSION", "1"))
    await db.commit()
    await db.refresh(row)
    return credential_view(row)


@router.delete("/{credential_id}", status_code=204)
async def delete_credential(credential_id: int, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    _gate()
    row = await db.get(UserProviderCredential, credential_id)  # ownership-exempt: 下方按当前用户校验凭据归属
    if row is None or row.user_id != user.id:
        raise HTTPException(status_code=404, detail="凭据不存在")
    await db.delete(row)
    await db.commit()


async def _test_special_capability(provider: str, capability: str, api_key: str) -> dict:
    if capability == "deep_research":
        try:
            from agent.tools.deep_research import run
            result = await run(provider, "测试深度研究连接", api_key, max_results=1, depth="basic")
            if not result.get("answer") and not result.get("results"):
                return {"ok": False, "status": 0, "message": f"{provider} 已连通但没有返回研究结果"}
        except Exception:
            return {"ok": False, "status": 0, "message": f"{provider} 测试失败，请检查 API Key、服务可用性或调用额度"}
        return {"ok": True, "status": 200, "message": f"{provider} 深度研究连接正常（本次测试可能消耗 1 次调用）"}
    if capability == "similar_image_search":
        try:
            import base64
            from agent.tools.search import _call_baidu_similar_image
            # 使用有效的 64×64 PNG，避免 Provider 将 1×1 探针判定为无效图片。
            probe_png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAlklEQVR4nO3QMQ0AMAzAsPLHWC4rDB/L4T/K7O772egArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0A6OSM1jeqEVYAAAAAElFTkSuQmCC")
            result = await _call_baidu_similar_image(probe_png, api_key, 1, get_settings().search.similar_image_timeout_seconds)
        except Exception:
            return {"ok": False, "status": 0, "message": "百度相似图搜索测试失败，请检查 API Key、服务可用性或调用额度"}
        if result.get("error"):
            return {"ok": False, "status": 0, "message": str(result["error"]).replace("请管理员检查", "请检查")}
        return {"ok": True, "status": 200, "message": "百度千帆相似图搜索连接正常（本次测试可能消耗 1 次调用）"}
    return {"ok": False, "status": 0, "message": "未知测试目标"}


@router.post("/test-preview")
async def test_credential_preview(body: CredentialTestPreview, user: User = Depends(get_current_user)):
    _gate()
    if body.provider == "__server_default__":
        return {"ok": False, "status": 0, "message": "服务器默认配置不支持用户侧测试"}
    if not body.value:
        return {"ok": False, "status": 0, "message": "请输入 API Key 后再测试"}
    return await _test_special_capability(body.provider, body.capability, body.value)


@router.post("/{credential_id}/test")
async def test_credential(credential_id: int, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """校验凭据，并对模型类配置执行一次无副作用的连通性请求。"""
    _gate()
    row = await db.get(UserProviderCredential, credential_id)  # ownership-exempt: 下方按当前用户校验凭据归属
    if row is None or row.user_id != user.id:
        raise HTTPException(status_code=404, detail="凭据不存在")
    try:
        api_key = decrypt_value(row)
    except Exception as exc:
        raise HTTPException(status_code=422, detail="凭据无法解密，请重新保存") from exc
    if row.capability in ("deep_research", "similar_image_search"):
        return await _test_special_capability(row.provider, row.capability, api_key)
    if row.capability in ("llm", "speech_to_text"):
        from app.services.provider_diagnostics import test_provider_credential
        result = await test_provider_credential(provider=row.provider, api_key=api_key,
                                                 base_url=row.base_url, model=row.model,
                                                 api_format=row.api_format)
        return {"ok": result["ok"], "status": result["status"],
                "message": "模型连接正常" if result["ok"] else (
                    f"模型连接失败（HTTP {result['status']}）" if result["status"] else result["detail"])}
    return {"ok": True, "status": "stored", "message": "凭据已保存且可正常解密"}
