import { describe, expect, it, vi } from 'vitest'
import { LgClient, type AcPatch } from './client'

const profile = {
  property: {
    operation: { airConOperationMode: { mode: ['r', 'w'], value: { w: ['POWER_ON', 'POWER_OFF'] } } },
    temperature: { targetTemperatureC: { mode: ['r', 'w'], value: { w: { min: 16, max: 30, step: 1 } } } },
    airConJobMode: { currentJobMode: { mode: ['r', 'w'], value: { w: ['COOL', 'AIR_DRY', 'FAN', 'AUTO', 'JET'] } } },
    airFlow: { windStrength: { mode: ['r', 'w'], value: { w: ['AUTO', 'LOW', 'MID', 'HIGH'] } } }
  }
}

function mockFetch(responses: Record<string, unknown>): typeof fetch {
  return vi.fn(async (url: string) => {
    const path = new URL(url).pathname
    const data = responses[path]
    return new Response(JSON.stringify({ response: data }), { status: data === undefined ? 404 : 200 })
  }) as unknown as typeof fetch
}

describe('ThinQ AC client', () => {
  it('logs only known state enums when LG returns a secret in mode or fan', async () => {
    const secret = 'SENTINEL-LG-SECRET'
    const log = vi.spyOn(console, 'info').mockImplementation(() => {})
    try {
      const fetcher = mockFetch({
        '/devices/ac-1/profile': { property: { airFlow: { windStrength: { mode: ['r'] } } } },
        '/devices/ac-1/state': { operation: { airConOperationMode: 'POWER_ON' }, temperature: { targetTemperatureC: 23 },
          airConJobMode: { currentJobMode: secret }, airFlow: { windStrength: secret } }
      })
      await new LgClient('test-token', 'BR', fetcher).getAcState('ac-1')
      expect(log).toHaveBeenCalledWith('LG state operation=POWER_ON mode=other fan=other')
      expect(JSON.stringify(log.mock.calls)).not.toContain(secret)
    } finally { log.mockRestore() }
  })
  it('lists only ACs and maps their state', async () => {
    const fetcher = mockFetch({
      '/devices/ac-1/profile': profile,
      '/devices': [
        { deviceId: 'ac-1', deviceInfo: { alias: 'Office', deviceType: 'DEVICE_AIR_CONDITIONER' } },
        { deviceId: 'washer', deviceInfo: { deviceType: 'DEVICE_WASHER' } }
      ],
      '/devices/ac-1/state': {
        operation: { airConOperationMode: 'POWER_ON' },
        temperature: { currentTemperatureC: 27, targetTemperatureC: 23 },
        airConJobMode: { currentJobMode: 'COOL' },
        airFlow: { windStrength: 'HIGH' }
      }
    })
    const acs = await new LgClient('test-token', 'BR', fetcher).listAcs()
    expect(acs).toMatchObject([{ id: 'ac-1', name: 'Office', state: {
      on: true, currentTemperature: 27, targetTemperature: 23, mode: 'Resfriar', fan: 'Alta', online: true
    } }])
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(vi.mocked(fetcher).mock.calls[0][0]).toBe('https://api-aic.lgthinq.com/devices')
    expect(vi.mocked(fetcher).mock.calls[0][1]).toMatchObject({ headers: {
      authorization: 'Bearer test-token', 'x-country': 'BR', 'x-service-phase': 'OP'
    } })
  })

  it('uses a windStrengthDetail-only profile for fan state and control', async () => {
    const detailProfile = { property: { airFlow: {
      windStrengthDetail: { mode: ['r', 'w'], value: { w: ['NATURE', 'LOW', 'HIGH'] } }
    } } }
    const fetcher = mockFetch({
      '/devices/ac-1/profile': detailProfile,
      '/devices/ac-1/state': {
        operation: { airConOperationMode: 'POWER_ON' },
        temperatureInUnits: [{ unit: 'C', currentTemperature: 27, targetTemperature: 23 }],
        airFlow: { windStrengthDetail: 'HIGH' }
      },
      '/devices/ac-1/control': {}
    })
    const client = new LgClient('test-token', 'BR', fetcher)
    expect(await client.getAcState('ac-1')).toMatchObject({
      on: true, currentTemperature: 27, targetTemperature: 23, fan: 'Alta'
    })
    await client.setAc('ac-1', { fan: 'Auto' })
    expect(vi.mocked(fetcher).mock.calls.filter(call => new URL(String(call[0])).pathname.endsWith('/control'))
      .map(call => JSON.parse(String(call[1]?.body)))).toEqual([
        { airFlow: { windStrengthDetail: 'NATURE' } }
      ])
  })

  it('prefers windStrengthDetail when the profile offers both fan properties', async () => {
    const bothProfile = { property: { airFlow: {
      windStrength: { mode: ['r', 'w'], value: { w: ['LOW'] } },
      windStrengthDetail: { mode: ['r', 'w'], value: { w: ['HIGH'] } }
    } } }
    const fetcher = mockFetch({
      '/devices/ac-1/profile': bothProfile,
      '/devices/ac-1/state': {
        operation: { airConOperationMode: 'POWER_ON' },
        temperature: { targetTemperatureC: 23 },
        airFlow: { windStrength: 'LOW', windStrengthDetail: 'HIGH' }
      },
      '/devices/ac-1/control': {}
    })
    const client = new LgClient('test-token', 'BR', fetcher)
    expect((await client.getAcState('ac-1')).fan).toBe('Alta')
    await client.setAc('ac-1', { fan: 'Alta' })
    expect(JSON.parse(String(vi.mocked(fetcher).mock.calls.at(-1)?.[1]?.body)))
      .toEqual({ airFlow: { windStrengthDetail: 'HIGH' } })
  })

  it.each([['LOW', 'Baixa'], ['LOW_MID', 'Média-baixa'], ['MID', 'Média'], ['MID_HIGH', 'Média-alta'], ['HIGH', 'Alta'], ['AUTO', 'Auto'], ['POWER', 'Turbo']])('labels LG fan %s as %s', async (raw, label) => {
    const fetcher = mockFetch({ '/devices/ac-1/profile': { property: { airFlow: { windStrengthDetail: { mode: ['r'] } } } },
      '/devices/ac-1/state': { operation: { airConOperationMode: 'POWER_ON' }, temperature: { targetTemperatureC: 23 }, airFlow: { windStrengthDetail: raw } } })
    expect((await new LgClient('test-token', 'BR', fetcher).getAcState('ac-1')).fan).toBe(label)
  })
  it.each([['COOL', 'Resfriar'], ['AIR_DRY', 'Seco'], ['DRY', 'Seco'], ['FAN', 'Ventilar'], ['AUTO', 'Auto'], ['AI', 'Auto'], ['HEAT', 'Aquecer'], ['JET', 'Resfriar']])('labels LG mode %s as %s', async (raw, label) => {
    const fetcher = mockFetch({ '/devices/ac-1/state': { operation: { airConOperationMode: 'POWER_ON' },
      temperature: { targetTemperatureC: 23 }, airConJobMode: { currentJobMode: raw } } })
    expect((await new LgClient('test-token', 'BR', fetcher).getAcState('ac-1')).mode).toBe(label)
  })

  it('keeps an unreachable AC in the list as offline', async () => {
    const fetcher = mockFetch({ '/devices': [
      { deviceId: 'ac-1', deviceInfo: { alias: 'Office', deviceType: 'DEVICE_AIR_CONDITIONER' } }
    ] })
    const acs = await new LgClient('test-token', 'BR', fetcher).listAcs()
    expect(acs).toMatchObject([{ id: 'ac-1', name: 'Office', state: { online: false } }])
  })

  it('checks the profile before sending separate controls', async () => {
    const fetcher = mockFetch({ '/devices/ac-1/profile': profile, '/devices/ac-1/control': {} })
    await new LgClient('test-token', 'BR', fetcher).setAc('ac-1', { on: true, targetTemperature: 24, fan: 'Baixa' })
    const calls = vi.mocked(fetcher).mock.calls
    expect(calls.map((call) => new URL(String(call[0])).pathname)).toEqual([
      '/devices/ac-1/profile', '/devices/ac-1/control', '/devices/ac-1/control', '/devices/ac-1/control'
    ])
    expect(calls.slice(1).map((call) => JSON.parse(String(call[1]?.body)))).toEqual([
      { operation: { airConOperationMode: 'POWER_ON' } },
      { temperature: { targetTemperature: 24, unit: 'C' } },
      { airFlow: { windStrength: 'LOW' } }
    ])
    expect(calls[1][0]).toBe('https://api-aic.lgthinq.com/devices/ac-1/control')
    expect(calls[1][1]).toEqual({ method: 'POST', headers: {
      authorization: 'Bearer test-token', 'x-country': 'BR', 'x-api-key': 'v6GFvkweNo7DK7yD3ylIZ9w52aKBU0eJ7wLXkSR3',
      'x-client-id': expect.stringMatching(/^smart-home-tray-/), 'x-message-id': expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      'x-service-phase': 'OP', 'x-conditional-control': 'true', 'content-type': 'application/json'
    }, body: JSON.stringify({ operation: { airConOperationMode: 'POWER_ON' } }), signal: expect.any(AbortSignal) })
  })

  it('maps each mode, fan and turbo command to profile-checked LG values', async () => {
    const fetcher = mockFetch({ '/devices/ac-1/profile': profile, '/devices/ac-1/control': {} })
    const client = new LgClient('test-token', 'BR', fetcher)
    for (const mode of ['Resfriar', 'Seco', 'Ventilar', 'Auto']) await client.setAc('ac-1', { mode })
    for (const fan of ['Auto', 'Baixa', 'Média', 'Alta']) await client.setAc('ac-1', { fan })
    await client.setAc('ac-1', { turbo: true })
    await client.setAc('ac-1', { turbo: false })
    expect(vi.mocked(fetcher).mock.calls.filter(call => new URL(String(call[0])).pathname.endsWith('/control')).map(call => JSON.parse(String(call[1]?.body)))).toEqual([
      ...['COOL', 'AIR_DRY', 'FAN', 'AUTO'].map(value => ({ airConJobMode: { currentJobMode: value } })),
      ...['AUTO', 'LOW', 'MID', 'HIGH'].map(value => ({ airFlow: { windStrength: value } })),
      { airConJobMode: { currentJobMode: 'JET' } },
      { airConJobMode: { currentJobMode: 'COOL' } }
    ])
  })

  it('rejects unsupported values before any control request', async () => {
    const fetcher = mockFetch({ '/devices/ac-1/profile': profile, '/devices/ac-1/control': {} })
    await expect(new LgClient('test-token', 'BR', fetcher).setAc('ac-1', { targetTemperature: 31 }))
      .rejects.toThrow('unsupported by profile')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it.each([
    { name: 'numeric string', patch: { targetTemperature: '99' } },
    { name: 'NaN', patch: { targetTemperature: Number.NaN } },
    { name: 'infinity', patch: { targetTemperature: Number.POSITIVE_INFINITY } },
    { name: 'null temperature', patch: { targetTemperature: null } },
    { name: 'string power', patch: { on: 'false' } },
    { name: 'string turbo', patch: { turbo: 'false' } },
    { name: 'string power save', patch: { powerSave: 'true' } },
    { name: 'numeric mode', patch: { mode: 123 } },
    { name: 'boolean fan', patch: { fan: true } },
    { name: 'mixed valid and invalid fields', patch: { on: true, targetTemperature: '99' } }
  ])('rejects wrong runtime types before any control request: $name', async ({ patch }) => {
    const fetcher = mockFetch({ '/devices/ac-1/profile': profile, '/devices/ac-1/control': {} })
    await expect(new LgClient('test-token', 'BR', fetcher).setAc('ac-1', patch as unknown as AcPatch))
      .rejects.toThrow('LG AC patch value invalid')
    expect(vi.mocked(fetcher).mock.calls.some((call) => new URL(String(call[0])).pathname.endsWith('/control'))).toBe(false)
  })

  it('uses the model profile for power save and legacy temperature controls', async () => {
    const legacyProfile = {
      property: {
        temperature: { targetTemperature: { mode: ['r', 'w'], value: { w: { min: 16, max: 30, step: 1 } } } },
        powerSave: { powerSaveEnabled: { mode: ['r', 'w'] } }
      }
    }
    const fetcher = mockFetch({ '/devices/ac-1/profile': legacyProfile, '/devices/ac-1/control': {} })
    await new LgClient('test-token', 'BR', fetcher).setAc('ac-1', { targetTemperature: 22, powerSave: true })
    expect(vi.mocked(fetcher).mock.calls.slice(1).map((call) => JSON.parse(String(call[1]?.body)))).toEqual([
      { temperature: { targetTemperature: 22, unit: 'C' } },
      { powerSave: { powerSaveEnabled: true } }
    ])
  })

  it('does not put the token or response body in errors', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'test-token' } }), { status: 401 })) as unknown as typeof fetch
    await expect(new LgClient('test-token', 'BR', fetcher).listAcs()).rejects.toThrow('LG API request failed (401)')
  })

  it('uses the official temperatureInUnits profile and returns LG code and message without token', async () => {
    const official = { property: { temperatureInUnits: [{ unit: 'C', targetTemperature: { mode: ['r', 'w'], value: { w: { min: 16, max: 30, step: 1 } } } }] } }
    const fetcher = vi.fn(async (url: string) => new Response(JSON.stringify(new URL(url).pathname.endsWith('/profile')
      ? { response: official } : { error: { code: '2207', message: 'Invalid command test-token' } }),
    { status: new URL(url).pathname.endsWith('/profile') ? 200 : 400 })) as unknown as typeof fetch
    await expect(new LgClient('test-token', 'BR', fetcher).setAc('ac-1', { targetTemperature: 18 }))
      .rejects.toThrow('LG API request failed (400): 2207: Invalid command [redacted]')
    expect(JSON.parse(String(vi.mocked(fetcher).mock.calls[1][1]?.body))).toEqual({ temperature: { targetTemperature: 18, unit: 'C' } })
  })
  it('prefers the writable plain targetTemperature when temperatureInUnits lists it read-only (real profile)', async () => {
    const real = { property: {
      temperature: { targetTemperature: { type: 'range', mode: ['r', 'w'], value: { r: { min: 16, max: 30, step: 1 }, w: { min: 16, max: 30, step: 1 } } } },
      temperatureInUnits: [{ unit: 'C', targetTemperature: { type: 'range', mode: ['r'], value: { r: { min: 16, max: 30, step: 1 } } } }]
    } }
    const fetcher = vi.fn(async (url: string) => new Response(JSON.stringify(new URL(url).pathname.endsWith('/profile') ? { response: real } : { response: {} }), { status: 200 })) as unknown as typeof fetch
    await new LgClient('test-token', 'BR', fetcher).setAc('ac-1', { targetTemperature: 20 })
    expect(JSON.parse(String(vi.mocked(fetcher).mock.calls[1][1]?.body))).toEqual({ temperature: { targetTemperature: 20, unit: 'C' } })
  })
})
