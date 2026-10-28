"""媒体输入校验错误，供工具层返回明确且安全的失败原因。"""


class MediaPreflightError(ValueError):
    """媒体在发送到 Provider 前未通过可验证的输入规格校验。"""
