/**
 * 日期滑条的纯数学层。
 *
 * 这里不读 DOM、不持有 ref，也不知道拖动或动画状态；给定一条连续逻辑位置，就稳定算出
 * 每个刻度的位置与视觉强度。把它和 Pointer/弹簧拆开后，长条和文字不会再各自猜“当前状态”。
 */
export const DATE_SCRUBBER_BASE_PITCH = 9
export const DATE_SCRUBBER_CENTER_EXTRA = 8

export interface TickVisual {
  left: number
  slotOpacity: number
  barHeight: number
  barWidth: number
  barOpacity: number
  tipOpacity: number
  tipOffsetY: number
  emphasized: boolean
  emphasisAlpha: number
}

export function clampScrubberPosition(position: number, count: number): number {
  return Math.max(0, Math.min(Math.max(0, count - 1), position))
}

function smoothstep(value: number): number {
  return value * value * (3 - 2 * value)
}

/** 中心两侧更疏、其余保持紧凑；输入连续位置时输出也连续。 */
export function pitchAt(interval: number, focus: number): number {
  const distance = Math.abs(interval + 0.5 - focus)
  let extra = 0
  if (distance <= 0.5) extra = DATE_SCRUBBER_CENTER_EXTRA
  else if (distance < 1.5) extra = DATE_SCRUBBER_CENTER_EXTRA * (1 - 0.5 * smoothstep(distance - 0.5))
  else if (distance < 2.5) extra = DATE_SCRUBBER_CENTER_EXTRA * 0.5 * (1 - smoothstep(distance - 1.5))
  return DATE_SCRUBBER_BASE_PITCH + extra
}

/** 第 index 个日期的逻辑轨道 x；边缘之外继续延伸，供橡皮筋阶段使用。 */
export function positionForIndex(index: number, focus: number, count: number): number {
  if (!count) return 0
  if (index < 0) return index * pitchAt(0, focus)
  if (index > count - 1) return positionForIndex(count - 1, focus, count) + (index - (count - 1)) * pitchAt(Math.max(0, count - 2), focus)
  const lower = Math.floor(index)
  let position = 0
  for (let interval = 0; interval < lower; interval++) position += pitchAt(interval, focus)
  return position + (index - lower) * pitchAt(lower, focus)
}

/** 拖到首末日期外时的有界阻尼，不让逻辑坐标无限越界。 */
export function rubberBandPosition(raw: number, count: number): number {
  const last = count - 1
  if (raw >= 0 && raw <= last) return raw
  const distance = raw < 0 ? -raw : raw - last
  const resisted = (1 - 1 / (distance + 1)) * 0.7
  return raw < 0 ? -resisted : last + resisted
}

/** 每个日期中心是一处凹槽，拖动靠近中心时自然放慢，松手仍由状态机负责真正吸附。 */
export function detentPosition(raw: number, count: number): number {
  const banded = rubberBandPosition(raw, count)
  const last = count - 1
  if (banded < 0 || banded > last) return banded
  const lower = Math.floor(banded)
  if (lower >= last) return banded
  const progress = banded - lower
  const detent = progress * progress * progress * (progress * (progress * 6 - 15) + 10)
  return lower + detent
}

export function slotOpacity(index: number, position: number): number {
  const distance = Math.abs(index - position)
  const edge = Math.max(0, Math.min(1, (distance - 8) / 2))
  return 1 - smoothstep(edge)
}

function overshootPull(index: number, position: number, count: number): number {
  const last = count - 1
  const overshoot = position < 0 && index === 0 ? -position
    : position > last && index === last ? position - last
    : 0
  return overshoot > 0 ? Math.min(1, overshoot / 0.75) : 0
}

function baseFocus(index: number, position: number, count: number, hoveredIndex: number | null): number {
  if (hoveredIndex === index) return 1
  if ((position < 0 && index === 0) || (position > count - 1 && index === count - 1)) return 1
  const distance = Math.abs(index - position)
  return Math.exp(-distance * distance * 1.7)
}

/** 同一份输入同时给长条和文字，消除两者不同状态分支造成的闪烁。 */
export function tickVisual(index: number, position: number, count: number, hoveredIndex: number | null): TickVisual {
  const pull = overshootPull(index, position, count)
  const base = baseFocus(index, position, count, hoveredIndex)
  const focus = pull > 0 ? Math.max(0.55, base - pull * 0.35) : base
  // 条的尺寸是连续的；日期标签则是离散选中态。此前把标签也套进 focus 曲线，
  // 从首末日期往相邻日期拖时，原选中日会在尚未换日之前先掉到半透明。
  const selectedIndex = Math.round(clampScrubberPosition(position, count))
  const labelIndex = hoveredIndex ?? selectedIndex
  const isSelected = index === selectedIndex
  const tipAlpha = index === labelIndex ? 1 : 0
  const fade = slotOpacity(index, position)
  return {
    left: positionForIndex(index, position, count),
    slotOpacity: fade,
    barHeight: 10 + focus * 12,
    barWidth: 3 + focus * 1.5,
    // 选中条与选中文字共用边缘拉伸时的主色 alpha，视觉上是一组而不是两套反馈。
    barOpacity: (isSelected ? 1 - pull * 0.35 : 0.25 + focus * 0.75) * fade,
    tipOpacity: tipAlpha * fade,
    tipOffsetY: pull > 0 ? -(1 - focus) * 12 : 0,
    // 当前选中日即使在边缘橡皮筋里缩短，也保持主色；不能随着 focus 跨过阈值突然降成次级灰。
    emphasized: isSelected || focus > 0.82,
    // 边缘阻尼时仍保留主色，只连续降低主色自身 alpha；不切换到次级灰。
    emphasisAlpha: isSelected ? 1 - pull * 0.35 : 1,
  }
}
