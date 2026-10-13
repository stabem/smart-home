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
    ...(acRooms.has(name) ? { ac: {
      id: `ac-${index + 1}`,
      name: `Ar ${name}`,
      state: { on: false, currentTemperature: 24, targetTemperature: 23, online: true, mode: 'Frio', fan: 'Auto', turbo: false }
    } } : {})
  }))
}

export function createFixtureApi(fixture: 'house' | 'empty'): SmartHomeApi {
  const rooms = fixture === 'house' ? houseRooms() : []
  let configured = fixture === 'house'
  let found = false
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
        if (room.ac?.id === command.deviceId && command.kind === 'ac.power') { room.ac.state.on = command.on; return }
        if (room.ac?.id === command.deviceId && command.kind === 'ac.temperature') { room.ac.state.targetTemperature = command.temperature; return }
      }
      throw new Error('Dispositivo não encontrado')
    },
    async getLaunchAtLogin() { return launchAtLogin },
    async setLaunchAtLogin(enabled) { launchAtLogin = enabled },
    async getSetupStatus() { return { configured, lgTokenConfigured: true, tuyaKeysConfigured: configured } },
    async beginSmartLifeLogin() { return 'tuyaSmart--qrLogin?token=fixture-only' },
    async discoverDevices() { found = true; return houseRooms() },
    async saveSetup() {
      if (!found) throw new Error('Busque dispositivos antes de salvar')
      rooms.push(...houseRooms())
      configured = true
    }
  }
}
