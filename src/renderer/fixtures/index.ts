import type { DeviceCommand, Room, SmartHomeApi } from '../../shared/types'

const names = ['Entrada', 'Cozinha', 'Mesa de jantar', 'Sala de estar', 'Banheiro', 'Banheiro da suíte', 'Office', 'Quarto']
const acRooms = new Set(['Sala de estar', 'Office', 'Quarto'])

export function houseRooms(): Room[] {
  return names.map((name, index) => ({
    id: `room-${index + 1}`,
    name,
    lights: [{
      id: `light-${index + 1}`,
      name: name === 'Quarto' ? 'Luz do quarto' : `Luz ${name}`,
      state: { on: false, brightness: 70, online: true, ...(name === 'Quarto' ? { color: '#ffffff', temperature: 50 } : {}) }
    }],
    acs: acRooms.has(name) ? [{
      id: `ac-${index + 1}`,
      name: `Ar ${name}`,
      state: { on: false, currentTemperature: 24, targetTemperature: 23, online: true, mode: 'Resfriar', fan: 'Auto', turbo: false }
    }] : []
  }))
}

export function createFixtureApi(fixture: 'house' | 'empty'): SmartHomeApi {
  const rooms = fixture === 'house' ? houseRooms() : []
  let configured = fixture === 'house'
  let found: Room[] | null = null
  let launchAtLogin = false
  return {
    async getRooms() { return structuredClone(rooms) },
    async sendCommand(command: DeviceCommand) {
      const appearance = command as DeviceCommand | { kind: 'light.color'; deviceId: string; color: string } | { kind: 'light.temperature'; deviceId: string; temperature: number }
      for (const room of rooms) {
        const light = room.lights.find((item) => item.id === command.deviceId)
        if (light && command.kind === 'light.power') { light.state.on = command.on; return }
        if (light && command.kind === 'light.brightness') { light.state.brightness = command.brightness; return }
        if (light && appearance.kind === 'light.color' && light.state.color !== undefined) { light.state.color = appearance.color; return }
        if (light && appearance.kind === 'light.temperature' && light.state.temperature !== undefined) { light.state.temperature = appearance.temperature; return }
        const ac = room.acs.find(item => item.id === command.deviceId)
        if (ac && command.kind === 'ac.power') { ac.state.on = command.on; return }
        if (ac && command.kind === 'ac.temperature') { ac.state.targetTemperature = command.temperature; return }
        if (ac && command.kind === 'ac.mode') { ac.state.mode = command.mode; ac.state.turbo = false; return }
        if (ac && command.kind === 'ac.fan') { ac.state.fan = command.fan; return }
        if (ac && command.kind === 'ac.turbo') { ac.state.turbo = command.on; return }
      }
      throw new Error('Dispositivo não encontrado')
    },
    async getLaunchAtLogin() { return launchAtLogin },
    async setLaunchAtLogin(enabled) { launchAtLogin = enabled },
    async getSetupStatus() { return { configured, lgTokenConfigured: true, tuyaKeysConfigured: configured, smartLifeUserCodeConfigured: false } },
    async beginSmartLifeLogin() { return 'tuyaSmart--qrLogin?token=fixture-only' },
    async discoverDevices() {
      found = [...houseRooms(), { id: 'lg:Sem cômodo', name: 'Sem cômodo', lights: [], acs: [{ id: 'ac-unmatched', name: 'Bedroom AC', state: { on: false, targetTemperature: 23, online: false } }] }]
      return structuredClone(found)
    },
    async saveSetup(acRoomIds) {
      if (!found) throw new Error('Busque dispositivos antes de salvar')
      const saved = structuredClone(found)
      for (const room of saved) room.acs = room.acs.filter(ac => (acRoomIds[ac.id] || room.id) === room.id)
      for (const source of found) for (const ac of source.acs) {
        const target = saved.find(room => room.id === acRoomIds[ac.id])
        if (target && target.id !== source.id) target.acs.push(structuredClone(ac))
      }
      rooms.push(...saved.filter(room => room.lights.length || room.acs.length))
      configured = true
    }
  }
}
