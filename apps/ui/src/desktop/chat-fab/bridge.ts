import type { ChatReference } from '@/components/common/gugu-chat/chatTypes'
import type { DesktopReply } from '@gugu/core/desktop'

export type DroppedReferenceReply = DesktopReply<{ type: 'file' | 'folder'; id: string; label: string }>

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
    dropReferences: (references: readonly ChatReference[]) => void
    onDroppedReferences: (listener: (references: ChatReference[]) => void) => () => void
    onDroppedReference: (listener: (reply: DroppedReferenceReply) => void) => () => void
    onCloseChat: (listener: (animated: boolean) => void) => () => void
    setChatVisible: (visible: boolean) => void
    attach: () => Promise<boolean>
    openMainReference: (type: ChatReference['type'], id: ChatReference['id']) => Promise<DesktopReply<null>>
    onOpenMainReference: (listener: (type: ChatReference['type'], id: ChatReference['id']) => void) => () => void
    onOpenChat: (listener: () => void) => () => void
    dragDockedBall: (action: Gesture, x: number, y: number) => void
    onBallDetached: (listener: (detached: boolean) => void) => () => void
  }
}

export const chatFab = desktop.guguChatFab
export const chatFabHost = desktop.guguChatFabHost
