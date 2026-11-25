import { type ImConnectionIdentity, type ImReceivedMessage } from '../ir/inbound.js';
export type ImInboundReceipt = {
    status: 'queued' | 'recorded' | 'duplicate' | 'ignored';
};
/** 由宿主实现收件写入，并依据写入结果返回回执。失败或提交状态未知时抛出异常。 */
export interface ImInboundStore {
    recordInbound(event: ImReceivedMessage): Promise<ImInboundReceipt>;
}
/** 接收已完成平台解析的事件，在写入前核对可信连接身份。 */
export declare function receiveMessage(connection: ImConnectionIdentity, event: ImReceivedMessage, store: ImInboundStore): Promise<ImInboundReceipt>;
/** 领取凭据由本地存储生成。确认必须仍绑定该领取，失败则保留原事件供恢复。 */
export interface ImInboundConsumption<ClaimArgs extends unknown[], Claim, SettleArgs extends unknown[], Settled> {
    claimInbound(...args: ClaimArgs): Promise<Claim>;
    settleInbound(...args: SettleArgs): Promise<Settled>;
}
