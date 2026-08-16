/**
 * Gugu-web 对 Interaction Runtime 的唯一入口。
 *
 * 以 npm 依赖 `file:../../gugu-interaction-runtime` 引用 workspace 同级仓库的
 * 构建产物（dist-lib，由 `npm run build:lib` 生成），不再直引源码。
 * 版本基线（构建产物对应的运行时源码 commit）记录在仓库根目录 `.runtime-version`，
 * CI 与联调均读取同一份版本；更新 Runtime 时先重建产物，再同步该文件。
 * 此文件只负责模块边界，不承担任何对象、指针或视觉生命周期编排。
 */
export * from 'gugu-interaction-runtime'
