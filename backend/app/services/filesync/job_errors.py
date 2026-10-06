"""整树/导出任务执行片段的控制流异常。"""


class ProjectionSliceExpired(Exception):
    """当前执行片段预算耗尽，任务应在检查点暂停后续跑。"""
