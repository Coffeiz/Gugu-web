/** 首次连接尚未交付，但底层资源释放未知；不能按普通握手失败启动替代消费者。 */
export class GatewayConnectionCleanupError extends Error {
    constructor() { super('网关初始连接资源清理未完成'); }
}
