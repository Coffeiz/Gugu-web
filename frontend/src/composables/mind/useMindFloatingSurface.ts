import { useSurface, type UseSurfaceOptions, type UseSurfaceResult } from '@/interaction/runtime/vue'

/**
 * 画布抽屉唯一的浮动 Surface 适配边界。
 *
 * 普通业务 Surface 直接使用 Runtime Core API；抽屉额外需要自然高度、滚动视口和
 * 展开/收起 resize 事务，这些职责由 Runtime 的 floating Surface 实现统一维护。
 * Mind 页面只通过这个窄适配入口声明语义，不再直接依赖通用 Vue composable。
 */
export type MindFloatingSurfaceOptions = Omit<UseSurfaceOptions, 'floating'> & {
  floating: NonNullable<UseSurfaceOptions['floating']>
}

export function useMindFloatingSurface(options: MindFloatingSurfaceOptions): UseSurfaceResult {
  return useSurface(options)
}
