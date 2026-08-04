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
from typing import Any, Optional
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

OVERRIDE_FILE = Path(__file__).parent.parent.parent / "config.override.json"


def normalize_dimensions(value: Any) -> int:
    """把后台配置中的空维度统一为 0，避免空字符串进入整数配置模型。"""
    if value is None or (isinstance(value, str) and not value.strip()):
        return 0
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


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
    max_tokens: int = Field(8000, description="最大输出 token 数")
    temperature: float = Field(0.7, description="发散度 0~2")
    context_tokens: int = Field(3000, description="历史上下文 token 预算")
    thinking: str = Field("disabled", description="深度思考模式: disabled | adaptive")
    reasoning_effort: str = Field("", description="思考强度（仅 DeepSeek、思考开时生效）: 空=跟随模型默认 | high | max")
    vision: bool = Field(False, description="模型是否支持多模态（看图）。后台「检测」按钮探测后写入，亦可手动改")
    api_format: str = Field("", description="API 格式: openai | anthropic | 空=按 provider/base_url 自动判（mimo 等同时提供两套 API 的厂商可显式选）")


class VoiceSettings(BaseModel):
    """语音 / 音视频识别（转写）模型——独立于主模型。把语音转成文字后交主模型处理，主模型不再被强切。
    **model 为空 = 未配置**：收到语音/音视频时咕咕直接回「不支持」，不再强切 mimo。
    `api_format=openai` 走 OpenAI 兼容接口，`api_format=dashscope` 走百炼原生多模态接口。"""
    api_key: str = Field("", description="语音模型 API Key")
    base_url: str = Field("", description="语音模型 Base URL")
    model: str = Field("", description="语音/识别模型名（空=未配置→收到语音回不支持）")
    api_format: str = Field("openai", description="语音接口格式: openai | dashscope")
    dashscope_service: str = Field(
        "qwen3-asr",
        description="DashScope 产品线: qwen3-asr | qwen-audio | fun-asr",
    )


class AIPresetItem(BaseModel):
    id: str = ""
    name: str = ""
    provider: str = "openai"
    api_key: str = ""
    base_url: str = ""
    model: str = ""
    max_tokens: int = 8000
    temperature: float = 0.7
    context_tokens: int = 3000
    thinking: str = "disabled"
    reasoning_effort: str = ""   # 思考强度（仅 DeepSeek、思考开时生效）：空=默认 | high | max
    vision: bool = False
    api_format: str = ""         # API 格式: openai | anthropic | 空=自动（mimo 等双 API 厂商可显式选）
    in_pool: bool = False        # 是否加入「多 key 分流」池（strategy=pool 时随机挑这些）


class AIPresets(BaseModel):
    active_id: str = ""
    strategy: str = "active"     # 选模型策略：active 单一激活 | pool 多 key 分流 | router 智能路由（未来）
    pool_mode: str = "random"    # pool 分流方式：random 随机 | round_robin 轮询 | least_loaded 最少在途
    items: list[AIPresetItem] = Field(default_factory=list)


class AgentBehaviorSettings(BaseModel):
    memory_enabled: bool = Field(True, description="是否启用记忆系统")
    reflection_threshold: int = Field(10, description="触发 Reflection 的消息数")
    worker_concurrency: int = Field(16, description="IM worker 同时跑几条 agent（实测单 MiniMax key 安全上限≈16；worker 每 30s 热读）")
    conv_compress_enabled: bool = Field(True, description="对话历史压缩：超长会话把旧消息总结成摘要省 token；关闭后只按 token 截断、不摘要（web 即时、worker 每 30s 热读）")
    im_progress_announce_enabled: bool = Field(True, description="IM 慢工具进度声明：多步工具循环期间（IM 非流式、用户容易觉得沉默）先发一句「我去查一下」这类声明再执行，文案来自工具自身登记的 start_message（不是模型现场生成，见 docs/agent/proposals/IM慢工具进度声明-设计.md）；只在 IM 生效，网页不受影响")
    daily_retention_days: int = Field(14, description="daily 记忆保留天数（过期直接压进 memory.md）")
    # 已废弃：weekly 层已砍，压缩定为 daily→memory 两段；字段暂留兼容旧 override，不再使用
    weekly_retention_weeks: int = Field(6, description="（已废弃，weekly 层取消）")


class QuotaSettings(BaseModel):
    default_token_limit_6h:      Optional[int] = Field(None, description="全局 6 小时 Token 上限（None=不限制）")
    default_token_limit_weekly:  Optional[int] = Field(None, description="全局每周 Token 上限（None=不限制）")
    default_storage_limit_bytes: Optional[int] = Field(None, description="全局存储空间上限（None=不限制）")
    default_search_limit_daily:  Optional[int] = Field(None, description="全局每日联网搜索次数上限（None=不限制）")


class SearchSettings(BaseModel):
    tavily_api_key: str = Field("", description="Tavily API Key（空=禁用 deep_research 深度研究）")
    searxng_url:    str = Field("", description="自建 SearXNG 实例地址（空=禁用 web_search 通用搜索），如 http://127.0.0.1:8888")
    searxng_engines: str = Field("sogou,quark,360search", description="SearXNG 启用的引擎（逗号分隔；国内服务器只有这几个可达）")
    searxng_image_engines: str = Field("", description="SearXNG 图片搜索（image_search）启用的引擎（逗号分隔）；留空则回退复用 searxng_engines。图片分类能连通的引擎不一定和文本分类是同一批，需部署后用「测试」按钮实测调整")
    max_results:    int = Field(5, description="默认返回结果数")


