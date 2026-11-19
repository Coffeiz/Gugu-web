import type { FileHandle } from 'node:fs/promises'

export interface HistoryPosition {
  file: string
  end: number
}

export function readLogHistory(path: string, options: {
  cursor?: HistoryPosition | number | null
  lines: number
  query?: string
}): Promise<{ lines: { time: Date; line: string }[]; next: HistoryPosition | null }>

export const ansi: RegExp
export const epoch: Date
export function openLog(path: string): Promise<FileHandle>
export function fileIdentity(info: { dev: number; ino: number }): string
export function lineDate(line: string, carried: Date): Date
export function formatTime(date: Date): string
