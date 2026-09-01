"""无需登录即可读取的站点展示配置。只返回明确允许公开的非敏感字段。"""

from fastapi import APIRouter

from app.core.config import get_settings

router = APIRouter(prefix="/site-config", tags=["site-config"])


@router.get("")
async def site_config() -> dict[str, str]:
    settings = get_settings()
    return {
        "icpNumber": settings.gugu_site_icp_number.strip(),
        "icpUrl": settings.gugu_site_icp_url.strip() or "https://beian.miit.gov.cn/",
    }
