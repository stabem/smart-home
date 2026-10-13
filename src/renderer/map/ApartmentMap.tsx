import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import type { Room } from '../../shared/types'
import { floorplan, roomSlug } from './floorplan'

interface Props {
  rooms: Room[]
  highlighted: string | null
  selected: string | null
  onSelect: (id: string) => void
  onHighlight: (id: string | null) => void
}

function SvgPlan({ rooms, highlighted, selected, onSelect }: Props) {
  return <svg className="planFallback" viewBox="-1 -1 12 17.3" role="img" aria-label="Planta do apartamento">
    {floorplan.map((area, index) => {
      const room = rooms.find(item => roomSlug(item.name) === area.room)
      const lit = room?.lights.some(light => light.state.on && light.state.online)
      const active = room && (highlighted === room.id || selected === room.id)
      return <g key={`${area.label}-${index}`} onClick={() => room && onSelect(room.id)} className={room ? 'planArea selectable' : 'planArea'}>
        <rect x={area.x} y={area.y} width={area.w} height={area.h} rx=".08" fill={lit ? 'var(--glow)' : active ? 'var(--oak)' : 'var(--plaster-2)'} stroke="var(--concrete)" strokeWidth={active ? '.14' : '.09'} />
        {room?.acs.some(ac => ac.state.on && ac.state.online) && <circle cx={area.x + area.w / 2} cy={area.y + area.h / 2} r=".22" fill="var(--air)" />}
      </g>
    })}
  </svg>
}

