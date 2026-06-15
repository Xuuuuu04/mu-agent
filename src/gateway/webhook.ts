// Barrel:HTTP 网关拆到 webhook/ 子目录,这里聚合导出保持旧 import 路径(mu.ts 零改动)。
// 拆分:gateway(瘦壳)+ pending-window(110s 同步窗口)+ outbox(待发件)+
//       admin-api(面板 API)+ static-server(静态服务)+ http-utils。
export { WebhookGateway, type WebhookOpts } from './webhook/gateway.js'
