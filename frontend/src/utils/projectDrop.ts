export interface ProjectDropColumn {
  status: string
  left: number
  right: number
}

export interface ProjectDropIntent {
  pointerX: number
  pointerVelocityX: number
  isLandingRegrab: boolean
}

const THROW_SPEED = 260
const THROW_SECONDS = 0.14
const THROW_MAX_OFFSET = 220

function columnIndexAtX(columns: ProjectDropColumn[], x: number) {
  return columns.findIndex((column) => x >= column.left && x <= column.right)
}

// 状态选择是二维画面中的一维问题：每个看板列在纵向上都是完整投放区，Y 不参与判断。
// 克隆中心属于视觉弹簧，不能作为业务状态依据；否则落地途中重抓时会读到上一段动画的滞后位置。
export function resolveProjectDropStatus(columns: ProjectDropColumn[], intent: ProjectDropIntent) {
  const directIndex = columnIndexAtX(columns, intent.pointerX)
  if (directIndex < 0) return null
  if (intent.isLandingRegrab || Math.abs(intent.pointerVelocityX) < THROW_SPEED) {
    return columns[directIndex].status
  }

  const offset = Math.max(-THROW_MAX_OFFSET, Math.min(THROW_MAX_OFFSET, intent.pointerVelocityX * THROW_SECONDS))
  const predictedIndex = columnIndexAtX(columns, intent.pointerX + offset)
  if (predictedIndex < 0) return columns[directIndex].status

  // 鼠标已进入的列永远是下限：右甩只能继续向右，左甩只能继续向左，不能被预测反向拉回。
  if (intent.pointerVelocityX > 0) return columns[Math.max(directIndex, predictedIndex)].status
  return columns[Math.min(directIndex, predictedIndex)].status
}
