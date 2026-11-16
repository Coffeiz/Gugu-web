export function normalizeMermaidRasterColors(root: Element): void
export function normalizeMermaidStateDiagramLabelAlignment(root: Element): void
export function normalizeMermaidRasterTextContrast(root: Element, defaultTextColor: string): void
export function normalizeMermaidEdgeStyles(root: Element, arrowheadColor: string): Element
export function normalizeMermaidNodeCorners(root: Element): void
export function normalizeMermaidMindmapRootLabel(root: Element): void
export function normalizeMermaidKanbanSectionTitles(root: Element): void
export function normalizeMermaidKanbanSectionColors(root: Element): void
export function normalizeMermaidTimelineSectionColors(root: Element): void
export function normalizeMermaidDatabaseLabelPosition(root: Element, options?: { rasterizer?: boolean }): void
export function normalizeMermaidEdgeLabelBounds(root: Element): void
export function normalizeMermaidRasterText(root: Element, textColor: string, options?: {
  allText?: boolean
  fontFamily?: string
  fontWeight?: number
  strokeWidth?: string
  colorAllText?: boolean
  strokeAllText?: boolean
}): void
