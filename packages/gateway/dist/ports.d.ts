/** 游标推进与可投递消息必须原子提交。空载荷只推进游标。 */
export interface GatewayInbox {
    cursor(): Promise<number | null>;
    commit(updateId: number, payload: Record<string, unknown> | null): Promise<void>;
}
export interface GatewayPairingStore {
    get(key: string): Promise<string | null>;
    saveIfAbsent(key: string, value: string, seconds: number): Promise<boolean>;
    delete(key: string): Promise<void>;
}
