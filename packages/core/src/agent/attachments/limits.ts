/**
 * 附件与文件库单文件上限。
 *
 * 历史背景：桌面端早期把这个值设为 32 MB，因为渲染进程 → 主进程的整块 IPC
 * 传输会一次性占用同等量级内存。后来 IM 入站改成流式落盘后，32 MB 已不再是
 * 技术上限，但数值残留在附件准入、文件库保存、预览与文本读取等多处业务判断里，
 * 造成「IM 能收、文件库不能存」的不一致。这里统一为单一来源，取 100 MB
 * （与 IM 入站单文件预算一致，暂不再上调）。
 *
 * 注意：整块字节路径（Uint8Array 经 IPC）的内存开销与文件大小同阶，优先走
 * writeDesktopAgentAttachmentFromPath 之类的流式落盘路径。
 */
export const ATTACHMENT_MAX_BYTES = 100 * 1024 * 1024
export const ATTACHMENT_MAX_LABEL = '100 MB'
