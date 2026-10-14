import { contextBridge, ipcRenderer } from 'electron'
import type { SmartHomeApi } from '../shared/types'

const api: SmartHomeApi = {
  fitWindow: (contentHeight) => ipcRenderer.send('window:fit', contentHeight),
  getRooms: () => ipcRenderer.invoke('rooms:list'),
  sendCommand: (command) => ipcRenderer.invoke('device:command', command),
  getLaunchAtLogin: () => ipcRenderer.invoke('login:get'),
  setLaunchAtLogin: (enabled) => ipcRenderer.invoke('login:set', enabled),
  getSetupStatus: () => ipcRenderer.invoke('setup:status'),
  beginSmartLifeLogin: (userCode) => ipcRenderer.invoke('setup:login', userCode),
  reconnectSmartLife: () => ipcRenderer.invoke('setup:reconnect'),
  discoverDevices: () => ipcRenderer.invoke('setup:discover'),
  saveSetup: (acRoomIds, groups) => ipcRenderer.invoke('setup:save', acRoomIds, groups),
  setSyncGuard: (enabled) => ipcRenderer.invoke('groups:sync-guard', enabled),
  getGroupSetup: () => ipcRenderer.invoke('groups:get'),
  saveLightGroups: (groups) => ipcRenderer.invoke('groups:save', groups),
  saveHomeEdits: (assignments, names, groups) => ipcRenderer.invoke('home:edit', assignments, names, groups)
}

contextBridge.exposeInMainWorld('api', api)
