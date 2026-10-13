import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import type { Room } from '../../shared/types'
import { floorplan, roomSlug, type PlanArea } from './floorplan'

interface Props {
  rooms: Room[]
  highlighted: string | null
  selected: string | null
  onSelect: (id: string) => void
  onHighlight: (id: string | null) => void
}

// The map changes host panels between home and room screens. Keep its camera pose
// across that handoff so both entering a room and Voltar have a continuous flight.
let cameraPose: { center: THREE.Vector3; height: number } | null = null

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
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    renderer.domElement.setAttribute('aria-hidden', 'true')
    renderer.domElement.className = 'apartmentCanvas'
    host.appendChild(renderer.domElement)
    const scene = new THREE.Scene()
    const camera = new THREE.OrthographicCamera(-8, 8, 5, -5, .1, 100)
    const baseTarget = new THREE.Vector3(4.85, 0, 7.2)
    const offset = new THREE.Vector3(12, 15, 20)
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
    const roomArea = floorplan.find(area => props.rooms.some(room => room.id === props.selected && roomSlug(room.name) === area.room))
    const endTarget = roomArea ? new THREE.Vector3(roomArea.x + roomArea.w / 2, 0, roomArea.y + roomArea.h / 2) : baseTarget
    const center = !reduced && cameraPose ? cameraPose.center.clone() : !reduced && roomArea ? baseTarget.clone() : endTarget.clone()
    let viewHeight = !reduced && cameraPose ? cameraPose.height : roomArea && !reduced ? 11.1 : roomArea ? Math.max(roomArea.h + .2, 4.1) : 11.1
    let yaw = 0
    const setCamera = () => {
      const aspect = width / height
      camera.left = -viewHeight * aspect / 2
      camera.right = viewHeight * aspect / 2
      camera.top = viewHeight / 2
      camera.bottom = -viewHeight / 2
      camera.updateProjectionMatrix()
      camera.position.copy(center).add(offset.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw))
      camera.lookAt(center)
    }
    setCamera()
    const styles = getComputedStyle(host)
    const color = (name: string) => styles.getPropertyValue(name).trim()
    const dark = matchMedia('(prefers-color-scheme: dark)').matches
    scene.add(new THREE.HemisphereLight(0xfff3e5, dark ? 0x3c3936 : 0xc6bdb1, 2.2))
    const sun = new THREE.DirectionalLight(0xffebd4, 3)
    sun.position.set(-5, 15, -7)
    sun.castShadow = true
    sun.shadow.mapSize.set(1024, 1024)
    sun.shadow.camera.left = -12; sun.shadow.camera.right = 12
    sun.shadow.camera.top = 17; sun.shadow.camera.bottom = -17
    sun.shadow.bias = -.001
    scene.add(sun)
    const geometries: THREE.BufferGeometry[] = []
    const materials: THREE.Material[] = []
    const textures: THREE.Texture[] = []
    const hitMeshes: THREE.Mesh[] = []
    const rings: THREE.Object3D[] = []
    const mat = (hex: string, roughness = .85, opacity = 1) => {
      const material = new THREE.MeshStandardMaterial({ color: hex, roughness, transparent: opacity < 1, opacity })
      materials.push(material)
      return material
    }
    const stone = mat(dark ? '#8f8980' : '#d8d2c8')
    const grout = mat(dark ? '#514b46' : '#bfb7aa')
    const oak = mat(dark ? '#aa8057' : '#bf9366')
    const oakLight = mat(dark ? '#b58e63' : '#d5af82')
    const oakDark = mat(dark ? '#896845' : '#a87e55')
    const plaster = mat(dark ? '#9d958b' : '#eee9df')
    const edge = mat(dark ? '#d3c5b3' : '#f9f4eb')
    const graphite = mat(dark ? '#343333' : '#373635')
    const fabric = mat(dark ? '#b5afa6' : '#d6d1ca')
    const glass = mat('#9bb9c0', .15, .28)
    glass.depthWrite = false
    const muted = mat(dark ? '#514c46' : '#c6c0b6', 1, .65)
    const dimmed = mat(dark ? '#514c46' : '#c6c0b6', 1, .18)
    const air = mat('#86bfe6', .3, .68)
    air.emissive = new THREE.Color('#86bfe6'); air.emissiveIntensity = .55
    const glow = mat('#ffd69a', .4)
    glow.emissive = new THREE.Color('#ffc874'); glow.emissiveIntensity = 1.3
    const box = (parent: THREE.Object3D, x: number, y: number, z: number, w: number, h: number, d: number, material: THREE.Material, shadow = true) => {
      const geometry = new THREE.BoxGeometry(w, h, d)
      geometries.push(geometry)
      const mesh = new THREE.Mesh(geometry, material)
      mesh.position.set(x, y, z)
      mesh.castShadow = shadow
      mesh.receiveShadow = true
      parent.add(mesh)
      return mesh
    }
    const disk = (parent: THREE.Object3D, x: number, y: number, z: number, radius: number, height: number, material: THREE.Material) => {
      const geometry = new THREE.CylinderGeometry(radius, radius, height, 20)
      geometries.push(geometry)
      const mesh = new THREE.Mesh(geometry, material)
      mesh.position.set(x, y, z)
      mesh.castShadow = true
      mesh.receiveShadow = true
      parent.add(mesh)
      return mesh
    }
    const label = (parent: THREE.Object3D, area: PlanArea, faded: boolean) => {
      if (area.h < 1.15) return
      const canvas = document.createElement('canvas')
      canvas.width = 512; canvas.height = 96
      const context = canvas.getContext('2d')
      if (!context) return
      context.font = '600 49px Switzer, sans-serif'
      context.textAlign = 'center'; context.textBaseline = 'middle'
      context.fillStyle = dark ? '#f8f4ea' : '#252320'
      context.shadowColor = dark ? '#292521' : '#f9f5ec'; context.shadowBlur = 8
      context.fillText(area.label, 256, 48, 490)
      const texture = new THREE.CanvasTexture(canvas)
      texture.colorSpace = THREE.SRGBColorSpace
      textures.push(texture)
      const material = new THREE.SpriteMaterial({ map: texture, transparent: true, opacity: faded ? .16 : 1, depthTest: false })
      materials.push(material)
      const sprite = new THREE.Sprite(material)
      sprite.position.set(area.x + area.w / 2, 1.48, area.y + area.h / 2)
      sprite.scale.set(Math.min(area.w * .96, 3.2), .68, 1)
      parent.add(sprite)
    }
    for (const area of floorplan) {
      const room = props.rooms.find(item => roomSlug(item.name) === area.room)
      const selected = room && room.id === props.selected
      const dim = !!props.selected && !selected
      const lit = room?.lights.some(light => light.state.online && light.state.on)
      const acOn = room?.acs.some(ac => ac.state.online && ac.state.on)
      const group = new THREE.Group()
      scene.add(group)
      const floor = box(group, area.x + area.w / 2, .01, area.y + area.h / 2, area.w, .16, area.h, dim ? dimmed : !room ? muted : plaster, false)
      floor.userData.roomId = room?.id
      hitMeshes.push(floor)
      const wood = ['sala-de-estar', 'office', 'quarto'].includes(area.room ?? '')
      const tiled = ['cozinha', 'banheiro', 'banheiro-da-suite'].includes(area.room ?? '')
      if (!dim && room) {
        if (wood) {
          const count = Math.ceil(area.w / .26)
          for (let i = 0; i < count; i++) {
            const x = area.x + (i + .5) * area.w / count
            box(group, x, .105, area.y + area.h / 2, area.w / count - .012, .025, area.h - .07, [oak, oakLight, oakDark][i % 3], false)
            for (let row = 1; row < Math.ceil(area.h / 1.1); row++) box(group, x, .12, area.y + row * area.h / Math.ceil(area.h / 1.1), area.w / count - .02, .004, .012, oakDark, false)
          }
        } else if (tiled) {
          box(group, area.x + area.w / 2, .1, area.y + area.h / 2, area.w - .08, .025, area.h - .08, stone, false)
          for (let x = area.x + .6; x < area.x + area.w; x += .6) box(group, x, .115, area.y + area.h / 2, .012, .004, area.h - .08, grout, false)
          for (let z = area.y + .6; z < area.y + area.h; z += .6) box(group, area.x + area.w / 2, .115, z, area.w - .08, .004, .012, grout, false)
        }
      }
      const wallMaterial = dim ? dimmed : !room ? muted : plaster
      // Tall back and side walls, with a low front lip and a pale cutaway top.
      for (const [x, z, w, d, h] of [
        [area.x + area.w / 2, area.y, area.w, .14, .88],
        [area.x, area.y + area.h / 2, .14, area.h, .88],
        [area.x + area.w, area.y + area.h / 2, .14, area.h, .68],
        [area.x + area.w / 2, area.y + area.h, area.w, .14, .2]
      ]) {
        const wall = box(group, x, h / 2 + .12, z, w, h, d, wallMaterial)
        wall.userData.roomId = room?.id
        hitMeshes.push(wall)
        if (!dim && room) box(group, x, h + .13, z, w, .045, d + .025, edge, false)
      }
      if (!dim && room) {
        const X = area.x, Z = area.y, W = area.w, D = area.h
        if (area.room === 'sala-de-estar') {
          box(group, X + .8, .24, Z + D * .59, 1.45, .24, .55, fabric)
          box(group, X + .8, .42, Z + D * .4, 1.45, .46, .22, fabric)
          box(group, X + .23, .3, Z + D * .59, .24, .3, .6, fabric)
          box(group, X + 2.55, .52, Z + .3, .12, .8, 1.4, oakDark)
          box(group, X + 2.47, .6, Z + .3, .035, .52, .82, graphite)
          box(group, X + 1.4, .23, Z + D * .8, .9, .16, .5, oak)
          disk(group, X + 1.4, .13, Z + D * .8, .55, .01, fabric)
        } else if (area.room === 'mesa-de-jantar') {
          box(group, X + W * .52, .44, Z + D * .54, 2, .13, 1.04, oak)
          for (const dx of [-.75, .75]) for (const dz of [-.37, .37]) box(group, X + W * .52 + dx, .22, Z + D * .54 + dz, .09, .38, .09, oakDark)
          for (const dx of [-1.26, 1.26]) disk(group, X + W * .52 + dx, .2, Z + D * .54, .27, .3, fabric)
          for (const dx of [-.55, .55]) {
            disk(group, X + W * .52 + dx, 1.07, Z + D * .54, .23, .12, glow)
            box(group, X + W * .52 + dx, 1.3, Z + D * .54, .02, .36, .02, graphite, false)
          }
        } else if (area.room === 'office') {
          box(group, X + 1.5, .45, Z + .74, 1.95, .12, .8, oak)
          box(group, X + 1.5, .25, Z + .74, .08, .43, .7, graphite)
          box(group, X + 1.5, .82, Z + .58, .85, .52, .055, graphite)
          disk(group, X + 1.5, .23, Z + 1.8, .3, .3, graphite)
          for (const level of [.35, .68, 1]) box(group, X + 2.85, level, Z + 2.4, .32, .06, 1.85, oakDark)
        } else if (area.room === 'quarto') {
          box(group, X + W * .5, .25, Z + D * .56, 1.9, .34, 2.25, fabric)
          box(group, X + W * .5, .32, Z + D * .39, 1.78, .12, 1.45, plaster)
          box(group, X + W * .5, .55, Z + .48, 2.05, .73, .16, oakDark)
          for (const dx of [-.46, .46]) box(group, X + W * .5 + dx, .42, Z + 1.28, .75, .16, .38, edge)
          for (const dx of [-1.17, 1.17]) box(group, X + W * .5 + dx, .31, Z + .55, .35, .4, .4, oak)
        } else if (area.room === 'cozinha') {
          box(group, X + W * .5, .4, Z + .38, W - .45, .7, .55, oakLight)
          box(group, X + .38, .39, Z + D * .55, .55, .7, D - .7, oakLight)
          box(group, X + W * .56, .77, Z + .38, W * .47, .055, .56, stone)
          box(group, X + W * .65, .75, Z + .39, .48, .008, .32, graphite, false)
        } else if (area.room === 'banheiro' || area.room === 'banheiro-da-suite') {
          box(group, X + .42, .39, Z + .42, .62, .58, .55, oakLight)
          disk(group, X + .42, .72, Z + .42, .18, .06, edge)
          box(group, X + W - .48, .54, Z + D - .6, .035, .95, 1.1, glass, false)
          disk(group, X + W - .52, .15, Z + D - .56, .38, .05, stone)
        }
      }
      if (lit && !dim) {
        const point = new THREE.PointLight('#ffd090', 5, Math.max(area.w, area.h) * 2.5)
        point.position.set(area.x + area.w / 2, 1.7, area.y + area.h / 2)
        group.add(point)
        disk(group, area.x + area.w / 2, 1.38, area.y + area.h / 2, .16, .06, glow)
      }
      if (acOn && !dim) {
        box(group, area.x + area.w / 2, .72, area.y + .17, .75, .3, .18, edge)
        for (let i = 0; i < 3; i++) {
          const geometry = new THREE.TorusGeometry(.3 + i * .19, .018, 6, 32, Math.PI * 1.4)
          geometries.push(geometry)
          const ring = new THREE.Mesh(geometry, air)
          ring.rotation.x = -Math.PI / 2
          ring.rotation.z = .55
          ring.position.set(area.x + area.w / 2, .22 + i * .16, area.y + .7 + i * .34)
          group.add(ring); rings.push(ring)
        }
      }
      if (room && [...room.lights, ...room.acs].some(device => !device.state.online)) disk(group, area.x + area.w / 2, 1.17, area.y + area.h / 2, .08, .08, mat(color('--alert')))
      label(group, area, dim || !room)
    }
    const raycaster = new THREE.Raycaster()
    const mouse = new THREE.Vector2()
    let downX = 0
    let dragging = false
    let frame = 0
    let disposed = false
    const onDown = (event: PointerEvent) => { downX = event.clientX; dragging = false }
    const onMove = (event: PointerEvent) => {
      if (event.buttons === 1) {
        const delta = event.clientX - downX
        if (Math.abs(delta) > 3) dragging = true
        yaw = Math.max(-Math.PI / 6, Math.min(Math.PI / 6, yaw + delta * .003))
        downX = event.clientX
        wake()
      } else {
        const rect = renderer.domElement.getBoundingClientRect()
        mouse.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1)
        raycaster.setFromCamera(mouse, camera)
        highlightRef.current(raycaster.intersectObjects(hitMeshes)[0]?.object.userData.roomId ?? null)
      }
    }
    const onClick = (event: MouseEvent) => {
      if (dragging) return
      const rect = renderer.domElement.getBoundingClientRect()
      mouse.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1)
      raycaster.setFromCamera(mouse, camera)
      const id = raycaster.intersectObjects(hitMeshes)[0]?.object.userData.roomId
      if (id) selectRef.current(id)
    }
    const onLeave = () => highlightRef.current(null)
    const desiredHeight = roomArea ? Math.max(roomArea.h + .2, 4.1) : 11.1
    const animate = (time: number) => {
      if (disposed) return
      frame = 0
      const moving = center.distanceToSquared(endTarget) > .0001 || Math.abs(viewHeight - desiredHeight) > .001
      center.lerp(endTarget, reduced ? 1 : .14)
      viewHeight += (desiredHeight - viewHeight) * (reduced ? 1 : .14)
      if (!moving) { center.copy(endTarget); viewHeight = desiredHeight }
      setCamera()
      if (!reduced) rings.forEach((ring, index) => { ring.position.y = .23 + (index % 3) * .16 + .025 * Math.sin(time / 650 + index) })
      renderer.render(scene, camera)
      if ((!reduced && moving) || (!reduced && rings.length > 0)) wake()
    }
    const wake = () => { if (!disposed && !frame) frame = requestAnimationFrame(animate) }
    wake()
    const onLost = (event: Event) => { event.preventDefault(); setFallback(true) }
    renderer.domElement.addEventListener('webglcontextlost', onLost)
    renderer.domElement.addEventListener('pointerdown', onDown)
    renderer.domElement.addEventListener('pointermove', onMove)
    renderer.domElement.addEventListener('click', onClick)
    renderer.domElement.addEventListener('pointerleave', onLeave)
    return () => {
      disposed = true
      cameraPose = { center: center.clone(), height: viewHeight }
      cancelAnimationFrame(frame)
      renderer.domElement.removeEventListener('webglcontextlost', onLost)
      renderer.domElement.removeEventListener('pointerdown', onDown)
      renderer.domElement.removeEventListener('pointermove', onMove)
      renderer.domElement.removeEventListener('click', onClick)
      renderer.domElement.removeEventListener('pointerleave', onLeave)
      host.removeChild(renderer.domElement)
      geometries.forEach(item => item.dispose())
      materials.forEach(item => item.dispose())
      textures.forEach(item => item.dispose())
      sun.shadow.map?.dispose()
      renderer.dispose()
    }
  }, [props.rooms, props.highlighted, props.selected, fallback])
  return <div className="mapStage" ref={mount} data-map-fallback={fallback}>{fallback && <SvgPlan {...props} />}</div>
}
