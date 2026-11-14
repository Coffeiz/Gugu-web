export interface TestSuite {
  file: string
  markers: string[]
  layer: 'L0' | 'L1' | 'L2'
  purpose: 'contract' | 'ipc' | 'postgres' | 'parity'
}
export const coreRoot: string
export function testSuites(suite: string): TestSuite[]
