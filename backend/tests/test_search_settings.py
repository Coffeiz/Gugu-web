"""搜索默认配置回归。"""

from app.core.config import SearchSettings


def test_default_searxng_engines_use_registered_web_engine_ids():
    assert SearchSettings().searxng_engines == (
        "baidu,sogou,quark,360search,yandex,duckduckgo web,mwmbl,gabanza,reloado,"
        "searchch,privacywall,gmx,zapmeta,google"
    )
