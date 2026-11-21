import { type ImChartRenderer } from '../../runtime/chart-parser.js';
import type { QqProjectionOptions } from './persistent.js';
import type { createQqSender, QqReceipt, QqTarget } from './sender.js';
import { type createQqMediaUploader } from './media-upload.js';
/** 预读只准备 PNG。平台操作仍由持久投影按事件顺序执行。 */
export declare function createQqChartPreparation(authorize: () => Promise<boolean>, render: ImChartRenderer, send: (png: Uint8Array) => Promise<QqReceipt>): NonNullable<QqProjectionOptions['charts']>;
/** 上传成功只取得媒体凭据，仍以消息发送回执确定是否已投递。 */
export declare function sendQqChart(options: {
    png: Uint8Array;
    target: QqTarget;
    uploader: Pick<ReturnType<typeof createQqMediaUploader>, 'upload'>;
    sender: Pick<ReturnType<typeof createQqSender>, 'media'>;
    authorize(): Promise<boolean>;
    signal?: AbortSignal;
}): Promise<QqReceipt>;
