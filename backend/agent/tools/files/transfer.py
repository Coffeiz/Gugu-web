"""文件传输工具：附件、网络图片和受控 Shell 路径发送。"""

from __future__ import annotations

import json
import mimetypes
from pathlib import Path, PurePosixPath

from app.core.redaction import redact
from agent.tools.filesystem_policy import current_filesystem_policy


async def _resolve_file(db, user_id, args):
    """延迟调用文件库解析器，避免 files.py 与本模块循环导入。"""
    from agent.tools.files import _resolve_file as resolve_file
    return await resolve_file(db, user_id, args)


# send_file 允许读取的逻辑沙盒根。这里刻意不接受宿主机绝对路径，避免模型
# 把执行器日志里的本机路径当成可发送路径，越过用户沙箱边界。
_SEND_PATH_ROOTS = frozenset({"personal", "project", "workspace"})
_SEND_PATH_MAX_BYTES = 10 * 1024 * 1024

def _normalize_send_path(value: str) -> tuple[str | None, PurePosixPath | None, str | None]:
    """解析 send_file 的逻辑路径，不把它解释成宿主机路径。"""
    text = str(value or "").strip()
    # Shell 提示符可能带上 sandbox 名称，允许去掉这一层展示前缀。
    if text.startswith("gugu-sandbox:"):
        text = text[len("gugu-sandbox:"):]
    if not text.startswith("/"):
        return None, None, None
    if "\\" in text or "\x00" in text:
        return None, None, "路径格式不受支持，只能使用 /workspace、/personal 或 /project 下的路径"
    path = PurePosixPath(text)
    parts = path.parts
    if len(parts) < 3 or parts[0] != "/" or parts[1] not in _SEND_PATH_ROOTS:
        return None, None, "只允许发送 /workspace、/personal 或 /project 下的文件"
    relative = PurePosixPath(*parts[2:])
    if any(part in {"", ".", ".."} for part in relative.parts):
        return None, None, "路径不能包含 . 或 .."
    return parts[1], relative, None


async def _stage_send_path(db, user_id, value: str):
    """把受控 Shell 逻辑路径转换成 send_file 可复用的附件 artifact。

    返回 ``None`` 表示 ``value`` 不是绝对逻辑路径，交给旧的文件库名称解析；
    返回 JSON 字符串表示路径错误；成功时返回 artifact。
    """
    root_name, relative, path_error = _normalize_send_path(value)
    if root_name is None:
        return json.dumps({"error": path_error}, ensure_ascii=False) if path_error else None

    policy = await current_filesystem_policy(db, user_id)
    if policy is None:
        return json.dumps({"error": "当前会话没有可用的沙盒文件路径上下文"}, ensure_ascii=False)
    if root_name in {"personal", "project"} and not policy.full_user_sandbox:
        return json.dumps({"error": f"发送 /{root_name} 文件前需要完整用户沙箱授权"}, ensure_ascii=False)

    from app.services.workspaces import (
        resolve_project_root,
        resolve_shell_root,
        resolve_user_personal_root,
    )
    if root_name == "workspace":
        root = await resolve_shell_root(db, user_id, "sandbox", policy.workspace_id)
    elif root_name == "personal":
        root = await resolve_user_personal_root(db, user_id)
    else:
        root = await resolve_project_root(db, user_id)
    if root is None:
        return json.dumps({"error": f"/{root_name} 当前不支持本地文件发送"}, ensure_ascii=False)

    root = Path(root).resolve()
    candidate = root.joinpath(*relative.parts)
    try:
        # 逐级拒绝 symlink，防止沙盒内的链接把路径带出逻辑根。
        current = root
        for part in relative.parts:
            current = current / part
            if current.is_symlink():
                return json.dumps({"error": "不能发送符号链接文件"}, ensure_ascii=False)
        resolved = candidate.resolve(strict=True)
        resolved.relative_to(root)
    except (FileNotFoundError, RuntimeError):
        return json.dumps({"error": f"未找到文件「/{root_name}/{relative.as_posix()}」"}, ensure_ascii=False)
    except ValueError:
        return json.dumps({"error": "文件路径超出当前沙盒根目录"}, ensure_ascii=False)
    if not resolved.is_file():
        return json.dumps({"error": "只能发送文件，不能发送目录"}, ensure_ascii=False)

    try:
        size = resolved.stat().st_size
    except OSError:
        return json.dumps({"error": "无法读取文件信息"}, ensure_ascii=False)
    if size > _SEND_PATH_MAX_BYTES:
        return json.dumps({"error": f"文件过大（超过 {_SEND_PATH_MAX_BYTES // 1048576}MB 上限）"}, ensure_ascii=False)
    try:
        data = resolved.read_bytes()
    except OSError:
        return json.dumps({"error": "无法读取文件内容"}, ensure_ascii=False)

    from app.core import chat_attach
    ext = resolved.suffix.lstrip(".").lower()[:10]
    name = resolved.stem or resolved.name
    if ext in chat_attach.IMAGE_EXTS:
        kind = "image"
    elif ext in chat_attach.TEXT_EXTS:
        kind = "text"
    else:
        kind = "binary"
    mime = mimetypes.guess_type(resolved.name)[0] or "application/octet-stream"
    meta = await chat_attach.stage(user_id, name, ext, mime, data, kind=kind)
    return {
        "attach_id": meta["attach_id"],
        "name": name,
        "ext": ext,
        "size_bytes": len(data),
        "kind": meta.get("kind", kind),
        "img_width": meta.get("img_width"),
        "img_height": meta.get("img_height"),
    }
