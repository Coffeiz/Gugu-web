/** 便签兼容入口；引用补全状态统一由 useReferenceSuggest 提供。 */
import { useReferenceSuggest } from './useReferenceSuggest'

export function useMindObjectPicker(delay = 180) {
  return useReferenceSuggest(delay)
}
