"""
配置加载顺序：
  1. 环境变量 / .env 文件（基础值，通过 AppSettings env_nested_delimiter）
  2. config.override.json（通过 Admin UI 写入，优先级最高）

嵌套配置类使用 BaseModel（不是 BaseSettings）——避免 apply_override
调用 model_validate 时触发二次 env 读取，把 override 值覆盖掉。
"""

from __future__ import annotations

import asyncio
import errno
import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any, Literal, Optional
from pydantic import BaseModel, Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

OVERRIDE_FILE = Path(
    os.getenv(
        "GUGU_CONFIG_OVERRIDE_FILE",
        str(Path(__file__).parent.parent.parent / "config.override.json"),
    )
)


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
    user: str = Field("gugu", description="用户名")
    # password 默认空串：业务必须从环境变量或 config.override.json 提供；缺失会被
    # apply_override 校验抛错，避免「默默用空密码连 DB」导致 worker 反复启动失败。
    password: str = Field("", description="密码（必须从环境变量或 config.override.json 提供）")

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
    # 用户文件和 Shell 沙盒统一放在仓库根目录的数据区；旧 backend/uploads
    # 仅由一次性迁移脚本读取，不能再作为运行时默认根目录。
    local_path: str = Field("../Gugu-data/users", description="本地用户数据与 Shell 沙盒根目录")
    oss_access_key_id: str = Field("", description="OSS AccessKey ID")
    oss_access_key_secret: str = Field("", description="OSS AccessKey Secret")
    oss_bucket: str = Field("gugu-web", description="OSS Bucket 名")
    oss_endpoint: str = Field("oss-cn-hangzhou.aliyuncs.com", description="OSS Endpoint")
    oss_prefix:   str = Field("", description="OSS 对象前缀，如 gugu-web/")


class AISettings(BaseModel):
    provider: str = Field("qwen", description="AI 提供方: qwen | openai | ollama | deepseek | minimax | anthropic | glm")
    api_key: str = Field("", description="API Key")
    base_url: str = Field(
        "https://dashscope.aliyuncs.com/compatible-mode/v1",
        description="API Base URL",
    )
    model: str = Field("qwen-max", description="使用模型")
    max_tokens: int = Field(4000, description="最大输出 token 数")
    temperature: float = Field(0.7, description="发散度 0~2")
    context_tokens: int = Field(120000, description="历史上下文 token 预算")
    thinking: str = Field("disabled", description="深度思考模式: disabled | adaptive")
    reasoning_effort: str = Field("", description="思考强度（仅 DeepSeek、思考开时生效）: 空=跟随模型默认 | low | high | max")
    vision: bool = Field(False, description="模型是否支持多模态（看图）。后台「检测」按钮探测后写入，亦可手动改")
    vision_detail: str = Field("auto", description="图片细节级别: auto | low | high | original")
    vision_video: bool = Field(False, description="模型是否支持视频理解。后台「检测」按钮探测后写入，亦可手动改")
    vision_audio: bool = Field(False, description="模型是否支持音频理解。后台「检测」按钮探测后写入，亦可手动改")
    api_format: str = Field("", description="API 格式: openai | anthropic | 空=按 provider/base_url 自动判（mimo 等同时提供两套 API 的厂商可显式选）")
    ollama_mode: str = Field("local", description="Ollama 连接模式: local | cloud")
    ollama_api_mode: str = Field("native", description="Ollama 接口模式: native | openai")
    ollama_keep_alive: str = Field("5m", description="Ollama 模型驻留时间；0 表示请求结束后卸载")
    deployment_mode: str = Field("cloud", description="部署方式: cloud | local")
    local_runtime: str = Field("other", description="本地运行时: ollama | llama.cpp | vllm | other")
    capability_overrides: dict[str, bool] = Field(default_factory=dict, description="模型能力人工覆盖")
    capability_checked_at: str = Field("", description="最近一次能力检测时间")
    capability_fingerprint: str = Field("", description="能力检测绑定的地址/模型指纹")


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