_SEND_URL_MAX_BYTES = 15 * 1024 * 1024   # 下载体积上限
_SEND_URL_IMAGE_EXT = {
    "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/gif": "gif",
    "image/webp": "webp", "image/bmp": "bmp",
}


def _url_is_safe(url: str) -> str | None:
    from app.core.url_security import url_is_safe

    return url_is_safe(url)


def _build_pinned_request(client, method: str, url: str):
    """校验 host 并把连接 pin 到校验时解析到的那个 IP，返回 (request, error)。

    单纯"校验一次、httpx 连接时再 resolve 一次"堵不住 DNS rebinding（攻击者控制的域名
    可以在两次解析之间把 A 记录从公网 IP 换成内网 IP，见 url_security.resolve_pinned_ip
    文档）。这里改成用解析到的 IP 直接建连，Host 头 / TLS SNI 仍用原始域名，保证证书
    校验和路由都不受影响，只是"连去哪"这件事不再交给 httpx 自己二次决定。
    """
    from urllib.parse import urlparse

    from app.core.url_security import resolve_pinned_ip

    ip, error = resolve_pinned_ip(url)
    if error:
        return None, error
    parsed = urlparse(url)
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    netloc = f"[{ip}]:{port}" if ":" in ip else f"{ip}:{port}"
    pinned_url = parsed._replace(netloc=netloc).geturl()
    extensions = {"sni_hostname": parsed.hostname} if parsed.scheme == "https" else {}
    # Host 头：字面 IPv6 地址在 URI authority/HTTP Host 里必须带方括号（如
    # "[2606:4700:4700::1111]"），否则冒号会被误当成端口分隔符——parsed.hostname
    # 对这种 URL 返回的是不带括号的裸地址，直接拼进 Host 头格式不合法（code review
    # 发现）。普通域名不含冒号，加不加这个判断都不受影响。
    host = f"[{parsed.hostname}]" if ":" in (parsed.hostname or "") else parsed.hostname
    # 非默认端口（如 :8443）省略端口会让部分虚拟主机/CDN 按错误的站点路由（同样是
    # code review 发现）；有 parsed.port 时原样带上，用默认端口时留纯 host。
    host_header = f"{host}:{parsed.port}" if parsed.port else host
    req = client.build_request(method, pinned_url, headers={"Host": host_header}, extensions=extensions)
    return req, None


def _fmt_age(ttl_left: int, total_ttl: int) -> str:
    """按剩余 TTL 反推大致存了多久（暂存无绝对时间戳，只能这样估）。"""
    if ttl_left is None or ttl_left < 0:
        return "未知"
    elapsed = max(0, total_ttl - ttl_left)
    if elapsed < 3600:
        return f"约{max(1, elapsed // 60)}分钟前"
    if elapsed < 86400:
        return f"约{elapsed // 3600}小时前"
    return f"约{elapsed // 86400}天前"


