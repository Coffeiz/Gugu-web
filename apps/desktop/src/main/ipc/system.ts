import { DESKTOP_CHANNELS } from '@gugu/core/desktop'
import type { IpcHost, IpcHandlers } from './types.js'

export function systemHandlers(host: IpcHost): IpcHandlers {
  return {
    [DESKTOP_CHANNELS.appearance]: () => host.request('preferences.desktop.get'),
    [DESKTOP_CHANNELS.updateAppearance]: (patch: unknown) => host.request('preferences.desktop.update', { patch }),
    [DESKTOP_CHANNELS.onboarding]: () => host.request('onboarding.desktop.get'),
  }
}
