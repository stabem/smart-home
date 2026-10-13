import { contextBridge, ipcRenderer } from 'electron'
import type { SmartHomeApi } from '../shared/types'

const api: SmartHomeApi = {
  getRooms: () => ipcRenderer.invoke('rooms:list'),
  sendCommand: (command) => ipcRenderer.invoke('device:command', command),
  getLaunchAtLogin: () => ipcRenderer.invoke('login:get'),
  setLaunchAtLogin: (enabled) => ipcRenderer.invoke('login:set', enabled)
}

contextBridge.exposeInMainWorld('api', api)
