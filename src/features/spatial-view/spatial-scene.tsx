import { Canvas, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { geometry } from '../../core/geometry-engine'
import type { ProjectDocumentV1 } from '../../domain/model'
import { registerAuthoritative3dCapture } from './render-capture'
import { planBounds, wallBlocks } from './scene-geometry'

const CAPTURE_WIDTH = 1536
const CAPTURE_HEIGHT = 1024

async function sha256(bytes: BufferSource) {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function nextFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
}

function canvasBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Three.js did not produce a PNG capture.'))),
      'image/png',
    )
  })
}

interface SceneProps {
  approved: ProjectDocumentV1
  staged: ProjectDocumentV1
  draftIds: string[]
  selectedIds: string[]
  mode: '3d'
}

function CameraRig({ project, selectedIds }: Pick<SceneProps, 'selectedIds'> & { project: ProjectDocumentV1 }) {
  const { camera, gl, size } = useThree()
  const controls = useRef<OrbitControls | null>(null)
  const bounds = useMemo(() => planBounds(project), [project])
  useEffect(() => {
    const orbit = new OrbitControls(camera, gl.domElement)
    orbit.enableDamping = true
    orbit.dampingFactor = 0.08
    orbit.screenSpacePanning = true
    orbit.minZoom = 18
    orbit.maxZoom = 180
    controls.current = orbit
    let frame = 0
    const tick = () => {
      orbit.update()
      frame = requestAnimationFrame(tick)
    }
    tick()
    return () => {
      cancelAnimationFrame(frame)
      orbit.dispose()
      controls.current = null
    }
  }, [camera, gl])
  useEffect(() => {
    const target =
      selectedCenter(project, selectedIds) ?? ([bounds.centerX, 0, bounds.centerY] as [number, number, number])
    const span = Math.max(bounds.width, bounds.height, 6)
    camera.up.set(0, 1, 0)
    camera.position.set(target[0] + span * 0.85, span * 0.9, target[2] + span * 0.85)
    camera.lookAt(...target)
    if (camera instanceof THREE.OrthographicCamera) {
      camera.zoom = selectedIds.length
        ? 92
        : Math.max(24, Math.min(size.width / (bounds.width * 1.45), size.height / (bounds.height * 1.45)))
      camera.updateProjectionMatrix()
    }
    controls.current?.target.set(...target)
    controls.current?.update()
  }, [bounds, camera, project, selectedIds, size])
  return null
}

function CaptureBridge({ project }: { project: ProjectDocumentV1 }) {
  const { gl, scene } = useThree()
  useEffect(() => {
    let mounted = true
    const unregister = registerAuthoritative3dCapture(async () => {
      await nextFrame()
      if (!mounted) throw new Error('The 3D scene was closed before capture completed.')
      const canvas = document.createElement('canvas')
      const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: true })
      renderer.setPixelRatio(1)
      renderer.setSize(CAPTURE_WIDTH, CAPTURE_HEIGHT, false)
      renderer.outputColorSpace = gl.outputColorSpace
      renderer.toneMapping = gl.toneMapping
      const bounds = planBounds(project)
      const aspect = CAPTURE_WIDTH / CAPTURE_HEIGHT
      const halfHeight = Math.max(3, (bounds.height * 1.45) / 2, (bounds.width * 1.45) / (2 * aspect))
      const captureCamera = new THREE.OrthographicCamera(
        -halfHeight * aspect,
        halfHeight * aspect,
        halfHeight,
        -halfHeight,
        0.01,
        200,
      )
      const span = Math.max(bounds.width, bounds.height, 6)
      captureCamera.position.set(bounds.centerX + span * 0.85, span * 0.9, bounds.centerY + span * 0.85)
      captureCamera.lookAt(bounds.centerX, 0, bounds.centerY)
      captureCamera.updateProjectionMatrix()
      const restoredColors: Array<{ material: THREE.MeshStandardMaterial; color: THREE.Color }> = []
      scene.traverse((object) => {
        if (
          object instanceof THREE.Mesh &&
          object.userData.authoritativeWall === true &&
          object.material instanceof THREE.MeshStandardMaterial
        ) {
          restoredColors.push({ material: object.material, color: object.material.color.clone() })
          object.material.color.set('#ffffff')
        }
      })
      let blob: Blob
      try {
        renderer.render(scene, captureCamera)
        blob = await canvasBlob(canvas)
      } finally {
        for (const restored of restoredColors) restored.material.color.copy(restored.color)
        renderer.dispose()
      }
      const [sourceHash, documentHash] = await Promise.all([
        sha256(await blob.arrayBuffer()),
        sha256(new TextEncoder().encode(JSON.stringify(project))),
      ])
      return {
        blob,
        manifest: {
          documentHash,
          sourceHash,
          width: CAPTURE_WIDTH,
          height: CAPTURE_HEIGHT,
          renderer: 'three.js' as const,
          rendererVersion: THREE.REVISION,
          capturedAt: new Date().toISOString(),
          camera: {
            position: captureCamera.position.toArray(),
            quaternion: captureCamera.quaternion.toArray(),
            projectionMatrix: captureCamera.projectionMatrix.toArray(),
          },
        },
      }
    })
    return () => {
      mounted = false
      unregister()
    }
  }, [gl, project, scene])
  return null
}

