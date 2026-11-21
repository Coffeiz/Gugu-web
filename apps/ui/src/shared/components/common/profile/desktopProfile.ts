import { inject, type InjectionKey } from 'vue'

export const desktopProfileKey: InjectionKey<boolean> = Symbol('desktopProfile')

export function useDesktopProfile() {
  return inject(desktopProfileKey, false)
}
