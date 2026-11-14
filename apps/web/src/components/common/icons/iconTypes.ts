import type { Component } from 'vue'

export const iconSizes = {
  xs: 'var(--icon-size-xs)',
  sm: 'var(--icon-size-sm)',
  md: 'var(--icon-size-md)',
  lg: 'var(--icon-size-lg)',
} as const

export type IconSize = keyof typeof iconSizes
export type IconSizeValue = IconSize | string | number
export type IconTone = 'default' | 'muted' | 'active' | 'danger' | 'inherit'

export type IconComponent = Component