async def _list_recent_attachments(db, user_id, args: dict):
    """列出该用户当前暂存区（未过期）的附件，供模型在「刚刚的图/那张图」等模糊指代时反查 attach_id。"""
    from app.core import chat_attach
    staged = await chat_attach.list_staged(user_id)
    if not staged:
        return {"count": 0, "items": [], "note": "暂存区当前没有未过期的附件"}
    items = [{
        "attach_id": m["attach_id"], "name": m.get("name"), "ext": m.get("ext"),
        "kind": m.get("kind"), "platform": m.get("platform"),
        "size_bytes": m.get("size"), "img_width": m.get("img_width"), "img_height": m.get("img_height"),
        "staged_about": _fmt_age(m.get("_ttl"), chat_attach.TTL),
    } for m in staged]
    return {"count": len(items), "items": items}


async def _send_file_from_url(user_id, url: str, title: str, *, stage: bool = True):
    """下载一张网络图片（如 image_search 结果的 img_src）暂存为聊天附件，返回 _artifact（attach_id 版）。

    下载用 streaming + 累计限流：不把整个响应读进内存再判大小（否则群成员给一个
    Content-Length 2GB 的 URL 会先把 2GB 全读进 RAM 才触发 15MB 检查，是 DoS 面）。
    有 Content-Length 提前拒绝；chunked/无 Content-Length 在读取过程中累计，超限立即中止。

    生命周期：**最终 response 的完整消费（含 aiter_bytes）必须留在 AsyncClient 的
    async with 块内**——真实 httpx 的 transport 随 client 关闭，若在 __aexit__ 之后
    才读 body，连接已关会抛 ReadError。原则：创建 client → 获取 streaming response →
    完整消费/主动中止 → close response → 最后才 close client。
    """
    import httpx
    from urllib.parse import urljoin
    try:
        # 手动跟随重定向 + 逐跳重新校验：自动 follow 会让公网页 302 跳内网/云元数据绕过校验（SSRF）。
        # stream=True 只读响应头不读 body，避免 redirect 探测阶段就把大 body 读进内存。
        # 每一跳都用 _build_pinned_request 把"校验的地址"和"实际连接的地址"锁定成同一个 IP，
        # 防 DNS rebinding（见该函数文档）。
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(connect=5.0, read=20.0, write=10.0, pool=5.0),
            follow_redirects=False,
            # 禁用连接池 keep-alive：pin 到 IP 后，重定向多跳可能解析到同一个 IP（CDN
            # 场景很常见），httpcore 按 origin（这里全是同一个 IP:port）复用连接池——
            # 但 sni_hostname 只在新建 TLS 连接时生效，复用已有连接不会重新握手，会
            # 出现"握手时验证了 A 的证书，之后却拿这条连接发 Host: B 的请求"这种
            # TLS hostname 隔离缺口（code review 发现）。这个下载器最多才 4 跳，
            # 完全没必要为了 keep-alive 收益承担这个风险，禁掉最简单也最彻底。
            limits=httpx.Limits(max_keepalive_connections=0),
        ) as client:
            cur = url
            req, reason = _build_pinned_request(client, "GET", cur)
            if reason:
                return json.dumps({"error": f"这个链接发不了：{reason}"}, ensure_ascii=False)
            resp = await client.send(req, stream=True)
            for _ in range(3):   # 最多跟 3 跳
                if resp.status_code not in (301, 302, 303, 307, 308):
                    break
                loc = resp.headers.get("location")
                await resp.aclose()   # 关闭 3xx 响应连接，再发下一跳
                if not loc:
                    break
                cur = urljoin(cur, loc)
                req, reason = _build_pinned_request(client, "GET", cur)   # 每一跳的目标都重新解析+校验+pin
                if reason:
                    return json.dumps({"error": f"这个链接发不了：{reason}"}, ensure_ascii=False)
                resp = await client.send(req, stream=True)

            # 最终 response 的完整消费留在 client 生命周期内（见 docstring）。
            if resp.status_code != 200:
                await resp.aclose()
                return json.dumps({"error": f"图片下载失败（HTTP {resp.status_code}）"}, ensure_ascii=False)

            ctype = (resp.headers.get("content-type") or "").split(";")[0].strip().lower()
            ext = _SEND_URL_IMAGE_EXT.get(ctype)
            if not ext:
                await resp.aclose()
                return json.dumps({"error": f"这个链接返回的不是支持的图片格式（{ctype or '未知类型'}）"}, ensure_ascii=False)
            # Content-Length 提前拒绝：声明体积就超限的，不用读 body。
            clen = resp.headers.get("content-length")
            if clen and clen.isdigit() and int(clen) > _SEND_URL_MAX_BYTES:
                await resp.aclose()
                return json.dumps({"error": f"图片过大（{int(clen) / 1048576:.1f}MB），超过 {_SEND_URL_MAX_BYTES // 1048576}MB 上限"}, ensure_ascii=False)

            # 流式读取 + 累计限流：chunked/无 Content-Length 时在读取过程中累计，超限立即中止，
            # 不把整个响应消费完（防 DoS）。
            total = 0
            chunks: list[bytes] = []
            try:
                async for chunk in resp.aiter_bytes():
                    total += len(chunk)
                    if total > _SEND_URL_MAX_BYTES:
                        return json.dumps({"error": f"图片过大（超过 {_SEND_URL_MAX_BYTES // 1048576}MB 上限）"}, ensure_ascii=False)
                    chunks.append(chunk)
            finally:
                await resp.aclose()
            data = b"".join(chunks)
    except Exception as e:
        return json.dumps({"error": f"图片下载失败（{type(e).__name__}），换一张或换个来源试试"}, ensure_ascii=False)
    if not data:
        return json.dumps({"error": "下载到的内容是空的"}, ensure_ascii=False)

    if not stage:
        return {"data": data, "ext": ext, "mime": ctype}

    from app.core import chat_attach
    name = (title or "").strip()[:80] or "图片"
    meta = await chat_attach.stage(user_id, name, ext, ctype, data, kind="image")
    return {
        "ok": True,
        "message": f"已把「{name}」发到对话窗口。",
        "_artifact": {
            "attach_id": meta["attach_id"],
            "name": name,
            "ext": ext,
            "size_bytes": len(data),
            "kind": "image",
            # 带上真实像素尺寸：前端预览窗口直接按此定尺，不用再靠缩略图猜（猜不准会出现
            # 「先弹很大的窗口再缩小」的问题，小图/非4K图尤其明显）
            "img_width": meta.get("img_width"),
            "img_height": meta.get("img_height"),
        },
    }


