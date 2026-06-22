"""
配置加载顺序：
  1. 环境变量 / .env 文件（基础值，通过 AppSettings env_nested_delimiter）
  2. config.override.json（通过 Admin UI 写入，优先级最高）

嵌套配置类使用 BaseModel（不是 BaseSettings）——避免 apply_override
调用 model_validate 时触发二次 env 读取，把 override 值覆盖掉。
"""

import asyncio
import json
from pathlib import Path
from functools import lru_cache
from typing import Optional
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

OVERRIDE_FILE = Path(__file__).parent.parent.parent / "config.override.json"


class DatabaseSettings(BaseModel):
    host: str = Field("localhost", description="数据库主机")
    port: int = Field(5432, description="端口")
    name: str = Field("gugu_web", description="数据库名")
    user: str = Field("pm", description="用户名")
    password: str = Field("pm123", description="密码")

    @property
    def url(self) -> str:
        return f"postgresql+asyncpg://{self.user}:{self.password}@{self.host}:{self.port}/{self.name}"


class RedisSettings(BaseModel):
    host: str = Field("localhost", description="Redis 主机")
    port: int = Field(6379, description="端口")
    password: str = Field("", description="认证密码")

    @property
    def url(self) -> str:
        auth = f":{self.password}@" if self.password else ""
        return f"redis://{auth}{self.host}:{self.port}/0"


class StorageSettings(BaseModel):
    backend: str = Field("local", description="存储后端: local | oss")
    local_path: str = Field("./uploads", description="本地存储路径")
    oss_access_key_id: str = Field("", description="OSS AccessKey ID")
    oss_access_key_secret: str = Field("", description="OSS AccessKey Secret")
    oss_bucket: str = Field("gugu-web", description="OSS Bucket 名")
    oss_endpoint: str = Field("oss-cn-hangzhou.aliyuncs.com", description="OSS Endpoint")
    oss_prefix:   str = Field("", description="OSS 对象前缀，如 gugu-web/")


class AISettings(BaseModel):
    provider: str = Field("qwen", description="AI 提供方: qwen | openai | deepseek | minimax | anthropic")
    api_key: str = Field("", description="API Key")
    base_url: str = Field(
        "https://dashscope.aliyuncs.com/compatible-mode/v1",
        description="API Base URL",
    )
    model: str = Field("qwen-max", description="使用模型")
    max_tokens: int = Field(2000, description="最大输出 token 数")
    temperature: float = Field(0.7, description="发散度 0~2")
    context_tokens: int = Field(3000, description="历史上下文 token 预算")
    thinking: str = Field("disabled", description="深度思考模式: disabled | adaptive")


class AIPresetItem(BaseModel):
    id: str = ""
    name: str = ""
    provider: str = "openai"
    api_key: str = ""
    base_url: str = ""
    model: str = ""
    max_tokens: int = 2000
    temperature: float = 0.7
    context_tokens: int = 3000
    thinking: str = "disabled"


class AIPresets(BaseModel):
    active_id: str = ""
    items: list[AIPresetItem] = Field(default_factory=list)


class AgentBehaviorSettings(BaseModel):
    memory_enabled: bool = Field(True, description="是否启用记忆系统")
    reflection_threshold: int = Field(10, description="触发 Reflection 的消息数")
    daily_retention_days: int = Field(14, description="daily 记忆保留天数（过期直接压进 memory.md）")
    # 已废弃：weekly 层已砍，压缩定为 daily→memory 两段；字段暂留兼容旧 override，不再使用
    weekly_retention_weeks: int = Field(6, description="（已废弃，weekly 层取消）")


class QuotaSettings(BaseModel):
    default_token_limit_6h:      Optional[int] = Field(None, description="全局 6 小时 Token 上限（None=不限制）")
    default_token_limit_weekly:  Optional[int] = Field(None, description="全局每周 Token 上限（None=不限制）")
    default_storage_limit_bytes: Optional[int] = Field(None, description="全局存储空间上限（None=不限制）")
    default_search_limit_daily:  Optional[int] = Field(None, description="全局每日联网搜索次数上限（None=不限制）")


class SearchSettings(BaseModel):
    tavily_api_key: str = Field("", description="Tavily 联网搜索 API Key（空=禁用 web_search）")
    max_results:    int = Field(5, description="默认返回结果数")


class FeishuSettings(BaseModel):
    app_id:     str = Field("", description="飞书自建应用 App ID（env FEISHU__APP_ID）")
    app_secret: str = Field("", description="飞书 App Secret（env FEISHU__APP_SECRET，空=禁用飞书网关）")


