export const IM_DELIVERY_PLATFORMS = ['qq', 'feishu', 'telegram'] as const

export type ImDeliveryPlatform = typeof IM_DELIVERY_PLATFORMS[number]
export interface ImDeliveryGroup { chat_id: string; title: string }
export interface ImTargetOption { value: string; label: string }
export type ImDeliveryConfig = { mode: 'private' } | { mode: 'group'; chat_id: string }

export function buildImTargetOptions(
  groups: ImDeliveryGroup[],
  selectedTarget: string,
  privateLabel: string,
  unavailableGroupLabel: (chatId: string) => string,
): ImTargetOption[] {
  const options: ImTargetOption[] = [
    { value: 'private', label: privateLabel },
    ...groups.map(group => ({ value: group.chat_id, label: group.title })),
  ]
  if (selectedTarget !== 'private' && !groups.some(group => group.chat_id === selectedTarget)) {
    options.push({ value: selectedTarget, label: unavailableGroupLabel(selectedTarget) })
  }
  return options
}

/** 仅提交用户实际修改的 IM 目标，避免普通编辑把已有群提醒改回私聊。 */
export function buildImDeliveryFields(
  isEditing: boolean,
  initialTargets: Record<string, string>,
  selectedTargets: Record<string, string>,
  activeChannels: string[],
): { im_delivery?: Partial<Record<ImDeliveryPlatform, ImDeliveryConfig>> } {
  const delivery: Partial<Record<ImDeliveryPlatform, ImDeliveryConfig>> = {}
  for (const platform of IM_DELIVERY_PLATFORMS) {
    if (!activeChannels.includes(platform)) continue
    const selected = selectedTargets[platform] || 'private'
    if (isEditing && selected === (initialTargets[platform] || 'private')) continue
    delivery[platform] = selected === 'private'
      ? { mode: 'private' }
      : { mode: 'group', chat_id: selected }
  }
  return Object.keys(delivery).length ? { im_delivery: delivery } : {}
}
