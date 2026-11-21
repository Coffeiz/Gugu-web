import { formatImToolStatus, resolveImToolLabel } from '@gugu/core/im/run-delivery';
/** 展示已提交的工具状态。只读取明确允许展示的投递状态，不输出工具参数或原始结果。 */
export function formatImToolReceipt(event, sanitize) {
    const succeeded = event.status === 'success' || event.status === 'ok';
    if (event.name === 'send_file') {
        let result = event.result;
        if (typeof result === 'string') {
            try {
                result = JSON.parse(result);
            }
            catch {
                result = null;
            }
        }
        const delivery = result && typeof result === 'object' && 'delivery_status' in result ? result.delivery_status : null;
        if (delivery === 'sent')
            return '✅ 平台已接受文件发送';
        if (delivery === 'unknown')
            return '⚠️ 文件发送结果未确认，请先检查是否收到';
        if (delivery === 'failed')
            return '⚠️ 文件未能发送，请检查原因后重新发起请求';
        if (succeeded)
            return '📎 文件已准备，将在回复结束后尝试发送';
    }
    return formatImToolStatus(resolveImToolLabel(event.name, event.display, event.label), event.status, sanitize);
}