class SandboxSettings(BaseModel):
    """Shell 容器沙盒配置。

    enabled 只表示 Admin 请求启用沙盒；是否真的可执行还必须经过 Docker
    运行时探测和执行器就绪检查，不能由配置值单独推断。
    """
    enabled: bool = Field(False, description="是否启用 Docker Shell 沙盒（默认关闭）")
    image: str = Field("debian:bookworm-slim", description="Shell 沙盒基础镜像")
    image_digest: str = Field(
        "sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171",
        description="已验证的固定镜像 digest；必须与当前 daemon 已加载镜像一致",
    )
    rootless_required: bool = Field(True, description="是否要求 Rootless Docker")
    network_profile: Literal["none", "egress"] = Field("none", description="容器网络策略；默认断网，egress 仅在受控代理配置后可用")
    egress_proxy_url: str = Field("", description="受控 egress HTTP(S) 代理地址；为空时禁止临时联网")
    egress_network_name: str = Field("gugu-sandbox-egress", description="仅供沙盒容器使用的内部 Docker 网络名")
    egress_ttl_seconds: int = Field(600, ge=60, le=1800, description="单次 egress 授权最长有效期")
    egress_isolation_enabled: bool = Field(False, description="是否已部署隔离 egress 网络；未部署时强制拒绝")
    cpu_limit: float = Field(1.0, ge=0.1, le=2.0, description="单用户容器 CPU 上限")
    memory_limit_bytes: int = Field(512 * 1024 * 1024, ge=64 * 1024 * 1024, description="单用户容器内存上限")
    pids_limit: int = Field(64, ge=16, le=512, description="单用户容器进程数上限")
    timeout_seconds: int = Field(30, ge=1, le=300, description="单次 Shell 默认超时")
    output_limit_bytes: int = Field(12 * 1024, ge=1024, le=120 * 1024, description="单次 Shell 输出上限")
    pty_output_limit_bytes: int = Field(120 * 1024, ge=1024, le=4 * 1024 * 1024, description="交互式 PTY 单会话输出上限")
    pty_output_rate_bytes: int = Field(256 * 1024, ge=1024, le=4 * 1024 * 1024, description="交互式 PTY 每秒输出上限")
    persistent_quota_bytes: int = Field(512 * 1024 * 1024, ge=64 * 1024 * 1024, description="每用户 Shell 持久空间配额")
    ephemeral_quota_bytes: int = Field(1024 * 1024 * 1024, ge=64 * 1024 * 1024, description="每用户 Shell 临时构建/cache 配额")
    sandboxd_socket: str = Field(
        default_factory=lambda: os.getenv(
            "GUGU_SANDBOXD_SOCKET",
            f"/run/user/{getattr(os, 'getuid', lambda: 0)()}/gugu-sandboxd.sock",
        ),
        description="sandboxd Unix Socket；生产 Shell 必须通过该 socket 执行",
    )


class AIPresetItem(BaseModel):
    id: str = ""
    name: str = ""
    provider: str = "openai"
    api_key: str = ""
    base_url: str = ""
    model: str = ""
    max_tokens: int = 4000
    temperature: float = 0.7
    context_tokens: int = 120000
    thinking: str = "disabled"
    reasoning_effort: str = ""   # 思考强度（仅 DeepSeek、思考开时生效）：空=默认 | low | high | max
    vision: bool = False
    vision_detail: str = "auto"
    vision_video: bool = False
    vision_audio: bool = False
    api_format: str = ""         # API 格式: openai | anthropic | 空=自动（mimo 等双 API 厂商可显式选）
    ollama_mode: str = "local"   # Ollama 连接模式: local | cloud
    ollama_api_mode: str = "native"  # Ollama 接口模式: native | openai
    ollama_keep_alive: str = "5m"     # Ollama 模型驻留时间
    deployment_mode: str = "cloud"
    local_runtime: str = "other"
    capability_overrides: dict[str, bool] = Field(default_factory=dict)
    capability_checked_at: str = ""
    capability_fingerprint: str = ""
    in_pool: bool = False        # 是否加入「多 key 分流」池（strategy=pool 时随机挑这些）


