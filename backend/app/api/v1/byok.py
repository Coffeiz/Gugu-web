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


def _embedding_allows_empty_key(capability: str, provider: str, base_url: str) -> bool:
    """自托管无鉴权服务允许空 API Key（与前端 keyRequiredFor 同一口径）：
    仅限 Embedding 的本地推理（local / 非云端的 Ollama）；Ollama Cloud 与其余
    provider 的空 Key 一律拒绝。"""
    if capability != "embedding":
        return False
    if provider == "local":
        return True
    return provider == "ollama" and "ollama.com" not in (base_url or "")


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
        encrypted, nonce, wrapped = encrypt_value(
            body.value,
            allow_empty=_embedding_allows_empty_key(body.capability, body.provider, body.base_url))
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail="BYOK 加密服务未配置，请先设置 CREDENTIALS_MASTER_KEY") from exc
    except ValueError as exc:
        # 不允许空 Key 的 provider 传了空值：业务校验失败，返回 422 而不是裸 500。
        raise HTTPException(status_code=422, detail="该 Provider 需要 API Key，不能为空") from exc
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
        dimensions=body.dimensions,
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
    for field in ("provider", "api_format", "base_url", "model", "dimensions", "max_tokens", "context_tokens", "thinking", "reasoning_effort", "reasoning_persistence", "vision", "vision_video", "vision_audio", "vision_detail", "enabled"):
        value = getattr(body, field)
        if value is not None:
            setattr(row, field, value)
    # allow_empty / 一致性校验都基于保存后的最终配置：切换 provider/base_url 时，
    # 旧 Key 是否允许为空、新 Provider 是否必须补 Key，都要看目标状态而不是请求前状态。
    final_allows_empty = _embedding_allows_empty_key(row.capability, row.provider, row.base_url)
    if body.value is not None:
        try:
            encrypted, nonce, wrapped = encrypt_value(body.value, allow_empty=final_allows_empty)
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail="BYOK 加密服务未配置，请先设置 CREDENTIALS_MASTER_KEY") from exc
        except ValueError as exc:
            raise HTTPException(status_code=422, detail="该 Provider 需要 API Key，不能为空") from exc
        row.encrypted_value, row.nonce, row.encrypted_data_key = encrypted, nonce, wrapped
        row.key_version = int(os.getenv("CREDENTIALS_MASTER_KEY_VERSION", "1"))
    elif not final_allows_empty:
        # 反向一致性：切到需要 Key 的 Provider 但未提供新 Key 时，存量空 Key 会让
        # 保存出一个必然运行失败的配置（如 OpenAI + 空 Key），直接拒绝。
        try:
            stored_empty = decrypt_value(row) == ""
        except Exception:
            stored_empty = False
        if stored_empty:
            raise HTTPException(status_code=422, detail="该 Provider 需要 API Key，请填写后保存")
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


