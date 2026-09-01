import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi, afterEach } from 'vitest'
import { NacosConfigClient, contentMd5 } from '../src/core.ts'

const dirs: string[] = []
afterEach(() => { dirs.length = 0 })

function newCacheDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nacos-cache-'))
  dirs.push(dir)
  return dir
}

function clientWith(cacheDir: string, failing: boolean, yamlContent?: string): NacosConfigClient {
  const fetchImpl = vi.fn().mockImplementation(async (url: string | URL) => {
    if (failing) throw new Error('connect timeout')
    if (String(url).includes('/v3/auth/user/login')) {
      return new Response(JSON.stringify({ accessToken: 't' }), { status: 200 })
    }
    const payload = { code: 0, data: { content: yamlContent ?? 'window:\n  maxMessages: 40', md5: 'm' } }
    return new Response(JSON.stringify(payload), { status: 200 })
  })
  return new NacosConfigClient(
    { server: 'http://nacos.test', cacheDir, username: 'n', password: 'p' },
    fetchImpl as unknown as typeof fetch,
  )
}

describe('配置磁盘缓存（审查任务 1.2）', () => {
  it('first boot without disk cache still serves from Nacos and persists to disk', async () => {
    const dir = newCacheDir()
    const client = clientWith(dir, false, 'window:\n  maxMessages: 40')
    const parsed = await client.fetchConfig<any>('dsh-context.yaml')
    expect(parsed?.window?.maxMessages).toBe(40)
    const yamlPath = join(dir, 'dsh', 'DEFAULT_GROUP', 'dsh-context.yaml.yaml')
    expect(existsSync(yamlPath)).toBe(true)
    expect(existsSync(yamlPath + '.md5')).toBe(true)
  })

  it('degrades to the disk cache when Nacos is unavailable', async () => {
    const dir = newCacheDir()
    const warm = clientWith(dir, false, 'window:\n  maxMessages: 40')
    await warm.fetchConfig('dsh-context.yaml')
    const degraded = clientWith(dir, true)
    const parsed = await degraded.fetchConfig<any>('dsh-context.yaml')
    expect(parsed?.window?.maxMessages).toBe(40)
  })

  it('disk md5 matches the cached content', async () => {
    const dir = newCacheDir()
    const content = 'a: 1\nb: 2'
    const client = clientWith(dir, false, content)
    await client.fetchConfig('dsh-context.yaml')
    const md5Path = join(dir, 'dsh', 'DEFAULT_GROUP', 'dsh-context.yaml.yaml.md5')
    expect(readFileSync(md5Path, 'utf8').trim()).toBe(contentMd5(content))
  })
})
