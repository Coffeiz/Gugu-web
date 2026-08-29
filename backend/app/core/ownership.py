"""所有权强制查询层——多用户隔离的机制化兜底。

背景（商用就绪评审 P0-2）：此前隔离靠每个工具 handler 手写「db.get() 裸主键查询 +
if obj.user_id != user_id」，属约定而非机制——少写一行 if 就是越权漏洞，且「归属不符」
和「行不存在」混在同一句错误里，无法被运维感知。本模块把这层判断收敛成唯一入口：

- **业务代码禁止再裸调 db.get() 取有归属的行**，一律走 get_owned()。
  `scripts/check_ownership.py` 静态守卫强制此规则（agent/tools/ 下裸 db.get 直接报错；
  确无归属语义的例外行加 `# ownership-exempt` 标记）。
- 对调用方，「不存在」与「存在但不属于你」是同一个结果（None）——错误文案统一
  「不存在」，不向模型/用户泄露「存在但不是你的」（防资源枚举）。
- 对内部，两者日志不同：归属不符会以 `ownership.denied` 记一条结构化 WARNING——
  这是运行时越权检测的信号源。正常业务几乎不会触发（模型手里的 id 都来自本人
  查询结果），出现即意味着模型幻觉了别人的 id、或有人在探测，值得被看见。
"""
from __future__ import annotations

import logging

from app.security.events import record_ownership_denied, security_fingerprint

_log = logging.getLogger("ownership")


async def get_owned(db, model, obj_id, user_id):
    """按主键取 model 的一行并强制校验归属。

    返回该行对象；行不存在、obj_id 为空、或行不属于 user_id 时一律返回 None
    （调用方按「不存在」处理即可）。model 必须带 user_id 列。
    比较用 str() 归一两侧——user_id 在不同调用路径下可能是 UUID 对象或字符串。
    """
    if obj_id is None:
        return None
    obj = await db.get(model, obj_id)
    if obj is None:
        return None
    owner = getattr(obj, "user_id", None)
    if str(owner) != str(user_id):
        _log.warning(
            "ownership.denied model=%s resource=%s owner=%s requester=%s",
            model.__name__, security_fingerprint(obj_id)[:16],
            security_fingerprint(owner)[:16] if owner is not None else None,
            security_fingerprint(user_id)[:16],
        )
        try:
            await record_ownership_denied(
                requester_id=user_id,
                model=model,
                resource_id=obj_id,
                owner_id=owner,
            )
        except Exception:
            # 安全事件写入故障不能改变授权失败的统一响应，也不记录原始字段。
            try:
                from app.core import opsmetrics
                opsmetrics.record_security("security_event.write_failed")
            except Exception:
                pass
        try:
            from app.security.risk_policy import register_ownership_denial
            await register_ownership_denial(user_id=user_id)
        except Exception:
            # Redis 仅用于短窗口策略，故障时继续保持原有授权拒绝语义。
            pass
        try:
            from app.core import opsmetrics
            opsmetrics.record_security("ownership.denied")
        except Exception:
            pass
        return None
    return obj
