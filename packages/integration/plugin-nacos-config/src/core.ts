/**
 * Nacos configuration client (dsh.docx: dsh(PC) ←配置拉取→ Nacos).
 *
 * Pulls the six `dsh-*.yaml` Data IDs, keeps a local cache, and re-polls on an
 * interval (long-poll listener semantic). Also resolves the skill-package
 * registry (dsh-skills.yaml) and downloads skill bundles into a local cache
 * directory when their version/gray status changes.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'

export interface NacosConfigClientOptions {
  /** Nacos v3 控制台地址（API 与控制台同端口），e.g. http://nacos.internal:18480 */
  server: string
  /**
   * 认证模式：`oidc`（默认，Nacos auth system=oidc 时唯一可用——本地账密登录已禁用，
   * 用 Kestra OIDC 的 client_credentials 票据）或 `local`（传统 nacos 账密登录）。
   */
  auth?: 'oidc' | 'local'
  /** auth=oidc：Kestra OIDC token 端点（容器内 http://kestra:8080/oidc/token）。 */
  oidcTokenUrl?: string
  /** auth=oidc：client_credentials 的客户端（种子化 nacos 客户端）。 */
  clientId?: string
  /** auth=oidc：client_credentials 密钥。 */
  clientSecret?: string
  /** 配置磁盘缓存目录（默认 ~/.dsh/config-cache），Nacos 不可用时降级读取 */
  cacheDir?: string
  /** v3 控制台登录用户（默认 nacos）；用于获取 accessToken */
  username?: string
  /** v3 控制台登录密码 */
  password?: string
  /** Namespace id; dsh.docx uses `dsh` */
  namespace?: string
  /** Config group; default DEFAULT_GROUP */
  group?: string
  /** Poll interval in milliseconds (listener semantic). Default 10000. */
  pollIntervalMs?: number
  /** Data IDs to track; defaults to the six dsh-* documents */
  dataIds?: string[]
}

export const DEFAULT_DATA_IDS = [
  'dsh-tools.yaml',
  'dsh-permission.yaml',
  'dsh-fault-tolerance.yaml',
  'dsh-context.yaml',
  'dsh-skills.yaml',
  'dsh-prompt.yaml',
] as const

export const DEFAULT_GROUP = 'DEFAULT_GROUP'

export interface SkillPackage {
  name: string
  version: string
  url: string
  gray?: { status: 'stable' | 'gray' | 'disabled'; percent?: number }
}

function url(base: string, params: Record<string, string>): string {
  const qs = new URLSearchParams(params).toString()
  return `${base.replace(/\/+$/, '')}/v3/console/cs/config?${qs}`
}

/** Nacos config MD5 semantics: uppercase md5 of the UTF-8 content. */
export function contentMd5(content: string): string {
  return createHash('md5').update(content, 'utf8').digest('hex').toUpperCase()
}

export class NacosConfigClient {
  private readonly cache = new Map<string, { md5: string; parsed: unknown; raw: string }>()
  private timer: ReturnType<typeof setInterval> | undefined
  private listeners = new Set<(dataId: string, parsed: unknown) => void>()
  private stopping = false
  private readonly fetchImpl: typeof fetch
  private readonly username: string
  private readonly password: string
  private accessToken: string | undefined

  private readonly cacheDir: string

  constructor(private readonly options: NacosConfigClientOptions, fetchImpl: typeof fetch = fetch) {
    this.fetchImpl = fetchImpl
    this.username = options.username ?? 'nacos'
    this.password = options.password ?? ''
    this.cacheDir = options.cacheDir ?? join(homedir(), '.dsh', 'config-cache')
    this.loadDiskCache()
    this.options = {
      namespace: 'dsh',
      group: DEFAULT_GROUP,
      pollIntervalMs: 10000,
      dataIds: [...DEFAULT_DATA_IDS],
      ...options,
    }
  }

  /** 磁盘缓存路径：<cacheDir>/<namespace>/<group>/<dataId>.yaml（+ .md5）。 */
  private diskPaths(dataId: string): { yaml: string; md5: string } {
    const o = this.options
    const dir = join(this.cacheDir, o.namespace ?? 'dsh', o.group ?? DEFAULT_GROUP)
    return { yaml: join(dir, dataId + '.yaml'), md5: join(dir, dataId + '.yaml.md5') }
  }

  /** 启动时从磁盘缓存加载（Nacos 不可用时的降级数据源）。 */
  private loadDiskCache(): void {
    for (const dataId of this.options.dataIds ?? DEFAULT_DATA_IDS) {
      const { yaml: yamlPath, md5: md5Path } = this.diskPaths(dataId)
      if (!existsSync(yamlPath) || !existsSync(md5Path)) continue
      try {
        const raw = readFileSync(yamlPath, 'utf8')
        const storedMd5 = readFileSync(md5Path, 'utf8').trim()
        if (storedMd5 !== contentMd5(raw)) continue // 磁盘内容损坏/被篡改，跳过
        this.cache.set(dataId, { md5: storedMd5, parsed: (yaml.load(raw) ?? {}) as unknown, raw })
      } catch {
        // 单个文件损坏不影响其余缓存
      }
    }
  }

  private persistToDisk(dataId: string, raw: string): void {
    const { yaml: yamlPath, md5: md5Path } = this.diskPaths(dataId)
    mkdirSync(yamlPath.substring(0, yamlPath.lastIndexOf('/')), { recursive: true })
    writeFileSync(yamlPath, raw)
    writeFileSync(md5Path, contentMd5(raw))
  }

  private configUrl(dataId: string): string {
    const o = this.options
    return url(o.server, {
      dataId,
      groupName: o.group ?? DEFAULT_GROUP,
      namespaceId: o.namespace ?? 'dsh',
      accessToken: this.accessToken ?? '',
    })
  }

