/**
 * Gugu-web 对 Interaction Runtime 的唯一源码入口。
 *
 * 联调阶段直接引用同级仓库源码，避免 npm 构建产物、Vite 解析与实际运行版本漂移。
 * 当前联调基线记录在仓库根目录 `.runtime-version`，CI 与联调文档均读取同一份版本。
 * 更新 Runtime 时只需修改该文件，并在 PR 中记录两侧 commit，避免源码漂移。
 * 此文件只负责模块边界，不承担任何对象、指针或视觉生命周期编排。
 */
export * from '../../../../../gugu-interaction-runtime/src/index'
