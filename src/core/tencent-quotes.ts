export async function fetchTencentPrices(codes: string[], fetchImpl: typeof fetch = fetch): Promise<Map<string, number>> {
  const quotes = await fetchTencentQuotePoints(codes, fetchImpl)
  return new Map([...quotes].map(([code, quote]) => [code, quote.price]))
}

export interface QuotePoint {
  price: number
  asOf: string
  name?: string
  peTtm?: number
  pb?: number
  marketCapYi?: number
  sources?: string[]
}

export async function fetchTencentQuotePoints(codes: string[], fetchImpl: typeof fetch = fetch): Promise<Map<string, QuotePoint>> {
  const symbols = [...new Set(codes)].flatMap(code => {
    if (/^(?:sh|sz|bj)\d{6}$/i.test(code)) return [code.toLowerCase()]
    if (!/^\d{6}$/.test(code)) return []
    return [`${code.startsWith('6') || code.startsWith('9') ? 'sh' : code.startsWith('8') || code.startsWith('4') ? 'bj' : 'sz'}${code}`]
  })
  if (symbols.length === 0) return new Map()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5_000)
  try {
    const response = await fetchImpl(`https://qt.gtimg.cn/q=${symbols.join(',')}`, { signal: controller.signal })
    if (!response.ok) throw new Error(`Tencent quote HTTP ${response.status}`)
    return parseTencentQuotePoints(new TextDecoder('gbk').decode(await response.arrayBuffer()))
  } finally { clearTimeout(timer) }
}

export function parseTencentPrices(body: string): Map<string, number> {
  return new Map([...parseTencentQuotePoints(body)].map(([code, quote]) => [code, quote.price]))
}

export function parseTencentQuotePoints(body: string): Map<string, QuotePoint> {
  const prices = new Map<string, QuotePoint>()
  for (const line of body.split(';')) {
    const match = line.match(/v_(?:sh|sz|bj)(\d{6})="([\s\S]*)"/)
    if (!match) continue
    const fields = match[2]!.split('~')
    const price = Number(fields[3])
    const timestamp = fields[30] ?? ''
    const asOf = parseTencentTimestamp(timestamp)
    if (Number.isFinite(price) && price > 0 && asOf) {
      const optionalPositive = (value: string | undefined) => {
        const number = Number(value)
        return Number.isFinite(number) && number > 0 ? number : undefined
      }
      prices.set(match[1]!, {
        price, asOf, sources: ['tencent'],
        ...(fields[1]?.trim() ? { name: fields[1].trim() } : {}),
        ...(optionalPositive(fields[39]) === undefined ? {} : { peTtm: optionalPositive(fields[39]) }),
        ...(optionalPositive(fields[46]) === undefined ? {} : { pb: optionalPositive(fields[46]) }),
        ...(optionalPositive(fields[44]) === undefined ? {} : { marketCapYi: optionalPositive(fields[44]) }),
      })
    }
  }
  return prices
}

function parseTencentTimestamp(value: string): string | null {
  if (!/^\d{14}$/.test(value)) return null
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(8, 10)}:${value.slice(10, 12)}:${value.slice(12, 14)}+08:00`
  const time = new Date(iso)
  return Number.isFinite(time.getTime()) ? time.toISOString() : null
}
