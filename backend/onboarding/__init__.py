"""新手引导独立子系统（backend/onboarding/，与 agent/、app/ 平级）。

不依赖 agent；只用 app 的共享基础设施（db / models / storage / events）。
设计见 docs/新手引导-实现方案.md。
"""
from onboarding import models  # noqa: F401  # 让 Base.metadata 注册 OnboardingState 表