class AIPresets(BaseModel):
    active_id: str = ""
    strategy: str = "active"     # 选模型策略：active 单一激活 | pool 多 key 分流 | router 智能路由（未来）
    pool_mode: str = "random"    # pool 分流方式：random 随机 | round_robin 轮询 | least_loaded 最少在途
    items: list[AIPresetItem] = Field(default_factory=list)


class AgentBehaviorSettings(BaseModel):
    # 高权限能力默认关闭；未打开时不应注册或执行 Shell 工具。
    shell_enabled: bool = Field(False, description="是否启用 Shell 工具（默认关闭）")
    shell_system_enabled: bool = Field(False, description="是否允许 Shell 访问系统范围（高风险，默认关闭）")
    shell_dangerous_enabled: bool = Field(False, description="是否允许危险 Shell 命令进入确认流程（默认关闭）")
    shell_autopilot_enabled: bool = Field(False, description="是否允许用户开启 Shell Autopilot，跳过确认门（默认关闭）")
    personality_preference_enabled: bool = Field(True, description="是否启用用户人格偏好（托管服务由后台权益开关控制，本地默认开启）")
    memory_enabled: bool = Field(True, description="是否启用记忆系统")
    reflection_threshold: int = Field(10, description="触发 Reflection 的消息数")
    worker_concurrency: int = Field(16, description="IM worker 同时跑几条 agent（实测单 MiniMax key 安全上限≈16；worker 每 30s 热读）")
    conv_compress_enabled: bool = Field(True, description="允许手动对话压缩；正常请求按实际组装上下文预算判断，不按数据库累计消息量后台压缩")
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
    rag_enabled: bool = Field(True, description="是否启用 Agent 自动知识召回（RAG）")
    rag_auto_sources: list[Literal["memory", "knowledge", "project", "file", "canvas", "note", "conversation"]] = Field(
        default_factory=lambda: ["memory", "knowledge", "project", "file", "canvas", "note", "conversation"],
        description="自动 Knowledge RAG 允许召回的来源；显式工具不受此开关影响",
    )
    capability_rag_enabled: bool = Field(False, description="是否启用能力目录 RAG 软推荐；只调整目录顺序，不裁剪授权工具")
    capability_rag_shadow: bool = Field(True, description="能力目录 RAG 是否只记录推荐而不改变目录顺序")
    capability_rag_limit: int = Field(5, ge=1, le=20, description="每轮能力目录最多推荐的工具数")
    deep_research_provider: Literal["tavily", "baidu", "you"] = Field("tavily", description="深度研究 Provider")
    tavily_api_key: str = Field("", description="Tavily API Key（空=禁用 deep_research 深度研究）")
    deep_research_baidu_api_key: str = Field("", description="百度普通搜索 API Key")
    deep_research_you_api_key: str = Field("", description="You.com Research API Key")
    searxng_url:    str = Field("", description="自建 SearXNG 实例地址（空=禁用 web_search 通用搜索），如 http://127.0.0.1:8888")
    searxng_engines: str = Field(
        "baidu,sogou,quark,360search,yandex,duckduckgo web,mwmbl,gabanza,reloado,searchch,privacywall,gmx,zapmeta,google",
        description="SearXNG 启用的通用网页搜索引擎（逗号分隔）",
    )
    searxng_image_engines: str = Field("", description="SearXNG 图片搜索（image_search）启用的引擎（逗号分隔）；留空则回退复用 searxng_engines。图片分类能连通的引擎不一定和文本分类是同一批，需部署后用「测试」按钮实测调整")
    max_results:    int = Field(5, description="默认返回结果数")
    global_search_backend: Literal["index", "ilike"] = Field(
        "ilike", description="全局搜索后端：持久化索引（index）或 ILIKE 兼容模式"
    )
    ts_sidecar_command: str = Field("", description="TypeScript RAG worker 命令；为空则使用项目内置构建物")
    ts_sidecar_index_dir: str = Field(
        "var/rag-ts-index",
        description="旧版 TypeScript 索引目录；新索引默认保存在用户存储目录的 .system/rag/ts-index 下",
    )
    ts_sidecar_index_ttl_seconds: int = Field(
        30 * 24 * 3600,
        ge=7 * 24 * 3600,
        le=365 * 24 * 3600,
        description="TypeScript RAG 用户索引缓存保留时间；仅清理长期未使用的可重建索引",
    )
    ts_sidecar_timeout_ms: int = Field(500, ge=50, le=30_000, description="TypeScript worker 单次请求超时毫秒数")
    similar_image_provider: Literal["baidu_qianfan"] = Field("baidu_qianfan", description="相似图搜索 Provider；有效 API Key 即表示启用")
    similar_image_enabled: bool = Field(False, description="旧版相似图搜索开关，仅保留配置兼容，不再作为启用条件")
    baidu_qianfan_api_key: str = Field("", description="百度千帆 API Key（空=禁用相似图搜索）")
    similar_image_default_count: int = Field(15, ge=1, le=50, description="相似图搜索默认返回数量")
    similar_image_timeout_seconds: int = Field(20, ge=5, le=60, description="相似图搜索请求超时秒数")
    similar_image_limit_daily: Optional[int] = Field(10, ge=1, description="每个用户每日相似图搜索次数上限")