class AppSettings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_prefix="",
        env_nested_delimiter="__",
        extra="ignore",
    )

    app_name: str = "Gugu"
    debug: bool = False
    secret_key: str = Field("change-me-in-production", description="JWT 签名密钥")
    access_token_expire_minutes: int = Field(10080, description="Token 有效期（分钟）")

    db: DatabaseSettings = Field(default_factory=DatabaseSettings)
    redis: RedisSettings = Field(default_factory=RedisSettings)
    storage: StorageSettings = Field(default_factory=StorageSettings)
    ai: AISettings = Field(default_factory=AISettings)
    ai_presets: AIPresets = Field(default_factory=AIPresets)
    agent: AgentBehaviorSettings = Field(default_factory=AgentBehaviorSettings)
    quota: QuotaSettings = Field(default_factory=QuotaSettings)
    search: SearchSettings = Field(default_factory=SearchSettings)
    feishu: FeishuSettings = Field(default_factory=FeishuSettings)

    def apply_override(self) -> "AppSettings":
        """从 config.override.json 合并覆盖字段，返回新实例。

        使用 model_copy + model_construct 而非 model_validate，
        避免 BaseSettings 在 __init__ 中重新读取 env 变量。
        """
        if not OVERRIDE_FILE.exists():
            return self
        try:
            override = json.loads(OVERRIDE_FILE.read_text(encoding="utf-8"))
            updates: dict = {}

            if "db" in override:
                merged = {**self.db.model_dump(), **{
                    k: v for k, v in override["db"].items()
                    if k in DatabaseSettings.model_fields
                }}
                updates["db"] = DatabaseSettings.model_construct(**merged)

            if "redis" in override:
                merged = {**self.redis.model_dump(), **{
                    k: v for k, v in override["redis"].items()
                    if k in RedisSettings.model_fields
                }}
                updates["redis"] = RedisSettings.model_construct(**merged)

            if "storage" in override:
                merged = {**self.storage.model_dump(), **{
                    k: v for k, v in override["storage"].items()
                    if k in StorageSettings.model_fields
                }}
                updates["storage"] = StorageSettings.model_construct(**merged)

            if "ai" in override:
                merged = {**self.ai.model_dump(), **{
                    k: v for k, v in override["ai"].items()
                    if k in AISettings.model_fields
                }}
                updates["ai"] = AISettings.model_construct(**merged)

            if "quota" in override:
                merged = {**self.quota.model_dump(), **{
                    k: v for k, v in override["quota"].items()
                    if k in QuotaSettings.model_fields
                }}
                updates["quota"] = QuotaSettings.model_construct(**merged)

            if "search" in override:
                merged = {**self.search.model_dump(), **{
                    k: v for k, v in override["search"].items()
                    if k in SearchSettings.model_fields
                }}
                updates["search"] = SearchSettings.model_construct(**merged)

            if "feishu" in override:
                merged = {**self.feishu.model_dump(), **{
                    k: v for k, v in override["feishu"].items()
                    if k in FeishuSettings.model_fields
                }}
                updates["feishu"] = FeishuSettings.model_construct(**merged)

            if "ai_presets" in override:
                raw = override["ai_presets"]
                items = [
                    AIPresetItem(**{k: v for k, v in it.items() if k in AIPresetItem.model_fields})
                    for it in raw.get("items", [])
                ]
                updates["ai_presets"] = AIPresets.model_construct(
                    active_id=raw.get("active_id", ""),
                    items=items,
                )

            # 顶层字段（secret_key、debug 等）
            top_fields = set(AppSettings.model_fields) - {"db", "redis", "storage", "ai", "ai_presets", "quota", "agent", "search", "feishu"}
            for k in top_fields:
                if k in override:
                    updates[k] = override[k]

            return self.model_copy(update=updates)
        except Exception as e:
            print(f"[config] override 加载失败: {e}")
            return self


def _deep_merge(base: dict, override: dict) -> None:
    for k, v in override.items():
        if isinstance(v, dict) and isinstance(base.get(k), dict):
            _deep_merge(base[k], v)
        else:
            base[k] = v


@lru_cache
def get_settings() -> AppSettings:
    return AppSettings().apply_override()


async def save_override(patch: dict) -> AppSettings:
    existing = {}
    if OVERRIDE_FILE.exists():
        existing = json.loads(OVERRIDE_FILE.read_text(encoding="utf-8"))
    _deep_merge(existing, patch)
    OVERRIDE_FILE.write_text(json.dumps(existing, ensure_ascii=False, indent=2), encoding="utf-8")
    get_settings.cache_clear()
    new_settings = get_settings()
    if "redis" in patch:
        # 延迟导入避免循环依赖；Redis 配置变更后重建共享客户端
        from app.core.redis import reset as reset_redis
        await reset_redis()
    if "db" in patch:
        # 延迟导入避免循环依赖（db.session 也会 import config）
        from app.db.session import reset_engine, create_all_tables
        reset_engine()
        # 保存后立刻尝试建表（最多 10s），失败也不报错，后台重试会继续
        try:
            await asyncio.wait_for(create_all_tables(), timeout=10)
            print("[OK] 数据库配置更新，表已建/已就绪")
        except asyncio.TimeoutError:
            print("[警告] 数据库 10s 内未连通，表创建延后（后台重试会继续）")
        except Exception as e:
            print(f"[警告] 表创建失败（{type(e).__name__}: {e}），后台重试会继续")
    return new_settings
