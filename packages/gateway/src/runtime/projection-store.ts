export interface ImPlatformProjectionStore {
  readonly platform?: 'feishu' | 'qq' | 'telegram'
  read(): Promise<{ version: number; state: unknown | null }>
  checkpoint(expectedVersion: number, state: unknown): Promise<number>
  /** 接受回执与投递检查点由宿主原子提交。 */
  accepted(key: string, expectedVersion: number, state: unknown): Promise<number>
}
