"""无需登录即可读取的站点展示配置。只返回明确允许公开的非敏感字段。"""

from fastapi import APIRouter

from app.core.config import get_settings

router = APIRouter(prefix="/site-config", tags=["site-config"])


@router.get("")
async def site_config() -> dict[str, str | bool]:
    settings = get_settings()
    return {
        "icpNumber": settings.gugu_site_icp_number.strip(),
        "icpUrl": settings.gugu_site_icp_url.strip() or "https://beian.miit.gov.cn/",
        # 与邮件服务保持同一判断：没有 SMTP 主机时，密码找回邮件无法发送。
        # 这里只公开能力开关，不返回任何 SMTP 配置内容。
        "passwordResetEnabled": bool(settings.smtp.host.strip()),
    }