class StateLabelSettings(BaseModel):
    """对话里「状态指示」的自定义命名。key=工具名（web_search…）或特殊状态键（_thinking/_preparing/
    _verify_prefix），value=自定义显示名；未设的 key 自动回退到代码默认（工具的 label / 内置默认）。
    后台「状态命名」面板写入，core/前端热读。"""
    overrides: dict[str, str] = Field(default_factory=dict, description="状态显示名覆盖表（key→自定义名）")


class BYOKSettings(BaseModel):
    """用户自带凭据开关；主密钥只允许由运行环境注入。"""
    enabled: bool = Field(True, description="是否开放用户 BYOK（默认开启；托管服务可由后台关闭）")
    master_key: str = Field("", repr=False, description="BYOK 主密钥（仅从 CREDENTIALS_MASTER_KEY 注入，不写入响应）")


class SmtpSettings(BaseModel):
    host:     str           = Field("", description="SMTP 服务器地址")
    port:     int           = Field(465, description="SMTP 端口（465=SSL，587=STARTTLS）")
    user:     str           = Field("", description="SMTP 登录账号")
    password: str           = Field("", description="SMTP 登录密码")
    from_addr: str          = Field("", description="发件人地址（默认同 user）")
    to_addr:  str           = Field("", description="反馈通知收件人地址")
    feedback_email_enabled: bool = Field(True, description="是否发送用户反馈邮件提醒")
    use_ssl:  bool          = Field(True, description="True=SSL(465)，False=STARTTLS(587)")


