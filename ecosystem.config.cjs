// pm2 生产配置。用法: pm2 start ecosystem.config.cjs
// 项目是 ESM + tsx 直跑,pm2 配置本身必须是 CommonJS(.cjs)。
const { resolve } = require('node:path')

module.exports = {
  apps: [
    {
      name: 'mu',
      // 指向 tsx 的 JS CLI(真 .mjs,pm2 用 node 直接跑);
      // 别指 node_modules/.bin/tsx —— 那是 sh 包装脚本,pm2 拿 node 解析它会 SyntaxError
      script: resolve(__dirname, 'node_modules/tsx/dist/cli.mjs'),
      args: 'src/mu.ts',
      cwd: __dirname,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      kill_timeout: 8000,            // 给 SIGTERM 留时间存库
      max_memory_restart: '600M',
      env: {
        NODE_ENV: 'production',
      },
      out_file: resolve(__dirname, 'data/logs/pm2-out.log'),
      error_file: resolve(__dirname, 'data/logs/pm2-err.log'),
      merge_logs: true,
      time: true,
    },
  ],
}
