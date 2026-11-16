export type MermaidSourceOptions = { forRasterizer?: boolean }

export function normalizeMermaidDiagramSource(
  source: string,
  options?: MermaidSourceOptions,
): string

export function prepareMermaidDiagramSource(
  source: string,
  options?: MermaidSourceOptions,
): { source: string; labels: Record<string, string> }

export function restoreMermaidDiagramLabels(
  root: Element,
  labels?: Record<string, string>,
): void
