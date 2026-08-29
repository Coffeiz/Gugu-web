"""能力注册与注入的结构化错误。"""


class CapabilityError(Exception):
    """能力索引构建失败。"""


class CapabilityRegistrationError(CapabilityError):
    """单项能力 metadata 不符合注册契约。"""


class CapabilityReferenceError(CapabilityError):
    """关联的工具或 Skill 不存在。"""