async def inspect_image_url(url: str):
    """安全下载网络图片并转换成视觉输入，不把图片发送到对话附件区。"""
    from app.core import chat_attach

    if not chat_attach.vision_ready():
        return {"error": "当前模型/通道不支持直接读取网络图片"}
    result = await _send_file_from_url(None, url, "", stage=False)
    if not isinstance(result, dict) or not result.get("data"):
        return {"error": "网络图片下载失败，无法读取"}
    ext = result.get("ext")
    if ext not in chat_attach.VISION_EXTS:
        return {"error": f"图片格式 {ext} 暂不支持识别"}
    block = chat_attach.vision_block(result["data"], ext)
    if not block:
        return {"error": "图片无法解析"}
    return {"block": block}


async def _send_file(db, user_id, args: dict):
    """把文件发到对话窗口（前端渲染可下载卡片）：文件库里的文件用 file_id/file；
    网络图片（如 image_search 搜到的）用 url——下载后暂存成聊天附件，同一套 _artifact 机制；
    之前收到/发过、还在暂存区的附件用 attach_id——直接重发，不重新下载、不进文件库。
    返回 _artifact，core 据此推一个 file 事件给前端；普通字段回给 LLM。

    群成员（member/unknown）只能用 url 发网络图片（搜图配图），不能发文件库文件
    （file/file_id）或重发暂存附件（attach_id）——后两者会读取 Bot 所属账号的私有文件。
    """
    from agent.im import imctx
    im = imctx.get_im()
    is_restricted = bool(im and im.get("im_role") in ("member", "unknown"))

    source_type = args.get("source_type")
    if source_type:
        source_key = "file_id" if source_type == "file_id" else source_type
        if not args.get(source_key):
            return {"error": f"source_type={source_type} 时必须提供 {source_key}"}

    url = (args.get("url") or "").strip()
    if url:
        return await _send_file_from_url(user_id, url, args.get("title") or "")

    if is_restricted:
        # 群成员只允许发网络图片（url 分支）；file/file_id/attach_id 涉及 owner 私有文件，禁止。
        return json.dumps({"error": "群聊里只能发网络图片（用 url 传图片直链），不能发文件库文件或重发附件"}, ensure_ascii=False)

    attach_id = (args.get("attach_id") or "").strip()
    if attach_id:
        from app.core import chat_attach
        meta, note = await chat_attach.resolve_attach(user_id, attach_id)
        if not meta:
            return json.dumps({"error": "没找到这个附件，可能已经过期了（聊天附件只暂存 7 天）"}, ensure_ascii=False)
        name = f"{meta['name']}.{meta['ext']}" if meta.get("ext") else meta["name"]
        return {
            "ok": True,
            "message": f"已把《{name}》重新发到对话窗口。{note}".strip(),
            "_artifact": {
                "attach_id": meta["attach_id"], "name": meta["name"], "ext": meta.get("ext"),
                "size_bytes": meta.get("size"), "kind": meta.get("kind"),
                "img_width": meta.get("img_width"), "img_height": meta.get("img_height"),
            },
        }

    # Shell 生成的文件可能尚未登记到文件库；先处理逻辑绝对路径，避免把它
    # 当成 display_name 查询。成功后复用聊天附件发送链路，网页、QQ、飞书等
    # 出口都能拿到同一份受控 artifact。
    path_artifact = await _stage_send_path(db, user_id, args.get("file")) if args.get("file") else None
    if isinstance(path_artifact, str):
        return path_artifact
    if path_artifact:
        path_name = path_artifact["name"]
        return {
            "ok": True,
            "message": f"已把《{path_name}.{path_artifact['ext']}》发到对话窗口，用户可直接下载。",
            "_artifact": path_artifact,
        }

    f, err = await _resolve_file(db, user_id, args)
    if err:
        return err
    name = f"{f.display_name}.{f.ext}"
    return {
        "ok": True,
        "message": f"已把《{name}》发到对话窗口，用户可直接下载。",
        "_artifact": {
            "file_id": f.id,
            "name": f.display_name,
            "ext": f.ext,
            "size_bytes": f.size_bytes,
            "img_width": f.img_width,
            "img_height": f.img_height,
        },
    }


