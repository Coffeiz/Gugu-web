import { powerMonitor, powerSaveBlocker } from 'electron'

export function createGatewayPowerPolicy(shouldStayAwake: () => boolean) {
  let blocker: number | undefined

  function release() {
    if (blocker !== undefined) powerSaveBlocker.stop(blocker)
    blocker = undefined
  }

  function update() {
    if (!shouldStayAwake() || powerMonitor.isOnBatteryPower()) {
      release()
      return
    }
    if (blocker !== undefined) return
    blocker = powerSaveBlocker.start('prevent-app-suspension')
  }

  powerMonitor.on('on-ac', update)
  powerMonitor.on('on-battery', release)
  return {
    update,
    release,
    close() {
      powerMonitor.off('on-ac', update)
      powerMonitor.off('on-battery', release)
      release()
    },
  }
}