function selectedCenter(project: ProjectDocumentV1, ids: string[]): [number, number, number] | null {
  const points: Array<[number, number]> = []
  for (const id of ids) {
    const wall = project.floor.walls.find((item) => item.id === id)
    if (wall) points.push([(wall.start.x + wall.end.x) / 2000, (wall.start.y + wall.end.y) / 2000])
    const room = project.floor.roomMarkers.find((item) => item.id === id)
    if (room) points.push([room.position.x / 1000, room.position.y / 1000])
    const item = project.floor.furniture.find((entry) => entry.id === id)
    if (item) points.push([item.position.x / 1000, item.position.y / 1000])
  }
  return points.length
    ? [
        points.reduce((sum, point) => sum + point[0], 0) / points.length,
        0,
        points.reduce((sum, point) => sum + point[1], 0) / points.length,
      ]
    : null
}

function FloorMeshes({
  project,
  draftIds = [],
  draft = false,
}: {
  project: ProjectDocumentV1
  draftIds?: string[]
  draft?: boolean
}) {
  const rooms = useMemo(() => geometry.deriveRooms(project.floor), [project])
  return (
    <>
      {rooms
        .filter((room) => !draft || draftIds.includes(room.id))
        .map((room) => {
          const shape = new THREE.Shape(room.polygon.map((point) => new THREE.Vector2(point.x / 1000, point.y / 1000)))
          return (
            <mesh
              key={`${draft ? 'draft' : 'approved'}:${room.id}`}
              rotation={[-Math.PI / 2, 0, 0]}
              position={[0, draft ? 0.035 : 0, 0]}
            >
              <shapeGeometry args={[shape]} />
              <meshStandardMaterial
                color={draft ? '#ff6b2c' : '#f7f4f2'}
                transparent={draft}
                opacity={draft ? 0.22 : 1}
                side={THREE.DoubleSide}
              />
            </mesh>
          )
        })}
    </>
  )
}

function WallMeshes({
  project,
  draftIds = [],
  draft = false,
  selectedIds = [],
}: {
  project: ProjectDocumentV1
  draftIds?: string[]
  draft?: boolean
  selectedIds?: string[]
}) {
  return (
    <>
      {project.floor.walls
        .filter((wall) => !draft || draftIds.includes(wall.id))
        .flatMap((wall) => {
          const relatedRoom = project.floor.roomStyles[0]
          const blocks = wallBlocks(project.floor, wall, relatedRoom?.ceilingHeightMm ?? 2800)
          return blocks.map((block) => (
            <mesh
              key={`${draft ? 'draft' : 'approved'}:${block.id}`}
              position={block.center}
              rotation={[0, block.rotation, 0]}
              userData={{ authoritativeWall: !draft }}
            >
              <boxGeometry args={block.size} />
              <meshStandardMaterial
                color={draft ? '#ff6b2c' : selectedIds.includes(wall.id) ? '#d8d1cd' : '#ffffff'}
                transparent={draft}
                opacity={draft ? 0.45 : 1}
                roughness={0.92}
              />
              {!draft && (
                <lineSegments>
                  <edgesGeometry args={[new THREE.BoxGeometry(...block.size)]} />
                  <lineBasicMaterial color="#292624" />
                </lineSegments>
              )}
            </mesh>
          ))
        })}
    </>
  )
}

function FurnitureMeshes({
  project,
  draftIds = [],
  draft = false,
}: {
  project: ProjectDocumentV1
  draftIds?: string[]
  draft?: boolean
}) {
  return (
    <>
      {project.floor.furniture
        .filter((item) => !draft || draftIds.includes(item.id))
        .map((item) => (
          <mesh
            key={`${draft ? 'draft' : 'approved'}:${item.id}`}
            position={[item.position.x / 1000, 0.24, item.position.y / 1000]}
            rotation={[0, -THREE.MathUtils.degToRad(item.rotationDegrees), 0]}
          >
            <boxGeometry args={[item.widthMm / 1000, 0.45, item.depthMm / 1000]} />
            <meshStandardMaterial
              color={draft ? '#ff6b2c' : '#c8bfba'}
              transparent={draft}
              opacity={draft ? 0.5 : 1}
              roughness={0.9}
            />
          </mesh>
        ))}
    </>
  )
}

function Scene(props: SceneProps) {
  return (
    <>
      <color attach="background" args={['#f8f5f3']} />
      <ambientLight intensity={2.2} />
      <directionalLight position={[8, 16, 8]} intensity={2.8} />
      <CameraRig project={props.staged} selectedIds={props.selectedIds} />
      <CaptureBridge project={props.staged} />
      <FloorMeshes project={props.approved} />
      <WallMeshes project={props.approved} selectedIds={props.selectedIds} />
      <FurnitureMeshes project={props.approved} />
      {props.draftIds.length > 0 && (
        <>
          <FloorMeshes project={props.staged} draftIds={props.draftIds} draft />
          <WallMeshes project={props.staged} draftIds={props.draftIds} draft />
          <FurnitureMeshes project={props.staged} draftIds={props.draftIds} draft />
        </>
      )}
      <gridHelper
        args={[40, 80, '#d6cfcb', '#ebe5e1']}
        position={[planBounds(props.staged).centerX, -0.02, planBounds(props.staged).centerY]}
      />
    </>
  )
}

export default function SpatialScene(props: SceneProps) {
  return (
    <Canvas
      orthographic
      dpr={[1, 2]}
      camera={{ near: 0.01, far: 200, zoom: 50 }}
      gl={{ antialias: true, alpha: false, powerPreference: 'high-performance' }}
    >
      <Scene {...props} />
    </Canvas>
  )
}