class SecuritySettings(BaseModel):
    """安全策略配置；短窗口计数仍存 Redis，配置只决定策略边界。"""

    ownership_window_seconds: int = Field(
        5 * 60, ge=60, le=24 * 3600, description="越权拒绝计数窗口（秒）"
    )
    ownership_throttle_threshold: int = Field(
        5, ge=1, le=1000, description="窗口内触发限流的拒绝次数"
    )
    ownership_suspend_threshold: int = Field(
        10, ge=1, le=1000, description="窗口内触发冻结判定的拒绝次数"
    )
    ownership_suspend_duration_seconds: int = Field(
        10 * 60, ge=60, le=30 * 24 * 3600, description="临时冻结持续时间（秒）"
    )
    ownership_auto_response_enabled: bool = Field(
        False, description="是否允许风险策略自动执行限流/冻结；默认关闭"
    )
    alert_email_enabled: bool = Field(False, description="是否发送安全策略邮箱告警；默认关闭")
    alert_email_recipients: list[str] = Field(default_factory=list, description="安全告警目标邮箱")

    @field_validator("alert_email_recipients")
    @classmethod
    def validate_alert_email_recipients(cls, values: list[str]) -> list[str]:
        pattern = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
        normalized = [str(value).strip() for value in values]
        if any(not pattern.fullmatch(value) for value in normalized):
            raise ValueError("安全告警目标邮箱格式无效")
        return list(dict.fromkeys(normalized))


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
    admin_password: str = Field("guguadmin", description="后台管理员密码（env ADMIN_PASSWORD）")

    db: DatabaseSettings = Field(default_factory=DatabaseSettings)
    redis: RedisSettings = Field(default_factory=RedisSettings)
    storage: StorageSettings = Field(default_factory=StorageSettings)
    ai: AISettings = Field(default_factory=AISettings)
    voice: VoiceSettings = Field(default_factory=VoiceSettings)   # 独立语音识别模型（空=不支持语音）
    embedding: EmbeddingSettings = Field(default_factory=EmbeddingSettings)   # 独立向量模型（disabled=退回词法检索）
    sandbox: SandboxSettings = Field(default_factory=SandboxSettings)
    ai_presets: AIPresets = Field(default_factory=AIPresets)
    agent: AgentBehaviorSettings = Field(default_factory=AgentBehaviorSettings)
    quota: QuotaSettings = Field(default_factory=QuotaSettings)
    search: SearchSettings = Field(default_factory=SearchSettings)
    smtp: SmtpSettings = Field(default_factory=SmtpSettings)
    security: SecuritySettings = Field(default_factory=SecuritySettings)
    state_labels: StateLabelSettings = Field(default_factory=StateLabelSettings)
    byok: BYOKSettings = Field(default_factory=BYOKSettings)
    # 业务 Live SSE 由 TypeScript 服务独立承载，FastAPI 不再提供代理入口。

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
                override_db = override["db"] or {}
                override_pw = override_db.get("password")
                if "password" in override_db and (
                    not isinstance(override_pw, str)
                    or not override_pw.strip()
                    or override_pw in ("pm123", "pm")
                ):
                    raise RuntimeError(
                        "db.password 是空值、占位符或无效类型，请在运行环境或配置文件中提供真实密码。"
                    )

                # Admin 热更新可能只提交 host/port/name/user。若本进程已经用一份
                # 有效配置启动，AppSettings() 重新读取环境变量时不会带回 override
                # 中的密码，应该保留上一份已验证的密码，避免现有连接被无效重载打坏。
                # 全新进程没有这份缓存时仍会严格拒绝缺失密码。
                db_base = self.db.model_dump()
                cached = globals().get("_settings_cache")
                cached_password = getattr(getattr(cached, "db", None), "password", "")
                if not db_base.get("password") and isinstance(cached_password, str) and cached_password.strip():
                    db_base["password"] = cached_password

                merged = {**db_base, **{
                    k: v for k, v in override_db.items()
                    if k in DatabaseSettings.model_fields
                }}
                effective_pw = merged.get("password", "")
                if (
                    not isinstance(effective_pw, str)
                    or not effective_pw.strip()
                    or effective_pw in ("pm123", "pm")
                ):
                    raise RuntimeError(
                        "db.password 未配置或仍是占位符，请在运行环境或配置文件中提供真实密码。"
                    )
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

            if "byok" in override:
                merged = {**self.byok.model_dump(), **{
                    k: v for k, v in (override["byok"] or {}).items()
                    if k in BYOKSettings.model_fields
                }}
                updates["byok"] = BYOKSettings.model_construct(**merged)

            if "sandbox" in override:
                merged = {**self.sandbox.model_dump(), **{
                    k: v for k, v in (override["sandbox"] or {}).items()
                    if k in SandboxSettings.model_fields
                }}
                updates["sandbox"] = SandboxSettings.model_construct(**merged)

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

            if "security" in override:
                merged = {**self.security.model_dump(), **{
                    k: v for k, v in (override["security"] or {}).items()
                    if k in SecuritySettings.model_fields
                }}
                updates["security"] = SecuritySettings.model_validate(merged)

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
            top_fields = set(AppSettings.model_fields) - {"db", "redis", "storage", "ai", "ai_presets", "quota", "agent", "search", "state_labels", "smtp", "security", "voice", "embedding", "sandbox", "byok"}
            for k in top_fields:
                if k in override:
                    updates[k] = override[k]

            return self.model_copy(update=updates)
        except RuntimeError:
            # 配置校验失败（缺 password 等）：不静默降级，直接挂掉让部署阶段可见
            raise
        except Exception as e:
            print(f"[config] override 加载失败: {e}")
            return self


