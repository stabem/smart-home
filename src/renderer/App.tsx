import { useEffect, useState } from 'react'
import type { DeviceCommand, Room, SmartHomeApi } from '../shared/types'

type AppearanceCommand =
  | { kind: 'light.color'; deviceId: string; color: string }
  | { kind: 'light.temperature'; deviceId: string; temperature: number }

export function App({ api }: { api: SmartHomeApi }) {
  const [rooms, setRooms] = useState<Room[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [login, setLogin] = useState(false)
  const [found, setFound] = useState(false)
  const [colorFor, setColorFor] = useState<string | null>(null)
  const [error, setError] = useState('')

  async function refresh() { setRooms(await api.getRooms()) }
  useEffect(() => { void api.getRooms().then(setRooms); void api.getLaunchAtLogin().then(setLogin) }, [api])

  async function command(value: DeviceCommand | AppearanceCommand) {
    try { setError(''); await api.sendCommand(value as DeviceCommand); await refresh() }
    catch { setError('Não foi possível atualizar o dispositivo.') }
  }

  if (rooms === null) return <main><p role="status">Carregando...</p></main>
  if (rooms.length === 0) return <main>
    <header><h1>Configurar</h1></header>
    <section className="card"><p role="status" aria-label="Token LG">Token LG: não configurado</p><p role="status" aria-label="Chaves Tuya">Chaves Tuya: não configuradas</p></section>
    <button onClick={() => setFound(true)}>Buscar dispositivos</button>
    {found && <><ul aria-label="Dispositivos encontrados"><li>Nenhum dispositivo encontrado</li></ul><button disabled>Salvar</button></>}
    <p className="muted">Conexão com Smart Life e LG chega em uma próxima etapa.</p>
  </main>

  const room = rooms.find((item) => item.id === selected)
  if (room) return <main>
    <header className="roomHeader"><button className="back" onClick={() => { setSelected(null); setColorFor(null) }}>Voltar</button><h1>{room.name}</h1></header>
    {room.lights.map((light) => <section className="card" key={light.id}>
      <div className="cardHead"><strong>{light.name}</strong><button role="switch" aria-label={light.name} aria-checked={light.state.on} onClick={() => void command({ kind: 'light.power', deviceId: light.id, on: !light.state.on })}>{light.state.on ? 'Ligada' : 'Desligada'}</button></div>
      <label>Brilho <input type="range" aria-label="Brilho" min="1" max="100" value={light.state.brightness ?? 100} onChange={(event) => void command({ kind: 'light.brightness', deviceId: light.id, brightness: Number(event.target.value) })} /></label>
      <button aria-expanded={colorFor === light.id} onClick={() => setColorFor(colorFor === light.id ? null : light.id)}>Cor</button>
      {colorFor === light.id && <div className="appearance">
        {light.state.color !== undefined && <>
          <label>Cor <input type="color" aria-label="Escolher cor" value={light.state.color} onChange={(event) => void command({ kind: 'light.color', deviceId: light.id, color: event.target.value })} /></label>
          <span role="status" aria-label="Cor atual">{light.state.color}</span>
        </>}
        {light.state.temperature !== undefined && <label>Temperatura da luz
          <input type="range" aria-label="Temperatura da luz" min="0" max="100" value={light.state.temperature} onChange={(event) => void command({ kind: 'light.temperature', deviceId: light.id, temperature: Number(event.target.value) })} />
        </label>}
        {light.state.color === undefined && light.state.temperature === undefined && <p className="muted" role="status">Controle de cor ainda não disponível para este dispositivo.</p>}
      </div>}
    </section>)}
    {room.ac && <section className="card">
      <div className="cardHead"><strong>Ar condicionado</strong><button aria-label={room.ac.state.on ? 'Desligar ar' : 'Ligar ar'} onClick={() => void command({ kind: 'ac.power', deviceId: room.ac!.id, on: !room.ac!.state.on })}>{room.ac.state.on ? 'Ligado' : 'Desligado'}</button></div>
      <p>Ambiente: {room.ac.state.currentTemperature}°C</p>
      <div className="temperature"><button aria-label="Diminuir" onClick={() => void command({ kind: 'ac.temperature', deviceId: room.ac!.id, temperature: Math.max(16, room.ac!.state.targetTemperature - 1) })}>−</button><strong>{room.ac.state.targetTemperature}°C</strong><button aria-label="Aumentar" onClick={() => void command({ kind: 'ac.temperature', deviceId: room.ac!.id, temperature: Math.min(30, room.ac!.state.targetTemperature + 1) })}>+</button></div>
      <input type="range" aria-label="Temperatura" min="16" max="30" value={room.ac.state.targetTemperature} onChange={(event) => void command({ kind: 'ac.temperature', deviceId: room.ac!.id, temperature: Number(event.target.value) })} />
      <div className="actions"><button disabled title="Controle ainda não disponível">Modo</button><button disabled title="Controle ainda não disponível">Ventilação</button><button role="switch" aria-label="Turbo" aria-checked={room.ac.state.turbo ?? false} disabled title="Controle ainda não disponível">Turbo</button></div>
      <p className="updated" role="status">{room.ac.state.online ? `Atualizado${room.ac.state.updatedAt ? ` ${room.ac.state.updatedAt}` : ''}` : 'Offline'}</p>
    </section>}
    {error && <p role="alert">{error}</p>}
  </main>

  return <main>
    <header><div><span className="eyebrow">CONTROLE DA CASA</span><h1>Casa</h1></div><span className="muted">Minha casa</span></header>
    <h2 className="listHeading">Cômodos</h2>
    <ul aria-label="Cômodos" className="rooms">{rooms.map((item) => {
      const on = item.lights.length > 0 && item.lights.every((light) => light.state.on)
      return <li className="card room" key={item.id}>
        <button className="roomName" aria-label={`Abrir ${item.name}`} onClick={() => setSelected(item.id)}>{item.name}<span className="muted">{item.ac ? 'Luzes · Ar' : 'Luzes'}</span></button>
        <button className="roomLights" aria-label={`Luzes ${item.name}`} aria-pressed={on} disabled={!item.lights.length} onClick={() => void Promise.all(item.lights.map((light) => api.sendCommand({ kind: 'light.power', deviceId: light.id, on: !on }))).catch(() => setError('Não foi possível atualizar todas as luzes.')).finally(refresh)}>{on ? '●' : '○'}</button>
        {on && <span className="srOnly" role="status" aria-label={`${item.name} luzes ligadas`}>Ligadas</span>}
      </li>
    })}</ul>
    {error && <p role="alert">{error}</p>}
    <label className="login"><input type="checkbox" checked={login} onChange={(event) => { const enabled = event.target.checked; void api.setLaunchAtLogin(enabled).then(() => setLogin(enabled)) }} /> Iniciar com o Windows</label>
  </main>
}
