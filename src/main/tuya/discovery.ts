import { createSocket, type Socket as UdpSocket } from 'node:dgram'
import { decodeBroadcast, type TuyaVersion } from './protocol'

export interface LanAddress { id: string; ip: string; version?: TuyaVersion }

export async function discoverLan(
  durationMs = 1200,
  socketFactory: () => UdpSocket = () => createSocket({ type: 'udp4', reuseAddr: true })
): Promise<Map<string, LanAddress>> {
  const found = new Map<string, LanAddress>()
  const sockets = [6666, 6667].map(() => socketFactory())
  await Promise.all(sockets.map((socket, index) => new Promise<void>((resolve, reject) => {
    socket.on('message', packet => {
      const device = decodeBroadcast(packet)
      if (device) found.set(device.id, device)
    })
    socket.once('error', reject)
    socket.bind([6666, 6667][index], '0.0.0.0', () => {
      socket.off('error', reject)
      resolve()
    })
  }))).catch(error => { sockets.forEach(socket => socket.close()); throw error })
  await new Promise(resolve => setTimeout(resolve, durationMs))
  sockets.forEach(socket => socket.close())
  return found
}
