"""项目预设色板：唯一数据源。

网页创建/编辑弹窗、咕咕的 create_project/set_color 工具、写入校验层
（`app.core.projects.prepare_project_update`）都从这里引用，不再各自
维护一份色值列表——历史上四份副本（两处前端弹窗、Store 兜底默认值、
咕咕工具自己的 `_COLOR_PRESETS`）各自独立硬编码，其中 `set_color` 工具
的 JSON schema 描述还错误地写成"十六进制"，导致模型可能传入渐变格式
之外、也不在预设色板内的颜色值，且后端当时完全不校验，直接写库。
"""

PROJECT_COLOR_PRESETS: tuple[str, ...] = (
    "linear-gradient(135deg,#c8aa72,#b88060)",
    "linear-gradient(135deg,#8fbe8b,#7ab8a8)",
    "linear-gradient(135deg,#7ab8a8,#7ab8c8)",
    "linear-gradient(135deg,#7ab8c8,#7b7fb2)",
    "linear-gradient(135deg,#5e73b2,#7b7fb2)",
    "linear-gradient(135deg,#7b7fb2,#c4afc8)",
    "linear-gradient(135deg,#c4afc8,#b07090)",
    "linear-gradient(135deg,#be8b8f,#c8aa72)",
)

DEFAULT_PROJECT_COLOR = PROJECT_COLOR_PRESETS[5]
