import type { DeviceCommand, Room, SmartHomeApi } from '../../shared/types'
import { applyLightGroups, suggestLightGroups } from '../../main/light-groups'

const names = ['Entrada', 'Cozinha', 'Mesa de jantar', 'Sala de estar', 'Banheiro', 'Banheiro da suíte', 'Office', 'Quarto']
const acRooms = new Set(['Sala de estar', 'Office', 'Quarto'])

export function houseRooms(): Room[] {
  const rooms: Room[] = names.map((name, index) => ({
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
      state: { on: false, currentTemperature: 24, targetTemperature: 23, online: true, mode: 'Resfriar', fan: 'Auto', turbo: false, updatedAt: new Date().toISOString() }
    }] : []
  }))
  const office = rooms.find(room => room.name === 'Office')!
  office.lights = [
    { id: 'office-switch', name: 'Luz Office', switchOnly: true, state: { on: false, online: true } },
    ...[1, 2, 3, 4].map(number => ({ id: `office-bulb-${number}`, name: `Office_${number}`, state: { on: false, brightness: 70, color: '#ffe0ae', temperature: 50, online: true } }))
  ]
  rooms.find(room => room.name === 'Quarto')!.lights.push({ id: 'office-switch::2', name: 'Cortineiro', switchOnly: true, state: { on: false, online: true } })
  return rooms
}

export function createFixtureApi(fixture: 'house' | 'empty'): SmartHomeApi {
  let rooms = fixture === 'house' ? houseRooms() : []
  let groups = suggestLightGroups(rooms)
  let configured = fixture === 'house'
  let found: Room[] | null = null
  let launchAtLogin = false
  let smartLifeConnected = fixture === 'house' && (typeof location === 'undefined' || new URLSearchParams(location.search).get('session') !== 'missing')
  let syncGuard = true
  return {
    async getRooms() { const copy = structuredClone(rooms); return applyLightGroups(copy, groups) },
    async sendCommand(command: DeviceCommand) {
      const group = groups.find(item => item.id === command.deviceId)
      if (group && command.kind.startsWith('light.')) {
        await Promise.all(group.memberIds.map(deviceId => this.sendCommand({ ...command, deviceId })))
        return
      }
      const appearance = command as DeviceCommand | { kind: 'light.color'; deviceId: string; color: string } | { kind: 'light.temperature'; deviceId: string; temperature: number }
      for (const room of rooms) {
        const light = room.lights.find((item) => item.id === command.deviceId)
        if (light && command.kind === 'light.power') { light.state.on = command.on; return }
        if (light && command.kind === 'light.brightness') { light.state.brightness = command.brightness; return }
        if (light && appearance.kind === 'light.color' && light.state.color !== undefined) { light.state.color = appearance.color; return }
        if (light && appearance.kind === 'light.temperature' && light.state.temperature !== undefined) { light.state.temperature = appearance.temperature; return }
        const ac = room.acs.find(item => item.id === command.deviceId)
        if (ac && new URLSearchParams(location.search).has('ac-error')) throw new Error('LG mock 400')
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
    async getSetupStatus() { return { configured, lgTokenConfigured: true, tuyaKeysConfigured: configured, smartLifeUserCodeConfigured: false, smartLifeConnected, syncGuard } },
    async setSyncGuard(enabled) { syncGuard = enabled },
    async getGroupSetup() { return { rooms: structuredClone(rooms), groups: structuredClone(groups) } },
    async saveLightGroups(value) { groups = structuredClone(value) },
    async saveHomeEdits(assignments, names, value) {
      const next = structuredClone(rooms)
      const devices = rooms.flatMap(room => [...room.lights.map(light => ({ room: room.id, light })), ...room.acs.map(ac => ({ room: room.id, ac }))])
      for (const room of next) { room.lights = []; room.acs = [] }
      for (const device of devices) {
        const id = 'light' in device ? device.light.id : device.ac.id
        const target = next.find(room => room.id === (assignments[id] ?? device.room))
        if (!target) throw new Error('Invalid room')
        if ('light' in device) target.lights.push({ ...device.light, name: names[id] ?? device.light.name })
        else target.acs.push(device.ac)
      }
      rooms = next
      groups = structuredClone(value)
    },
    async beginSmartLifeLogin() { return 'tuyaSmart--qrLogin?token=fixture-only' },
    async reconnectSmartLife() { smartLifeConnected = true },
    async discoverDevices() {
      found = [...houseRooms(), { id: 'lg:Sem cômodo', name: 'Sem cômodo', lights: [], acs: [{ id: 'ac-unmatched', name: 'Bedroom AC', state: { on: false, targetTemperature: 23, online: false } }] }]
      return structuredClone(found)
    },
    async saveSetup(acRoomIds, selectedGroups) {
      if (!found) throw new Error('Busque dispositivos antes de salvar')
      const saved = structuredClone(found)
      for (const room of saved) room.acs = room.acs.filter(ac => (acRoomIds[ac.id] || room.id) === room.id)
      for (const source of found) for (const ac of source.acs) {
        const target = saved.find(room => room.id === acRoomIds[ac.id])
        if (target && target.id !== source.id) target.acs.push(structuredClone(ac))
      }
      for (const room of saved) room.lights = room.lights.filter(light => (acRoomIds[light.id] || room.id) === room.id)
      for (const source of found) for (const light of source.lights) {
        const target = saved.find(room => room.id === acRoomIds[light.id])
        if (target && target.id !== source.id) target.lights.push(structuredClone(light))
      }
      rooms.push(...saved.filter(room => room.lights.length || room.acs.length))
      groups = selectedGroups ?? suggestLightGroups(rooms)
      configured = true
    }
  }
}
