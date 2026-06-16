import type { ProviderConfig } from '../core/types.js'

// 向量嵌入服务。用 OpenAI 格式的 embeddings 接口(BGE-M3 本地或 SiliconFlow API)。
// 没配 embedding provider 时 available=false,情景检索自动降级到 FTS 关键词。
export class EmbeddingService {
  private config: ProviderConfig | null
  readonly available: boolean

  constructor(config?: ProviderConfig | null) {
    this.config = config ?? null
    this.available = !!config?.api_key && !!config?.base_url
  }

  async embed(text: string): Promise<Float32Array | null> {
    if (!this.config) return null
    const input = text.slice(0, 6000)
    try {
      const base = this.config.base_url.replace(/\/$/, '')
      const url = base.endsWith('/embeddings') ? base : `${base}/embeddings`
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.api_key}`,
        },
        body: JSON.stringify({ model: this.config.model, input }),
        signal: AbortSignal.timeout(15000),
      })
      if (!resp.ok) {
        console.error(`[embedding] HTTP ${resp.status}`)
        return null
      }
      const data = await resp.json() as { data?: Array<{ embedding?: number[] }> }
      const vec = data.data?.[0]?.embedding
      if (!Array.isArray(vec) || vec.length === 0) return null
      return Float32Array.from(vec)
    } catch (err) {
      console.error(`[embedding] ${(err as Error).message}`)
      return null
    }
  }

  // 批量嵌入:一次 HTTP 请求编码多条文本(OpenAI 格式 input 接受 string[])。
  // 语义去重用——88 条现有事实 + 几条新候选,一个请求搞定,不用逐条调 embed()
  async embedBatch(texts: string[]): Promise<(Float32Array | null)[]> {
    if (!this.config || texts.length === 0) return texts.map(() => null)
    try {
      const base = this.config.base_url.replace(/\/$/, '')
      const url = base.endsWith('/embeddings') ? base : `${base}/embeddings`
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.api_key}`,
        },
        body: JSON.stringify({ model: this.config.model, input: texts.map(t => t.slice(0, 6000)) }),
        signal: AbortSignal.timeout(30_000),
      })
      if (!resp.ok) {
        console.error(`[embedding] batch HTTP ${resp.status}`)
        return texts.map(() => null)
      }
      const data = await resp.json() as { data?: Array<{ embedding?: number[]; index: number }> }
      if (!data.data) return texts.map(() => null)
      const result: (Float32Array | null)[] = texts.map(() => null)
      for (const item of data.data) {
        if (item.embedding && item.index != null && item.index < texts.length) {
          result[item.index] = Float32Array.from(item.embedding)
        }
      }
      return result
    } catch (err) {
      console.error(`[embedding] batch: ${(err as Error).message}`)
      return texts.map(() => null)
    }
  }

  // Float32Array → Buffer(零拷贝视图,同步绑定到 SQLite 前不要改动原数组)
  static toBuffer(v: Float32Array): Buffer {
    return Buffer.from(v.buffer, v.byteOffset, v.byteLength)
  }

  // Buffer → Float32Array。slice 出独立 ArrayBuffer,保证 4 字节对齐
  static fromBuffer(b: Buffer): Float32Array {
    const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
    return new Float32Array(ab)
  }

  static cosine(a: Float32Array, b: Float32Array): number {
    // 维度不一致(换过 embedding 模型)直接判不相关：用公共前缀算会得出无意义的假高分污染检索
    if (a.length !== b.length) return 0
    let dot = 0, na = 0, nb = 0
    for (let i = 0; i < a.length; i++) {
      dot += a[i]! * b[i]!
      na += a[i]! * a[i]!
      nb += b[i]! * b[i]!
    }
    if (na === 0 || nb === 0) return 0
    return dot / (Math.sqrt(na) * Math.sqrt(nb))
  }
}