export function ApartmentMap(props: Props) {
  const mount = useRef<HTMLDivElement>(null)
  const selectRef = useRef(props.onSelect)
  const highlightRef = useRef(props.onHighlight)
  const [fallback, setFallback] = useState(false)
  selectRef.current = props.onSelect
  highlightRef.current = props.onHighlight

  useEffect(() => {
    const host = mount.current
    if (!host || fallback) return
    let renderer: THREE.WebGLRenderer
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' }) }
    catch { setFallback(true); return }
    const width = host.clientWidth
    const height = host.clientHeight
    if (!width || !height) { renderer.dispose(); return }
    renderer.setSize(width, height)
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.domElement.setAttribute('aria-hidden', 'true')
    renderer.domElement.className = 'apartmentCanvas'
    host.appendChild(renderer.domElement)
    const scene = new THREE.Scene()
    const camera = new THREE.OrthographicCamera(-8.4, 8.4, 6.2, -6.2, 0.1, 100)
    const baseTarget = new THREE.Vector3(4.85, 0, 7.65)
    const cameraOffset = new THREE.Vector3(12, 22, 18)
    camera.position.copy(baseTarget).add(cameraOffset)
    camera.lookAt(baseTarget)
    scene.add(new THREE.AmbientLight(0xffffff, 2.1))
    const sun = new THREE.DirectionalLight(0xffffff, 2.5)
    sun.position.set(-2, 14, 10)
    scene.add(sun)
    const styles = getComputedStyle(host)
    const color = (name: string) => styles.getPropertyValue(name).trim()
    const meshes: THREE.Mesh[] = []
    const rings: THREE.Mesh[] = []
    const geometries: THREE.BufferGeometry[] = []
    const materials: THREE.Material[] = []
    const makeMaterial = (options: THREE.MeshStandardMaterialParameters) => {
      const material = new THREE.MeshStandardMaterial(options)
      materials.push(material)
      return material
    }
    const slabMaterial = makeMaterial({ color: color('--plaster-2'), roughness: .88 })
    const oakMaterial = makeMaterial({ color: color('--oak'), roughness: .9 })
    const selectedMaterial = makeMaterial({ color: color('--oak'), emissive: color('--oak'), emissiveIntensity: .2, roughness: .9 })
    const wallMaterial = makeMaterial({ color: color('--concrete'), roughness: 1 })
    const glowMaterial = makeMaterial({ color: color('--glow'), emissive: color('--glow'), emissiveIntensity: .34 })
    const airMaterial = makeMaterial({ color: color('--air'), emissive: color('--air'), emissiveIntensity: .25, transparent: true, opacity: .72, side: THREE.DoubleSide })
    const areaById = new Map<string, typeof floorplan[number]>()
    for (const area of floorplan) {
      const room = props.rooms.find(item => roomSlug(item.name) === area.room)
      const lit = room?.lights.some(light => light.state.online && light.state.on)
      const active = room && (props.highlighted === room.id || props.selected === room.id)
      const offline = room && [...room.lights, ...room.acs].some(device => !device.state.online)
      const geometry = new THREE.BoxGeometry(area.w, .12, area.h)
      geometries.push(geometry)
      const wood = ['sala-de-estar', 'office', 'quarto'].includes(area.room ?? '')
      const slab = new THREE.Mesh(geometry, lit ? glowMaterial : active ? selectedMaterial : wood ? oakMaterial : slabMaterial)
      slab.position.set(area.x + area.w / 2, .06, area.y + area.h / 2)
      slab.userData.roomId = room?.id
      scene.add(slab); meshes.push(slab)
      if (room) areaById.set(room.id, area)
      if (active) {
        const outlineGeometry = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(area.x, .17, area.y),
          new THREE.Vector3(area.x + area.w, .17, area.y),
          new THREE.Vector3(area.x + area.w, .17, area.y + area.h),
          new THREE.Vector3(area.x, .17, area.y + area.h)
        ])
        const outlineMaterial = new THREE.LineBasicMaterial({ color: color('--graphite') })
        geometries.push(outlineGeometry)
        materials.push(outlineMaterial)
        scene.add(new THREE.LineLoop(outlineGeometry, outlineMaterial))
      }
      // Four low wall segments preserve the drawn perimeter without hiding the floor.
      for (const [wallW, wallH, x, z] of [
        [area.w, .065, area.x + area.w / 2, area.y],
        [area.w, .065, area.x + area.w / 2, area.y + area.h],
        [.065, area.h, area.x, area.y + area.h / 2],
        [.065, area.h, area.x + area.w, area.y + area.h / 2]
      ]) {
        const wallGeo = new THREE.BoxGeometry(wallW, .35, wallH)
        geometries.push(wallGeo)
        const wall = new THREE.Mesh(wallGeo, wallMaterial)
        wall.position.set(x, .24, z)
        wall.userData.roomId = room?.id
        scene.add(wall); meshes.push(wall)
      }
      if (lit) {
        const point = new THREE.PointLight(color('--glow'), 4, Math.max(area.w, area.h) * 2)
        point.position.set(area.x + area.w / 2, .8, area.y + area.h / 2)
        scene.add(point)
      }
      if (room?.acs.some(ac => ac.state.on && ac.state.online)) {
        const ringGeo = new THREE.RingGeometry(.34, .39, 48)
        geometries.push(ringGeo)
        const ring = new THREE.Mesh(ringGeo, airMaterial)
        ring.rotation.x = -Math.PI / 2
        ring.position.set(area.x + area.w / 2, .13, area.y + area.h / 2)
        scene.add(ring); rings.push(ring)
      }
      if (offline) {
        const dotGeo = new THREE.SphereGeometry(.07, 12, 12)
        geometries.push(dotGeo)
        const dot = new THREE.Mesh(dotGeo, makeMaterial({ color: color('--alert') }))
        dot.position.set(area.x + area.w / 2, .23, area.y + area.h / 2)
        scene.add(dot)
      }
    }
    const raycaster = new THREE.Raycaster()
    const mouse = new THREE.Vector2()
    let downX = 0
    let dragging = false
    let yaw = 0
    const onDown = (event: PointerEvent) => { downX = event.clientX; dragging = false }
    const onMove = (event: PointerEvent) => {
      if (event.buttons === 1) {
        const delta = event.clientX - downX
        if (Math.abs(delta) > 3) dragging = true
        yaw = Math.max(-Math.PI / 6, Math.min(Math.PI / 6, yaw + delta * .003))
        downX = event.clientX
      } else {
        const rect = renderer.domElement.getBoundingClientRect()
        mouse.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1)
        raycaster.setFromCamera(mouse, camera)
        highlightRef.current(raycaster.intersectObjects(meshes)[0]?.object.userData.roomId ?? null)
      }
    }
    const onClick = (event: MouseEvent) => {
      if (dragging) return
      const rect = renderer.domElement.getBoundingClientRect()
      mouse.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1)
      raycaster.setFromCamera(mouse, camera)
      const id = raycaster.intersectObjects(meshes)[0]?.object.userData.roomId
      if (id) selectRef.current(id)
    }
    const onLeave = () => highlightRef.current(null)
    renderer.domElement.addEventListener('pointerdown', onDown)
    renderer.domElement.addEventListener('pointermove', onMove)
    renderer.domElement.addEventListener('click', onClick)
    renderer.domElement.addEventListener('pointerleave', onLeave)
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
    const roomTarget = props.selected && areaById.has(props.selected)
      ? (() => { const area = areaById.get(props.selected)!; return new THREE.Vector3(area.x + area.w / 2, 0, area.y + area.h / 2) })()
      : baseTarget
    const target = baseTarget.clone().lerp(roomTarget, props.selected ? .5 : 0)
    let frame = 0
    let disposed = false
    const animate = (time: number) => {
      if (disposed) return
      const rotated = cameraOffset.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw)
      const destination = target.clone().add(rotated)
      camera.position.lerp(destination, reduced ? 1 : .09)
      camera.lookAt(target)
      if (!reduced) rings.forEach((ring, index) => { ring.scale.setScalar(1 + .18 * Math.sin(time / 850 + index)) })
      renderer.render(scene, camera)
      frame = requestAnimationFrame(animate)
    }
    frame = requestAnimationFrame(animate)
    const onLost = (event: Event) => { event.preventDefault(); setFallback(true) }
    renderer.domElement.addEventListener('webglcontextlost', onLost)
    return () => {
      disposed = true
      cancelAnimationFrame(frame)
      renderer.domElement.removeEventListener('webglcontextlost', onLost)
      renderer.domElement.removeEventListener('pointerdown', onDown)
      renderer.domElement.removeEventListener('pointermove', onMove)
      renderer.domElement.removeEventListener('click', onClick)
      renderer.domElement.removeEventListener('pointerleave', onLeave)
      host.removeChild(renderer.domElement)
      geometries.forEach(item => item.dispose())
      materials.forEach(item => item.dispose())
      renderer.dispose()
    }
  }, [props.rooms, props.highlighted, props.selected, fallback])

  return <div className="mapStage" ref={mount} data-map-fallback={fallback}>{fallback && <SvgPlan {...props} />}</div>
}
