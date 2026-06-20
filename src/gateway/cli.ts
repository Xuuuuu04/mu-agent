import { VERSION } from '../version.js'
import { createInterface } from 'node:readline'
import type { IncomingMessage, GatewayAdapter, OutgoingMessage } from '../core/types.js'

export class CLIGateway implements GatewayAdapter {
  name = 'cli'
  private rl: ReturnType<typeof createInterface> | null = null
  private handler: ((msg: IncomingMessage) => void) | null = null
  private clearHandler: (() => void) | null = null
  private statusProvider: (() => string) | null = null
  private waitingForResponse = false

  async connect(): Promise<void> {
    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: process.stdin.isTTY ?? false,
    })

    this.rl.on('close', () => {
      if (process.stdin.isTTY) {
        console.log('\n再见')
        process.exit(0)
      }
    })
  }

  async disconnect(): Promise<void> {
    this.rl?.close()
    this.rl = null
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.handler = handler
  }

  onClear(handler: () => void): void {
    this.clearHandler = handler
  }

  onStatus(provider: () => string): void {
    this.statusProvider = provider
  }

  async send(msg: OutgoingMessage): Promise<void> {
    for (const content of msg.content) {
      if (content.type === 'text') {
        console.log(`\n沐: ${content.text}`)
      }
    }
    this.waitingForResponse = false
  }

  startInteractive(onResponse?: () => void): void {
    if (!this.rl || !this.handler) return

    console.log(`沐 v${VERSION} — CLI 模式`)
    console.log('输入消息开始对话。/quit 退出,/clear 清空会话')
    console.log('---')

    this.rl.on('line', (input) => {
      const trimmed = input.trim()
      if (!trimmed) return

      if (trimmed === '/quit' || trimmed === '/exit') {
        console.log('\n再见')
        process.exit(0)
      }

      if (trimmed === '/status') {
        console.log('\n' + (this.statusProvider?.() ?? '[无状态信息]'))
        return
      }

      if (trimmed === '/clear') {
        this.clearHandler?.()
        console.log('\n[会话已清空]')
        return
      }

      if (this.waitingForResponse) {
        console.log('  (等一下,正在思考...)')
        return
      }

      this.waitingForResponse = true
      this.handler!({
        id: `cli-${Date.now()}`,
        source: 'cli',
        chat_type: 'private',
        sender: { id: 'user', name: '用户' },
        content: { type: 'text', text: trimmed },
        timestamp: Date.now(),
      })
    })
  }
}