  /** v3 console 登录，缓存 accessToken（oidc=Kestra client_credentials；local=账密）。 */
  private async login(): Promise<void> {
    if (this.accessToken) return
    if ((this.options.auth ?? 'oidc') === 'oidc') {
      const tokenUrl = this.options.oidcTokenUrl
        ?? new URL('/oidc/token', this.options.server.replace(/\/v3$/, '').replace(/\/?$/, '')).href
      const basic = Buffer.from(`${this.options.clientId ?? 'nacos'}:${this.options.clientSecret ?? 'nacos-secret-change-me'}`, 'utf8').toString('base64')
      const response = await this.fetchImpl(tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${basic}`,
        },
        body: 'grant_type=client_credentials',
      })
      if (!response.ok) throw new Error(`oidc token fetch failed: HTTP ${response.status}`)
      const data = (await response.json()) as { access_token?: string }
      this.accessToken = data.access_token
      return
    }
    const loginUrl = `${this.options.server.replace(/\/+$/, '')}/v3/auth/user/login`
    const response = await this.fetchImpl(loginUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: this.username, password: this.password }),
    })
    if (!response.ok) throw new Error(`nacos login failed: HTTP ${response.status}`)
    const data = (await response.json()) as { accessToken?: string }
    this.accessToken = data.accessToken
  }

  /** Fetch one config (v3 console API), update memory + disk cache; degraded to disk on failure. */
  async fetchConfig<T = unknown>(dataId: string): Promise<T | undefined> {
    let raw: string | undefined
    try {
      await this.login()
      const response = await this.fetchImpl(this.configUrl(dataId))
      if (!response.ok) return undefined
      const payload = (await response.json()) as { code?: number; data?: { content?: string; md5?: string } }
      if (payload.code !== 0 || payload.data?.content === undefined) return undefined
      raw = payload.data.content
      const md5 = payload.data.md5 ?? contentMd5(raw)
      const parsed = (yaml.load(raw) ?? {}) as T
      this.cache.set(dataId, { md5, parsed, raw })
      this.persistToDisk(dataId, raw)
      return parsed
    } catch {
      // Nacos 不可用：从磁盘缓存降级加载（保持上次已知配置）
      const { yaml: yamlPath } = this.diskPaths(dataId)
      if (!existsSync(yamlPath)) return undefined
      const cachedRaw = readFileSync(yamlPath, 'utf8')
      const parsed = (yaml.load(cachedRaw) ?? {}) as T
      this.cache.set(dataId, { md5: contentMd5(cachedRaw), parsed, raw: cachedRaw })
      return parsed
    }
  }

  getCached<T>(dataId: string): T | undefined {
    return this.cache.get(dataId)?.parsed as T | undefined
  }

  /** Pull every tracked Data ID once. Individual failures keep the cached value (degraded mode). */
  async refreshAll(): Promise<void> {
    await Promise.all([...(this.options.dataIds ?? [])].map(async (id) => {
      try {
        await this.fetchConfig(id)
      } catch {
        // Nacos 暂不可用：保留上次缓存，等待下一轮
      }
    }))
  }

  /** Start the poll loop; fires listeners when a document's MD5 changes. */
  start(): void {
    if (this.timer !== undefined) return
    this.stopping = false
    this.timer = setInterval(() => {
      void (async () => {
        if (this.stopping) return
        for (const dataId of this.options.dataIds ?? []) {
          const previous = this.cache.get(dataId)?.md5
          try {
            await this.fetchConfig(dataId)
          } catch {
            // Nacos 不可用：保留上次缓存（ degraded 模式），恢复后自动续上
            continue
          }
          const current = this.cache.get(dataId)
          if (current && previous !== undefined && previous !== current.md5) {
            for (const listener of this.listeners) listener(dataId, current.parsed)
          }
        }
      })()
    }, this.options.pollIntervalMs ?? 10000)
  }

  stop(): void {
    this.stopping = true
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }

  onConfigChange(listener: (dataId: string, parsed: unknown) => void): void {
    this.listeners.add(listener)
  }

  /**
   * Resolve the skill registry (dsh-skills.yaml) and download changed skill
   * bundles into `cacheDir`. Gray-scale: `gray` skills download only when
   * `grayBucket` (0-99) is below the percent; `disabled` never downloads.
   */
  async syncSkillPackages(cacheDir: string, grayBucket = 0): Promise<Array<{ name: string; version: string; cached: boolean }>> {
    const registry = await this.fetchConfig<{ skills?: SkillPackage[] }>('dsh-skills.yaml')
    const skills = registry?.skills ?? []
    mkdirSync(cacheDir, { recursive: true })
    const results: Array<{ name: string; version: string; cached: boolean }> = []
    for (const skill of skills) {
      const status = skill.gray?.status ?? 'stable'
      const percent = skill.gray?.percent ?? 100
      if (status === 'disabled' || (status === 'gray' && grayBucket >= percent)) {
        results.push({ name: skill.name, version: skill.version, cached: false })
        continue
      }
      const target = join(cacheDir, `${skill.name}-${skill.version}.tgz`)
      const marker = `${target}.md5`
      const remoteMd5 = createHash('md5').update(skill.url).digest('hex').toUpperCase()
      const unchanged = existsSync(target) && existsSync(marker) && readFileSync(marker, 'utf8') === remoteMd5
      if (!unchanged) {
        const response = await this.fetchImpl(skill.url)
        if (!response.ok) {
          results.push({ name: skill.name, version: skill.version, cached: false })
          continue
        }
        writeFileSync(target, Buffer.from(await response.arrayBuffer()))
        writeFileSync(marker, remoteMd5)
      }
      results.push({ name: skill.name, version: skill.version, cached: true })
    }
    return results
  }
}
