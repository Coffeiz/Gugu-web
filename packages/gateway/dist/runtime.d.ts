import { type GatewayBotSpec, type GatewaySupervisorPorts } from './contracts.js';
export declare function createGatewaySupervisor<S extends GatewayBotSpec>(ports: GatewaySupervisorPorts<S>): {
    start(): Promise<void>;
    /** 等待目前已排队的配置对账，供健康检查/受控测试使用。 */
    settled: () => Promise<void>;
    /** Host提交后的配置/绑定失效沿同一串行全量对账处理。 */
    refresh: () => void;
    onConfigurationChanged(listener: () => void): void;
    suspend(): Promise<void>;
    /** 睡眠前的长连接可能仍显示在线，重新对账并排空旧连接后再启动。 */
    resume(): Promise<void>;
    status: () => {
        running: number;
        retrying: number;
        stopping: boolean;
    };
    /** 固定状态及计数；不公开Bot标识、配置版本、凭据或底层异常。 */
    health: () => {
        configuration: "unknown" | "ready" | "unavailable";
        notifications: "connecting" | "connected" | "disconnected" | "stopped";
        configured: number;
        running: number;
        cleanupUnknown: number;
        retrying: number;
        stopping: boolean;
    };
    stop(): Promise<void>;
};
