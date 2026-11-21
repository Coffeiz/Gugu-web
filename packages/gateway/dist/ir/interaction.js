import { parseGatewayInteraction } from '../interaction.js';
/** 原生回调里的会话仍是待核对事实，由宿主对照已投递卡片，再授权执行。 */
export function readImReceivedInteraction(connection, platform, data) {
    if (!connection.ownerId || !connection.botId || connection.platform !== platform
        || (platform === 'feishu' && (data.ownerId !== connection.ownerId || data.botId !== connection.botId)))
        throw new Error('IM 回调与连接范围不匹配');
    return Object.freeze({
        version: 1, kind: 'interaction.received',
        connection: Object.freeze({ ...connection }),
        action: Object.freeze(parseGatewayInteraction(platform, data)),
    });
}
/** 核对已投递提示的范围。动作令牌和单次消费仍由持久交互端口验证。 */
export function matchesImInteractionScope(event, scope) {
    const { connection, action } = event;
    return connection.ownerId === scope.ownerId && connection.botId === scope.botId
        && connection.platform === scope.platform && (!action.chatType || action.chatType === scope.chatType)
        && (scope.chatType === 'group' ? action.chatId === scope.chatId : action.operator === scope.platformUserId);
}
