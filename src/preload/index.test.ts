import { describe, expect, it, vi } from 'vitest'

const ipc = vi.hoisted(() => ({ invoke: vi.fn(), expose: vi.fn() }))
vi.mock('electron', () => ({ ipcRenderer: { invoke: ipc.invoke, send: vi.fn() }, contextBridge: { exposeInMainWorld: ipc.expose } }))
import { sendCommand } from './index'

describe('device command IPC errors', () => {
  it.each(['Falha em: Office_1', 'Sem energia: Office_1', 'O ar está desligado. Ligue primeiro.'])(
    'passes %s through an Electron rejection', async message => {
      ipc.invoke.mockRejectedValueOnce(new Error(`Error invoking remote method 'device:command': Error: ${message}`))
      await expect(sendCommand({ kind: 'ac.power', deviceId: 'ac-1', on: true })).rejects.toMatchObject({ message })
    })
})
