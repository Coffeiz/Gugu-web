import { parseImReceivedMessage } from '../ir/inbound.js';
/** 接收已完成平台解析的事件，在写入前核对可信连接身份。 */
export function receiveMessage(connection, event, store) {
    return store.recordInbound(parseImReceivedMessage(connection, event));
}