async def _test_embedding_credential(*, api_key: str, base_url: str, model: str,
                                     dimensions: int | None = None) -> dict:
    """向 OpenAI 兼容 /embeddings 发一次最小试呼；HTTP 200 且返回向量才算通过。

    只支持文本 embedding；百炼多模态专用端点不做用户侧探测（PRD-SEC-2）。
    错误摘要经 redact()，不回显凭据或完整上游响应。
    """
    import httpx
    from app.core.credentials import normalize_ascii_api_key
    from app.core.redaction import redact
    url = (base_url or "").rstrip("/") + "/embeddings"
    payload: dict = {"model": model or "", "input": "ping"}
    if dimensions:
        payload["dimensions"] = dimensions
    headers = ({"Authorization": f"Bearer {normalize_ascii_api_key(api_key, label='Embedding API Key')}"}
               if api_key else {})
    try:
        async with httpx.AsyncClient(timeout=10.0, follow_redirects=False) as client:
            response = await client.post(url, headers=headers, json=payload)
    except Exception:
        return {"ok": False, "status": 0, "message": "无法连接 Embedding 服务，请检查 Base URL 与网络"}
    if response.status_code != 200:
        detail = redact((response.text or "").strip()[:200])
        return {"ok": False, "status": response.status_code,
                "message": f"Embedding 测试失败（HTTP {response.status_code}）{('：' + detail) if detail else ''}"}
    try:
        vec = (response.json().get("data") or [{}])[0].get("embedding")
    except Exception:
        vec = None
    if not isinstance(vec, list) or not vec:
        return {"ok": False, "status": 200, "message": "Embedding 服务已连通，但返回格式异常（无向量数据）"}
    return {"ok": True, "status": 200, "message": "Embedding 连接正常"}


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
async def test_credential_preview(body: CredentialTestPreview, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """按表单草稿试呼（不落库）：编辑已保存配置时可不保存直接测试预填内容。"""
    _gate()
    if body.provider == "__server_default__":
        return {"ok": False, "status": 0, "message": "服务器默认配置不支持用户侧测试"}
    # Key 缺省时回源已存凭据：用户往往只改 base_url/model 不重填 Key。
    api_key = body.value
    if not api_key:
        if body.credential_id is None:
            return {"ok": False, "status": 0, "message": "请输入 API Key 后再测试"}
        row = await db.get(UserProviderCredential, body.credential_id)  # ownership-exempt: 下方按当前用户校验凭据归属
        if row is None or row.user_id != user.id:
            raise HTTPException(status_code=404, detail="凭据不存在")
        try:
            api_key = decrypt_value(row)
        except Exception as exc:
            raise HTTPException(status_code=422, detail="凭据无法解密，请重新保存") from exc
    if body.capability == "embedding":
        if not body.base_url or not body.model:
            return {"ok": False, "status": 0, "message": "Embedding 测试需要填写 Base URL 和模型名"}
        return await _test_embedding_credential(api_key=api_key, base_url=body.base_url,
                                                model=body.model, dimensions=body.dimensions)
    if body.capability in ("llm", "speech_to_text"):
        from app.services.provider_diagnostics import test_provider_credential
        result = await test_provider_credential(provider=body.provider, api_key=api_key,
                                                 base_url=body.base_url, model=body.model,
                                                 api_format=body.api_format)
        return {"ok": result["ok"], "status": result["status"],
                "message": "模型连接正常" if result["ok"] else (
                    f"模型连接失败（HTTP {result['status']}）" if result["status"] else result["detail"])}
    return await _test_special_capability(body.provider, body.capability, api_key)


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
    if row.capability == "embedding":
        if not row.base_url or not row.model:
            return {"ok": False, "status": 0, "message": "请先填写 Base URL 和模型名再测试"}
        return await _test_embedding_credential(api_key=api_key, base_url=row.base_url,
                                                model=row.model, dimensions=row.dimensions)
    if row.capability in ("llm", "speech_to_text"):
        from app.services.provider_diagnostics import test_provider_credential
        result = await test_provider_credential(provider=row.provider, api_key=api_key,
                                                 base_url=row.base_url, model=row.model,
                                                 api_format=row.api_format)
        return {"ok": result["ok"], "status": result["status"],
                "message": "模型连接正常" if result["ok"] else (
                    f"模型连接失败（HTTP {result['status']}）" if result["status"] else result["detail"])}
    return {"ok": True, "status": "stored", "message": "凭据已保存且可正常解密"}


# ── 用户侧 Embedding 向量重建：只重建当前用户自己的向量（PRD-SEC-2）──────────────
_USER_REBUILD_KEY = "emb:rebuild:user:{user_id}"


async def _rebuild_my_vectors_worker(user_id: str, cfg: dict) -> None:
    """单用户后台重建：pattern + memory 向量 + RAG Memory 索引，全程绑定用户自己的 embedding 配置。"""
    import asyncio
    import json
    import time
    from uuid import UUID

    from agent.memory import store
    from app.byok.service import bind_user_embedding
    from app.core.redis import get_redis

    r = get_redis()
    key = _USER_REBUILD_KEY.format(user_id=user_id)
    try:
        res = await store.rebuild_all_vecs([user_id], bind_cfgs={user_id: cfg})
        rag_failed = False
        try:
            from agent.rag.pipeline import rebuild_memory_index
            with bind_user_embedding(cfg):
                await rebuild_memory_index(str(UUID(user_id)), operation="embedding-rebuild")
        except Exception:
            rag_failed = True
        failed = int(res.get("failed_users") or 0)
        status = "error" if failed or rag_failed else "done"
        message = (
            f"重建完成：pattern {res.get('pattern_vectors', 0)} 条，"
            f"memory {res.get('memory_vectors', 0)} 块"
            + ("；RAG 索引失败" if rag_failed else "")
        )
        await r.set(key, json.dumps(
            {"status": status, **res, "message": message, "ts": time.time()}), ex=3600)
    except Exception as e:
        await r.set(key, json.dumps(
            {"status": "error", "message": str(e)[:100], "ts": time.time()}), ex=3600)


@router.post("/embedding-rebuild")
async def rebuild_my_vectors(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """用当前用户生效的 embedding 凭据重建自己的向量。后台运行并立即返回；
    进度通过 GET /embedding-rebuild/status 轮询。仅在有可用凭据时允许。"""
    import asyncio
    import json
    import time

    from app.byok.service import resolve_embedding_settings
    from app.core.redis import get_redis

    _gate()
    try:
        cfg = await resolve_embedding_settings(db, user.id, get_settings().embedding)
    except Exception:
        cfg = None
    if cfg is None:
        return {"ok": False, "message": "请先配置并启用 Embedding 凭据再重建"}
    r = get_redis()
    key = _USER_REBUILD_KEY.format(user_id=user.id)
    cur = await r.get(key)
    if cur:
        try:
            d = json.loads(cur if isinstance(cur, str) else cur.decode())
            if d.get("status") == "running":
                return {"ok": False, "message": "已有重建任务在跑", "status": d}
        except Exception:
            pass
    await r.set(key, json.dumps({"status": "running", "ts": time.time()}), ex=3600)
    asyncio.create_task(_rebuild_my_vectors_worker(str(user.id), cfg))
    return {"ok": True, "message": "重建已启动"}


@router.get("/embedding-rebuild/status")
async def rebuild_my_vectors_status(user: User = Depends(get_current_user)):
    import json

    from app.core.redis import get_redis

    cur = await get_redis().get(_USER_REBUILD_KEY.format(user_id=user.id))
    if not cur:
        return {"status": "idle"}
    try:
        return json.loads(cur if isinstance(cur, str) else cur.decode())
    except Exception:
        return {"status": "idle"}
