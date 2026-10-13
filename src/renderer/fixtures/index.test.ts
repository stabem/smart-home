import { describe, expect, it, vi } from 'vitest'
import { createFixtureApi, houseRooms } from './index'
import { updatedLabel } from '../App'

describe('house fixture', () => {
  it('matches the eight documented rooms and three ACs', () => {
    const rooms = houseRooms()
    expect(rooms.map((room) => room.name)).toEqual(['Entrada', 'Cozinha', 'Mesa de jantar', 'Sala de estar', 'Banheiro', 'Banheiro da suíte', 'Office', 'Quarto'])
    expect(rooms.every((room) => room.lights.length > 0)).toBe(true)
    expect(rooms.filter((room) => room.acs.length).map((room) => room.name)).toEqual(['Sala de estar', 'Office', 'Quarto'])
  })

  it('updates fixture state without mutating prior snapshots', async () => {
    const api = createFixtureApi('house')
    const before = await api.getRooms()
    const light = before[0].lights[0]
    await api.sendCommand({ kind: 'light.power', deviceId: light.id, on: true })
    expect(before[0].lights[0].state.on).toBe(false)
    expect((await api.getRooms())[0].lights[0].state.on).toBe(true)
  })

  it('marks a missing sharing session disconnected until QR reconnect completes', async () => {
    vi.stubGlobal('location', { search: '?fixture=house&session=missing' })
    try {
      const api = createFixtureApi('house')
      expect((await api.getSetupStatus()).smartLifeConnected).toBe(false)
      await api.beginSmartLifeLogin()
      await api.reconnectSmartLife()
      expect((await api.getSetupStatus()).smartLifeConnected).toBe(true)
      expect(await api.getRooms()).toHaveLength(8)
    } finally { vi.unstubAllGlobals() }
  })

  it('shows both Office gangs in their assigned rooms with on/off only', () => {
    const rooms = houseRooms()
    expect(rooms.find(room => room.name === 'Office')?.lights.map(light => light.name)).toEqual([
      'Luz Office', 'Lâmpada Office 1', 'Lâmpada Office 2', 'Lâmpada Office 3', 'Lâmpada Office 4'
    ])
    expect(rooms.find(room => room.name === 'Quarto')?.lights.at(-1)).toMatchObject({ id: 'office-switch::2', name: 'Cortineiro', switchOnly: true })
  })

  it('uses local pt-BR time and agora for a fresh AC update', () => {
    const at = '2026-10-13T19:08:20.436Z'
    expect(updatedLabel(at, Date.parse(at) + 30_000)).toBe('Atualizado agora')
    expect(updatedLabel(at, Date.parse(at) + 120_000)).toMatch(/^Atualizado às \d{2}:\d{2}$/)
  })
})
