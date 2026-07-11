// 版本号单一来源。曾散落 4 处(0.1.0/0.2.0 混着),发版只改这里
export const VERSION = '0.4.0'

// 部署由环境注入真实 commit/时间;本地开发保留明确的 dev/null,
// 不再让运维靠 rsync mtime 猜服务器到底跑的是哪一版。
export const REVISION = process.env.SHION_REVISION?.trim() || 'dev'
export const BUILD_TIME = process.env.SHION_BUILD_TIME?.trim() || null
