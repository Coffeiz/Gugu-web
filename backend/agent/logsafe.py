"""聊天日志安全打印：分级脱敏（商用就绪 P0-5 后续）。

IM 网关/worker 的收发日志此前直接打印消息原文前若干字符（qq.py/feishu.py/wechat.py 收到、
worker.py 回复全文不截断），今天新增的后台 Debug 面板（可搜索、好查阅）把这个老问题放大暴露
了——聊天内容敏感度高于工具参数（可能涉及健康/感情/工作机密），且与项目已有的脱敏红线（决策
轨迹脱敏、agent.traj 参数脱敏、工具错误信息脱敏）不一致。

分级（第 0/1 层，日常默认生效，本模块提供）：
- 长度：`len(text)`，调用方自己拼——覆盖「空不空」。
- 指纹 `fingerprint()`：md5 前 8 位，不可逆，只能判断「是不是同一条」，看不出内容本身——
  覆盖「是否被重复处理/防抖生效没」这类幂等性排查。

第 2 层（管理员显式开、带时限的临时明文窗口）尚未实现，需要时再评估：后台配置项 + 到期
自动失效 + 审计日志留痕，不做成默认行为。
"""
from __future__ import annotations

import hashlib


def fingerprint(text: str) -> str:
    """内容指纹：md5 前 8 位，供日志判断「是不是同一条」，看不出内容本身。空串返回空串。"""
    if not text:
        return ""
    return hashlib.md5(text.encode("utf-8")).hexdigest()[:8]