async def _present_file(db, user_id, args: dict):
    """把文件直接推到用户当前网页上打开（全局预览窗口）。只读、不改数据。

    复用 events:{user_id} 实时频道：载荷只含 file_id/name/ext 三个展示必需字段，
    取数由前端预览组件走既有 /files/{id}/download 端点（端点自身校验属主）。
    IM 会话里禁用——用户不在网页上，推了也看不到。
    """
    from agent.im import imctx
    if imctx.get_im():
        return json.dumps({"error": "present_file 只支持网页端；IM 会话里请用 send_file 发送文件"}, ensure_ascii=False)

    f, err = await _resolve_file(db, user_id, args)
    if err:
        return err
    from app.core.redis import get_redis
    payload = {"present": {"file_id": f.id, "name": f.display_name, "ext": f.ext}}
    try:
        await get_redis().publish(f"events:{user_id}", json.dumps(payload, ensure_ascii=False))
    except Exception as exc:
        return json.dumps({"error": f"推送失败：{redact(str(exc))}"}, ensure_ascii=False)
    return {"ok": True, "message": f"已在用户当前页面打开《{f.display_name}.{f.ext}》。", "file_id": f.id}

# 对外使用稳定名称；files.py 继续导出旧的下划线名称，兼容现有调用方。
normalize_send_path = _normalize_send_path
stage_send_path = _stage_send_path
send_file_from_url = _send_file_from_url
send_file = _send_file
present_file = _present_file
list_recent_attachments = _list_recent_attachments
