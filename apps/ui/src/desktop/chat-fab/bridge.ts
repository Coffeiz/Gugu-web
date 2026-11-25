import type { DesktopReply } from '@gugu/core/desktop'

export type DroppedReferenceReply = DesktopReply<{ type: 'file'; id: string; label: string }>

export type PanelBounds = { x: number; y: number; width: number; height: number }
export type PanelGeometry =
  | { id: number; from: PanelBounds; target: PanelBounds; frame: PanelBounds; duration: number; settled?: false }
  | { id: number; target: PanelBounds; frame: PanelBounds; settled: true; reframe?: boolean }

type Gesture = 'down' | 'move' | 'up' | 'cancel' | 'open' | 'ready'

const desktop = window as Window & {
  guguChatFab?: { gesture: (gesture: Gesture, x?: number, y?: number) => void; onMaterial: (listener: (glass: boolean) => void) => () => void }
  guguChatFabHost?: {
    onPanelDetached: (listener: (detached: boolean) => void) => () => void
    onPanelGeometry: (listener: (geometry: PanelGeometry) => void) => () => void
    panelGeometryDone: (id: number) => void
    setExpanded: (expanded: boolean) => void
    panelReady: () => void
    panelEntered: () => void
    panelClosing: () => void
    panelClose: () => void
    onDroppedReference: (listener: (reply: DroppedReferenceReply) => void) => () => void
    onCloseChat: (listener: (animated: boolean) => void) => () => void
    setChatVisible: (visible: boolean) => void
    attach: () => Promise<boolean>
    onOpenChat: (listener: () => void) => () => void
    setReferenceDrag: (active: boolean) => void
  }
}

export const chatFab = desktop.guguChatFab
export const chatFabHost = desktop.guguChatFabHost