class StateLabelSettings(BaseModel):
    """对话里「状态指示」的自定义命名。key=工具名（web_search…）或特殊状态键（_thinking/_preparing/
    _verify_prefix），value=自定义显示名；未设的 key 自动回退到代码默认（工具的 label / 内置默认）。
    后台「状态命名」面板写入，core/前端热读。"""
    overrides: dict[str, str] = Field(default_factory=dict, description="状态显示名覆盖表（key→自定义名）")


class SmtpSettings(BaseModel):
    host:     str           = Field("", description="SMTP 服务器地址")
    port:     int           = Field(465, description="SMTP 端口（465=SSL，587=STARTTLS）")
    user:     str           = Field("", description="SMTP 登录账号")
    password: str           = Field("", description="SMTP 登录密码")
    from_addr: str          = Field("", description="发件人地址（默认同 user）")
    to_addr:  str           = Field("", description="反馈通知收件人地址")
    use_ssl:  bool          = Field(True, description="True=SSL(465)，False=STARTTLS(587)")


class EmbeddingSettings(BaseModel):
    """向量 embedding 模型——**独立于聊天/语音模型，单独 pin**（见 docs/agent/参考/咕咕改进方案-MaiBot借鉴.md 改进一）。

    聊天模型天天轮换，embedding 必须钉死一个：换了它 = 所有已存向量作废、需整体重建。故意**不进 pick_model 路由**。
    走 OpenAI 兼容的 `/embeddings` 接口。`enabled=False` 或未配 model → `embed()` 返回 None，
    记忆检索自动退回词法相关性（bigram），零副作用——这也是"模型待定先搭框架"阶段的默认状态。"""
    enabled:    bool = Field(False, description="是否启用向量检索（False=embed 全程 no-op，退回词法相关性）")
    multimodal: bool = Field(False, description="是否使用百炼多模态 Embedding（图片/视频需由调用方传入）")
    provider:   str  = Field("", description="提供方（仅记录用；固定走 OpenAI 兼容 /embeddings）")
    base_url:   str  = Field("", description="Embedding Base URL（到 /v1 那层，不含 /embeddings）")
    api_key:    str  = Field("", description="API Key")
    model:      str  = Field("", description="embedding 模型名（空=未配置→退回词法）")
    dimensions: int  = Field(0, description="请求维度（0=用模型默认；部分模型支持指定）")


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
    admin_username: str = Field("admin", description="后台管理员用户名（env ADMIN_USERNAME）")
    admin_password: str = Field("admin123", description="后台管理员密码（env ADMIN_PASSWORD）")

    db: DatabaseSettings = Field(default_factory=DatabaseSettings)
    redis: RedisSettings = Field(default_factory=RedisSettings)
    storage: StorageSettings = Field(default_factory=StorageSettings)
    ai: AISettings = Field(default_factory=AISettings)
    voice: VoiceSettings = Field(default_factory=VoiceSettings)   # 独立语音识别模型（空=不支持语音）
    embedding: EmbeddingSettings = Field(default_factory=EmbeddingSettings)   # 独立向量模型（disabled=退回词法检索）
    ai_presets: AIPresets = Field(default_factory=AIPresets)
    agent: AgentBehaviorSettings = Field(default_factory=AgentBehaviorSettings)
    quota: QuotaSettings = Field(default_factory=QuotaSettings)
    search: SearchSettings = Field(default_factory=SearchSettings)
    smtp: SmtpSettings = Field(default_factory=SmtpSettings)
    state_labels: StateLabelSettings = Field(default_factory=StateLabelSettings)

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

            if "voice" in override:
                merged = {**self.voice.model_dump(), **{
                    k: v for k, v in override["voice"].items()
                    if k in VoiceSettings.model_fields
                }}
                updates["voice"] = VoiceSettings.model_construct(**merged)

            if "embedding" in override:
                merged = {**self.embedding.model_dump(), **{
                    k: v for k, v in override["embedding"].items()
                    if k in EmbeddingSettings.model_fields
                }}
                merged["dimensions"] = normalize_dimensions(merged.get("dimensions"))
                updates["embedding"] = EmbeddingSettings.model_construct(**merged)

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

            if "smtp" in override:
                merged = {**self.smtp.model_dump(), **{
                    k: v for k, v in override["smtp"].items()
                    if k in SmtpSettings.model_fields
                }}
                updates["smtp"] = SmtpSettings.model_construct(**merged)

            if "agent" in override:
                merged = {**self.agent.model_dump(), **{
                    k: v for k, v in override["agent"].items()
                    if k in AgentBehaviorSettings.model_fields
                }}
                updates["agent"] = AgentBehaviorSettings.model_construct(**merged)

            if "ai_presets" in override:
                raw = override["ai_presets"]
                items = [
                    AIPresetItem(**{k: v for k, v in it.items() if k in AIPresetItem.model_fields})
                    for it in raw.get("items", [])
                ]
                updates["ai_presets"] = AIPresets.model_construct(
                    active_id=raw.get("active_id", ""),
                    strategy=raw.get("strategy", "active"),
                    pool_mode=raw.get("pool_mode", "random"),
                    items=items,
                )

            if "state_labels" in override:
                raw = override["state_labels"] or {}
                ov = raw.get("overrides", raw) if isinstance(raw, dict) else {}
                updates["state_labels"] = StateLabelSettings.model_construct(
                    overrides={str(k): str(v) for k, v in ov.items() if isinstance(ov, dict)}
                )

            # 顶层字段（secret_key、debug 等）
            top_fields = set(AppSettings.model_fields) - {"db", "redis", "storage", "ai", "ai_presets", "quota", "agent", "search", "state_labels", "smtp", "voice", "embedding"}
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
    if isinstance(patch.get("embedding"), dict) and "dimensions" in patch["embedding"]:
        patch = {**patch, "embedding": {
            **patch["embedding"],
            "dimensions": normalize_dimensions(patch["embedding"].get("dimensions")),
        }}
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
