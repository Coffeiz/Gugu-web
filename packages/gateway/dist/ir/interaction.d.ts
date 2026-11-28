import { parseGatewayInteraction } from '../interaction.js';
import type { ImConnectionIdentity } from './inbound.js';
export interface ImReceivedInteraction {
    readonly version: 1;
    readonly kind: 'interaction.received';
    readonly connection: ImConnectionIdentity;
    readonly action: Readonly<ReturnType<typeof parseGatewayInteraction>>;
}
/** 原生回调里的会话仍是待核对事实，由宿主对照已投递卡片，再授权执行。 */
export declare function readImReceivedInteraction(connection: ImConnectionIdentity, platform: string, data: Record<string, unknown>): ImReceivedInteraction;
/** 核对已投递提示的范围。动作令牌和单次消费仍由持久交互端口验证。 */
export declare function matchesImInteractionScope(event: ImReceivedInteraction, scope: import('./inbound.js').ImConversationScope): boolean;