def _deep_merge(base: dict, override: dict) -> None:
    for k, v in override.items():
        if isinstance(v, dict) and isinstance(base.get(k), dict):
            _deep_merge(base[k], v)
        else:
            base[k] = v


def write_override_json(data: dict) -> None:
    """原子写入用户运行配置，避免读到半截 JSON 或留下半写文件。"""
    OVERRIDE_FILE.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(
        prefix=f".{OVERRIDE_FILE.name}.",
        suffix=".tmp",
        dir=OVERRIDE_FILE.parent,
        text=True,
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(json.dumps(data, ensure_ascii=False, indent=2))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temp_name, 0o600)
        os.replace(temp_name, OVERRIDE_FILE)
        dir_fd = os.open(OVERRIDE_FILE.parent, os.O_DIRECTORY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
    except OSError as exc:
        # systemd ProtectSystem=strict 配合只读目录时，目标文件本身可写，
        # 但临时文件无法通过 rename 替换目标。仅对明确的 EBUSY 原位写入，
        # 其他错误继续保留原子写入的失败语义。
        if exc.errno == errno.EBUSY:
            with open(OVERRIDE_FILE, "w", encoding="utf-8") as handle:
                handle.write(json.dumps(data, ensure_ascii=False, indent=2))
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(OVERRIDE_FILE, 0o600)
            try:
                os.unlink(temp_name)
            except FileNotFoundError:
                pass
            return
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass
        raise
    except Exception:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass
        raise


# ── 配置缓存（mtime 感知，多 worker 安全）───────────────────────────────────
# 旧实现用 @lru_cache，但 lru_cache 是进程内单例——uvicorn --workers N 时，
# Worker A 写 override.json 并 cache_clear() 只清自己的缓存，Worker B 仍在用旧值。
# 改为每次读取时检查 OVERRIDE_FILE 的 mtime，文件变化即自动重建，无需跨进程通知。
_settings_cache: AppSettings | None = None
_settings_mtime: float = -1.0


def get_settings() -> AppSettings:
    global _settings_cache, _settings_mtime
    try:
        current_mtime = OVERRIDE_FILE.stat().st_mtime if OVERRIDE_FILE.exists() else -1.0
    except OSError:
        current_mtime = -1.0
    if _settings_cache is not None and current_mtime == _settings_mtime:
        return _settings_cache
    _settings_cache = AppSettings().apply_override()
    _settings_mtime = current_mtime
    return _settings_cache


def invalidate_settings_cache() -> None:
    """显式失效配置缓存（写入 override 后调用；也供 mtime 感知自动失效兜底）。"""
    global _settings_cache, _settings_mtime
    _settings_cache = None
    _settings_mtime = -1.0


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
    write_override_json(existing)
    invalidate_settings_cache()
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
