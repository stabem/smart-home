import { describe, expect, it } from 'vitest'
import { createFixtureApi, houseRooms } from './index'

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
})
