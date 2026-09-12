import { describe, expect, it } from 'vitest'

import { resolveRelayModel } from '../src/index.ts'

describe('resolveRelayModel（裁定版风险 #2 收口：relay overlay 模型取值）', () => {
  it('env 显式覆盖优先', () => {
    expect(resolveRelayModel({ DSH_PROVIDER: 'p-env', DSH_MODEL: 'm-env' }, { provider: 'p-ui', model: 'm-ui' }))
      .toEqual({ provider: 'p-env', model: 'm-env' })
  })

  it('无 env 时取 PC 当前默认选择（含 settings user layer）', () => {
    expect(resolveRelayModel({}, { provider: 'p-ui', model: 'm-ui' }))
      .toEqual({ provider: 'p-ui', model: 'm-ui' })
  })

  it('仅 DSH_MODEL 有 env 时 provider 仍取选择值', () => {
    expect(resolveRelayModel({ DSH_MODEL: 'm-env' }, { provider: 'p-ui', model: 'm-ui' }))
      .toEqual({ provider: 'p-ui', model: 'm-env' })
  })

  it('服务不可用（无选择）时回落历史默认', () => {
    expect(resolveRelayModel({}, undefined))
      .toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })
  })
})
