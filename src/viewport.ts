import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { buildDemo, type DemoPreset } from './demo-model';

export type ViewChannel = 'material' | 'baseColor' | 'roughness' | 'metallic' | 'normal' | 'height';
export type TextureCanvases = Partial<Record<Exclude<ViewChannel, 'material'>, HTMLCanvasElement>>;
export interface PaintHit {
  uv: { x: number; y: number }; setId: string; pressure: number; x: number; y: number;
  meshId: string; triangleUV: { x: number; y: number }[];
  faceIndex: number;
  islandId: string;
}
export interface ModelInfo { name: string; sets: { id: string; name: string; color?: string; roughness?: number; metallic?: number }[]; triangleCount: number; warnings: string[] }
export interface ViewportCallbacks {
  onPaintStart?(hit: PaintHit): void; onPaint?(hit: PaintHit): void; onPaintEnd?(): void;
  onHover?(hit: PaintHit | null): void; onImportInfo?(info: ModelInfo): void;
}
interface SetRecord { id: string; name: string; color: number; roughness: number; metalness: number }
interface ModelData {
  version: 1; name: string; sets: SetRecord[];
  meshes: { name: string; geometry: THREE.BufferGeometryJSON; matrix: number[]; sets: string[] }[];
}

function validateGeometry(geometry: THREE.BufferGeometry, materialCount: number): number {
  const position = geometry.getAttribute('position');
  if (!position || position.itemSize !== 3 || !Number.isInteger(position.count) || !position.count || position.count > 6_000_000) throw new Error('The model has invalid position data.');
  const attributes = [...Object.entries(geometry.attributes), ...Object.entries(geometry.morphAttributes).flatMap(([name, values]) => values.map(attribute => [name, attribute] as const))];
  for (const [name, attribute] of attributes) {
    if (!Number.isInteger(attribute.itemSize) || attribute.itemSize < 1 || attribute.itemSize > 4 || attribute.count !== position.count || (name === 'uv' && attribute.itemSize !== 2) || (name === 'normal' && attribute.itemSize !== 3)) throw new Error(`Invalid ${name} vertex attribute.`);
    for (const value of attribute.array) if (!Number.isFinite(value)) throw new Error(`The ${name} vertex attribute contains non-finite values.`);
  }
  const count = geometry.index?.count ?? position.count;
  if (!count || count % 3 || count > 6_000_000) throw new Error('The model has invalid triangle data.');
  if (geometry.index) {
    if (geometry.index.itemSize !== 1) throw new Error('The model has invalid triangle indices.');
    for (const index of geometry.index.array) if (!Number.isInteger(index) || index < 0 || index >= position.count) throw new Error('A model triangle refers to a missing vertex.');
  }
  for (const group of geometry.groups) {
    if (!Number.isInteger(group.start) || !Number.isInteger(group.count) || group.start < 0 || group.count <= 0 || group.start % 3 || group.count % 3 || group.start + group.count > count || !Number.isInteger(group.materialIndex) || group.materialIndex! < 0 || group.materialIndex! >= materialCount) throw new Error('The model contains an invalid material group.');
  }
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  return count / 3;
}

function validateBounds(group: THREE.Group) {
  const bounds = new THREE.Box3().setFromObject(group), size = bounds.getSize(new THREE.Vector3());
  if (!Number.isFinite(size.length()) || size.length() === 0 || !bounds.min.toArray().every(Number.isFinite) || !bounds.max.toArray().every(Number.isFinite)) throw new Error('The model has no valid spatial bounds.');
  return { bounds, size };
}

export class PainterViewport {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera = new THREE.PerspectiveCamera(38, 1, .01, 1000);
  readonly scene = new THREE.Scene();
  readonly controls: OrbitControls;
  private model = new THREE.Group();
  private raycaster = new THREE.Raycaster();
  private materials = new Map<string, THREE.MeshStandardMaterial>();
  private textures = new Map<string, Partial<Record<Exclude<ViewChannel, 'material'>, THREE.CanvasTexture>>>();
  private channelTextures = new Map<string, THREE.Texture>();
  private channel: ViewChannel = 'material';
  private wireframe = false;
  private painting = false;
  private paintEnabled = true;
  private activeSet = '';
  private highlightedSet: string | null = null;
  private cameraDirection = new THREE.Vector3(2.7, 1.25, 5.4).normalize();
  private islandCache = new Map<string, { faceIslands: Map<number, number>; islands: number[][][] }>();
  private uvPaths = new Map<string, { path: Path2D; withinTile: boolean }>();
  private uvOverlays = new Map<string, { key: string; canvas: HTMLCanvasElement; x: number; y: number; scaleX: number; scaleY: number }>();
  private resizeObserver: ResizeObserver;
  private animation = 0;
  private disposed = false;
  private environment: THREE.WebGLRenderTarget;
  private floor: THREE.Mesh;
  private grid: THREE.GridHelper;
  private modelInfo: ModelInfo = { name: '', sets: [], triangleCount: 0, warnings: [] };
  private bindings: (() => void)[] = [];

  constructor(private container: HTMLElement, private callbacks: ViewportCallbacks = {}) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.setAttribute('aria-label', '3D painting viewport. Paint with the left mouse button. Hold Alt to orbit. Right or middle mouse button pans. F frames the model.');
    this.renderer.domElement.tabIndex = 0;
    this.renderer.domElement.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;outline:none';
    this.container.append(this.renderer.domElement);
    this.scene.background = new THREE.Color('#28292b');
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    this.environment = pmrem.fromScene(room, .04);
    this.scene.environment = this.environment.texture;
    room.dispose(); pmrem.dispose();
    this.scene.environmentIntensity = .7;
    this.scene.add(new THREE.HemisphereLight('#eff4ff', '#202125', 1.1));
    const key = new THREE.DirectionalLight('#fff1d9', 3.2);
    key.position.set(3, 5, 4);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = key.shadow.camera.bottom = -5;
    key.shadow.camera.right = key.shadow.camera.top = 5;
    key.shadow.normalBias = .025;
    this.scene.add(key);
    const rim = new THREE.DirectionalLight('#b8d8ff', 2.1);
    rim.position.set(-4, 2, -3);
    this.scene.add(rim);
    this.floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.ShadowMaterial({ opacity: .22 }));
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.receiveShadow = true;
    this.scene.add(this.floor);
    this.grid = new THREE.GridHelper(20, 40, '#3e4144', '#333538');
    this.grid.visible = false;
    this.scene.add(this.grid);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = .13;
    this.controls.minDistance = .1;
    this.controls.maxDistance = 100;
    this.controls.mouseButtons.LEFT = undefined as unknown as THREE.MOUSE;
    this.controls.mouseButtons.MIDDLE = THREE.MOUSE.PAN;
    this.controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
    this.controls.screenSpacePanning = true;
    this.controls.zoomSpeed = .8;
    // Capture runs before OrbitControls so Alt + left is assigned before its pointer handler.
    this.listen(this.renderer.domElement, 'pointerdown', this.pointerDown, true);
    this.listen(this.renderer.domElement, 'pointermove', this.pointerMove);
    this.listen(this.renderer.domElement, 'pointerup', this.pointerUp);
    this.listen(this.renderer.domElement, 'pointercancel', this.pointerUp);
    this.listen(this.renderer.domElement, 'lostpointercapture', this.pointerUp);
    this.listen(this.renderer.domElement, 'pointerleave', () => { if (!this.painting) this.callbacks.onHover?.(null); });
    this.listen(this.renderer.domElement, 'contextmenu', (event: Event) => event.preventDefault());
    this.listen(window, 'keydown', (event: Event) => {
      const e = event as KeyboardEvent;
      if (e.code === 'AltLeft' || e.code === 'AltRight') this.controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
      if (e.code === 'KeyF' && !this.isTextInput(e.target)) { this.frame(); e.preventDefault(); }
    });
    this.listen(window, 'keyup', (event: Event) => {
      if (!(event as KeyboardEvent).altKey) this.controls.mouseButtons.LEFT = undefined as unknown as THREE.MOUSE;
    });
    this.listen(window, 'blur', () => { this.pointerUp(); this.controls.mouseButtons.LEFT = undefined as unknown as THREE.MOUSE; });
    this.resizeObserver = new ResizeObserver(this.resize);
    this.resizeObserver.observe(this.container);
    this.resize();
    const tick = () => {
      if (this.disposed) return;
      this.animation = requestAnimationFrame(tick);
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    tick();
  }

  private listen(target: EventTarget, type: string, handler: EventListener | ((event: any) => void), capture = false) {
    target.addEventListener(type, handler, capture);
    this.bindings.push(() => target.removeEventListener(type, handler, capture));
  }
  private isTextInput(target: EventTarget | null) { return target instanceof HTMLElement && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable); }
  private resize = () => {
    const width = Math.max(1, this.container.clientWidth), height = Math.max(1, this.container.clientHeight);
    this.camera.aspect = width / height; this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  };
  private pointerDown = (event: PointerEvent) => {
    this.renderer.domElement.focus({ preventScroll: true });
    this.controls.mouseButtons.LEFT = event.altKey ? THREE.MOUSE.ROTATE : undefined as unknown as THREE.MOUSE;
    if (event.button !== 0 || event.altKey || !this.paintEnabled) return;
    const hit = this.hit(event);
    if (!hit) return;
    event.preventDefault(); event.stopImmediatePropagation();
    this.painting = true;
    this.renderer.domElement.setPointerCapture(event.pointerId);
    this.callbacks.onPaintStart?.(hit);
  };
  private pointerMove = (event: PointerEvent) => {
    if (event.altKey) { this.callbacks.onHover?.(null); return; }
    const hit = this.hit(event);
    this.callbacks.onHover?.(hit);
    if (this.painting && hit) this.callbacks.onPaint?.(hit);
  };
  private pointerUp = () => {
    if (this.painting) { this.painting = false; this.callbacks.onPaintEnd?.(); }
  };
  private hit(event: PointerEvent): PaintHit | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.raycaster.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1), this.camera);
    const intersection = this.raycaster.intersectObject(this.model, true)[0];
    if (!intersection || !intersection.uv || !intersection.face || intersection.uv.x < 0 || intersection.uv.x > 1 || intersection.uv.y < 0 || intersection.uv.y > 1) return null;
    const mesh = intersection.object as THREE.Mesh;
    const setId = mesh.userData.setIds?.[intersection.face.materialIndex] ?? mesh.userData.setIds?.[0];
    if (!setId) return null;
    const uv = mesh.geometry.getAttribute('uv');
    const triangleUV = [intersection.face.a, intersection.face.b, intersection.face.c].map(index => ({ x: uv.getX(index), y: uv.getY(index) }));
    const hit: PaintHit = { uv: { x: intersection.uv.x, y: intersection.uv.y }, setId, pressure: event.pointerType === 'pen' ? event.pressure : 1, x: event.clientX - rect.left, y: event.clientY - rect.top, meshId: mesh.uuid, triangleUV, faceIndex: intersection.faceIndex ?? 0, islandId: '' };
    return this.identifyIsland(hit);
  }
  private identifyIsland(hit: PaintHit): PaintHit {
    this.getUVIslandTriangles(hit);
    const key = `${hit.meshId}:${hit.setId}`;
    hit.islandId = `${key}:${this.islandCache.get(key)?.faceIslands.get(hit.faceIndex) ?? hit.faceIndex}`;
    return hit;
  }

  pickUV(u: number, v: number, setId = this.activeSet): PaintHit | null {
    if (!Number.isFinite(u) || !Number.isFinite(v) || u < 0 || u > 1 || v < 0 || v > 1) return null;
    let result: PaintHit | null = null;
    this.model.traverse(object => {
      if (result || !(object instanceof THREE.Mesh)) return;
      const geometry = object.geometry, uv = geometry.getAttribute('uv');
      if (!uv) return;
      const groups = geometry.groups.length ? geometry.groups : [{ start: 0, count: geometry.index?.count ?? uv.count, materialIndex: 0 }];
      for (const group of groups) {
        if (object.userData.setIds[group.materialIndex ?? 0] !== setId) continue;
        for (let i = group.start; i < group.start + group.count; i += 3) {
          const ids = [0, 1, 2].map(n => geometry.index ? geometry.index.getX(i + n) : i + n);
          const triangleUV = ids.map(index => ({ x: uv.getX(index), y: uv.getY(index) }));
          const [a, b, c] = triangleUV;
          const denominator = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
          if (Math.abs(denominator) < 1e-14) continue;
          const alpha = ((b.y - c.y) * (u - c.x) + (c.x - b.x) * (v - c.y)) / denominator;
          const beta = ((c.y - a.y) * (u - c.x) + (a.x - c.x) * (v - c.y)) / denominator;
          if (alpha < -1e-7 || beta < -1e-7 || alpha + beta > 1 + 1e-7) continue;
          result = this.identifyIsland({ uv: { x: u, y: v }, setId, pressure: 1, x: 0, y: 0, meshId: object.uuid, faceIndex: i / 3, triangleUV, islandId: '' });
          return;
        }
      }
    });
    return result;
  }

  loadDemo(preset: DemoPreset = 'helmet'): ModelInfo {
    return this.installModel(buildDemo(preset), []);
  }
  setPaintEnabled(enabled: boolean) { this.paintEnabled = enabled; if (!enabled) this.pointerUp(); }
  setTextureSet(setId: string, canvases: TextureCanvases, changedChannels?: readonly (keyof TextureCanvases)[]) {
    let records = this.textures.get(setId);
    if (!records) { records = {}; this.textures.set(setId, records); }
    let replaced = false;
    for (const [key, canvas] of Object.entries(canvases)) {
      const channel = key as keyof TextureCanvases;
      if (!canvas) continue;
      if (records[channel]?.image === canvas) {
        if (!changedChannels || changedChannels.includes(channel)) records[channel]!.needsUpdate = true;
        continue;
      }
      records[channel]?.dispose();
      replaced = true;
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = channel === 'baseColor' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
      texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
      records[channel] = texture;
    }
    if (replaced) { this.channelTextures.get(setId)?.dispose(); this.channelTextures.delete(setId); }
    else if (!changedChannels || changedChannels.includes(this.channel as keyof TextureCanvases)) {
      const displayTexture = this.channelTextures.get(setId); if (displayTexture) displayTexture.needsUpdate = true;
    }
    if (replaced) this.applyMaterial(setId);
  }
  updateTextures(setId?: string, changedChannels?: readonly (keyof TextureCanvases)[]) {
    this.textures.forEach((maps, id) => {
      if (setId && id !== setId) return;
      Object.entries(maps).forEach(([channel, texture]) => { if (texture && (!changedChannels || changedChannels.includes(channel as keyof TextureCanvases))) texture.needsUpdate = true; });
      const displayTexture = this.channelTextures.get(id); if (displayTexture && (!changedChannels || changedChannels.includes(this.channel as keyof TextureCanvases))) displayTexture.needsUpdate = true;
    });
  }
  setChannel(channel: ViewChannel) {
    this.channelTextures.forEach(texture => texture.dispose()); this.channelTextures.clear();
    this.channel = channel; this.materials.forEach((_, id) => this.applyMaterial(id));
  }
  setWireframe(enabled: boolean) { this.wireframe = enabled; this.materials.forEach(material => { material.wireframe = enabled; material.needsUpdate = true; }); }
  setActiveSet(setId: string) { this.activeSet = setId; }
  highlightSet(setId: string | null) {
    if (this.highlightedSet === setId) return;
    this.highlightedSet = setId;
    if (this.channel === 'material') this.materials.forEach((material, id) => material.emissive.set(id === setId ? 0x182f42 : 0));
  }
  setCameraView(view: 'front' | 'back' | 'left' | 'right' | 'top' | 'default') {
    const directions = { front: [0, 0, 1], back: [0, 0, -1], left: [-1, 0, 0], right: [1, 0, 0], top: [0, 1, 0], default: [2.7, 1.25, 5.4] };
    this.cameraDirection.fromArray(directions[view]).normalize();
    this.camera.up.set(0, view === 'top' ? 0 : 1, view === 'top' ? -1 : 0);
    this.frame();
  }
  setGrid(visible: boolean) { this.grid.visible = visible; }
  setEnvironmentRotation(radians: number) { this.scene.environmentRotation.y = radians; }
  setExposure(value: number) { this.renderer.toneMappingExposure = value; }
  setBackground(color: string) { this.scene.background = new THREE.Color(color); }
  screenshot(): string { this.renderer.render(this.scene, this.camera); return this.renderer.domElement.toDataURL('image/png'); }

  private applyMaterial(setId: string) {
    const material = this.materials.get(setId);
    if (!material) return;
    const maps = this.textures.get(setId) ?? {};
    const defaults = material.userData.defaults as SetRecord;
    material.map = null; material.roughnessMap = null; material.metalnessMap = null; material.normalMap = null; material.bumpMap = null;
    material.color.set(defaults.color); material.roughness = defaults.roughness; material.metalness = defaults.metalness;
    material.emissive.set(0); material.emissiveMap = null;
    material.toneMapped = this.channel === 'material';
    material.envMapIntensity = this.channel === 'material' ? 1 : 0;
    if (this.channel === 'material') {
      material.emissive.set(this.highlightedSet === setId ? 0x182f42 : 0);
      material.map = maps.baseColor ?? null;
      if (maps.baseColor) material.color.set(0xffffff);
      material.roughnessMap = maps.roughness ?? null; if (maps.roughness) material.roughness = 1;
      material.metalnessMap = maps.metallic ?? null; if (maps.metallic) material.metalness = 1;
      material.normalMap = maps.normal ?? null;
      material.bumpMap = maps.height ?? null; material.bumpScale = .065;
    } else {
      const texture = maps[this.channel];
      material.color.set(0x000000);
      material.emissive.set(this.channel === 'normal' && !texture ? 0x8080ff : 0xffffff);
      // Channel inspection must display stored pixels, including linear-data maps, without tone mapping.
      if (texture && texture.colorSpace !== THREE.SRGBColorSpace) {
        let displayTexture = this.channelTextures.get(setId);
        if (!displayTexture) { displayTexture = texture.clone(); displayTexture.colorSpace = THREE.SRGBColorSpace; displayTexture.needsUpdate = true; this.channelTextures.set(setId, displayTexture); }
        material.emissiveMap = displayTexture;
      } else material.emissiveMap = texture ?? null;
      material.roughness = 1; material.metalness = 0;
      if (!texture && this.channel !== 'normal') {
        if (this.channel === 'baseColor') material.emissive.set(defaults.color);
        else material.emissive.setScalar(this.channel === 'metallic' ? defaults.metalness : this.channel === 'roughness' ? defaults.roughness : .5).convertSRGBToLinear();
      }
    }
    material.wireframe = this.wireframe;
    material.needsUpdate = true;
  }

  frame() {
    const bounds = new THREE.Box3().setFromObject(this.model);
    if (bounds.isEmpty()) return;
    const sphere = bounds.getBoundingSphere(new THREE.Sphere());
    const halfFov = THREE.MathUtils.degToRad(this.camera.fov / 2);
    const direction = this.cameraDirection.clone();
    this.controls.target.copy(sphere.center);
    this.camera.position.copy(sphere.center).add(direction); this.camera.lookAt(sphere.center);
    const inverse = this.camera.quaternion.clone().invert();
    let distance = 0;
    for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
      const corner = new THREE.Vector3(x, y, z).sub(sphere.center).applyQuaternion(inverse);
      distance = Math.max(distance, Math.abs(corner.y) / Math.tan(halfFov) + corner.z, Math.abs(corner.x) / (Math.tan(halfFov) * this.camera.aspect) + corner.z);
    }
    this.camera.position.copy(sphere.center).add(direction.multiplyScalar(distance * 1.08));
    this.camera.near = Math.max(.001, sphere.radius / 200); this.camera.far = sphere.radius * 200;
    this.camera.updateProjectionMatrix();
    this.controls.minDistance = sphere.radius * .15; this.controls.maxDistance = sphere.radius * 20;
    this.controls.update();
  }

  getUVTriangles(setId: string, meshId?: string): number[][] {
    const triangles: number[][] = [];
    this.model.traverse(object => {
      if (!(object instanceof THREE.Mesh) || (meshId && object.uuid !== meshId)) return;
      const geometry = object.geometry as THREE.BufferGeometry, uv = geometry.getAttribute('uv');
      if (!uv) return;
      const groups = geometry.groups.length ? geometry.groups : [{ start: 0, count: geometry.index?.count ?? uv.count, materialIndex: 0 }];
      for (const group of groups) {
        if (object.userData.setIds[group.materialIndex ?? 0] !== setId) continue;
        for (let i = group.start; i < group.start + group.count; i += 3) {
          const ids = [0, 1, 2].map(n => geometry.index ? geometry.index.getX(i + n) : i + n);
          triangles.push(ids.flatMap(index => [uv.getX(index), uv.getY(index)]));
        }
      }
    });
    return triangles;
  }
  getUVIslandTriangles(hit: PaintHit): number[][] {
    const cacheKey = `${hit.meshId}:${hit.setId}`;
    let cached = this.islandCache.get(cacheKey);
    if (!cached) {
      const mesh = this.model.getObjectByProperty('uuid', hit.meshId) as THREE.Mesh | undefined;
      if (!mesh?.isMesh) return [];
      const geometry = mesh.geometry, uv = geometry.getAttribute('uv'), position = geometry.getAttribute('position');
      if (!uv || !position) return [];
      const groups = geometry.groups.length ? geometry.groups : [{ start: 0, count: geometry.index?.count ?? uv.count, materialIndex: 0 }];
      geometry.computeBoundingBox();
      const scale = 1e7 / Math.max(1e-12, geometry.boundingBox!.getSize(new THREE.Vector3()).length());
      const vertexKey = (i: number) => `${Math.round(position.getX(i) * scale)},${Math.round(position.getY(i) * scale)},${Math.round(position.getZ(i) * scale)}:${Math.round(uv.getX(i) * 1e7)},${Math.round(uv.getY(i) * 1e7)}`;
      const records: { face: number; uv: number[]; edges: string[] }[] = [], edges = new Map<string, number[]>();
      for (const group of groups) {
        if (mesh.userData.setIds[group.materialIndex ?? 0] !== hit.setId) continue;
        for (let i = group.start; i < group.start + group.count; i += 3) {
          const ids = [0, 1, 2].map(n => geometry.index ? geometry.index.getX(i + n) : i + n);
          const keys = ids.map(vertexKey), triangleEdges: string[] = [];
          for (let j = 0; j < 3; j++) {
            const a = keys[j], b = keys[(j + 1) % 3];
            if (a === b) continue;
            const key = a < b ? `${a}/${b}` : `${b}/${a}`;
            triangleEdges.push(key);
            if (!edges.has(key)) edges.set(key, []);
            edges.get(key)!.push(records.length);
          }
          records.push({ face: i / 3, uv: ids.flatMap(index => [uv.getX(index), uv.getY(index)]), edges: triangleEdges });
        }
      }
      const islands: number[][][] = [], faceIslands = new Map<number, number>(), visited = new Set<number>();
      for (let start = 0; start < records.length; start++) {
        if (visited.has(start)) continue;
        const island: number[][] = [], pending = [start];
        visited.add(start);
        while (pending.length) {
          const index = pending.pop()!, record = records[index];
          faceIslands.set(record.face, islands.length); island.push(record.uv);
          for (const edge of record.edges) for (const neighbor of edges.get(edge)!) {
            if (!visited.has(neighbor)) { visited.add(neighbor); pending.push(neighbor); }
          }
        }
        islands.push(island);
      }
      cached = { faceIslands, islands }; this.islandCache.set(cacheKey, cached);
    }
    const island = cached.faceIslands.get(hit.faceIndex);
    return island === undefined ? [] : cached.islands[island];
  }
  drawUV(context: CanvasRenderingContext2D, setId: string, width: number, height: number) {
    if (width <= 0 || height <= 0) return;
    let topology = this.uvPaths.get(setId);
    if (!topology) {
      const path = new Path2D(); let withinTile = true;
      for (const uv of this.getUVTriangles(setId)) {
        if (uv.some(value => value < 0 || value > 1)) withinTile = false;
        path.moveTo(uv[0], 1 - uv[1]); path.lineTo(uv[2], 1 - uv[3]); path.lineTo(uv[4], 1 - uv[5]); path.closePath();
      }
      topology = { path, withinTile }; this.uvPaths.set(setId, topology);
    }
    const transform = context.getTransform();
    const scaledPath = () => { const path = new Path2D(); path.addPath(topology!.path, new DOMMatrix([width, 0, 0, height, 0, 0])); return path; };
    if (!topology.withinTile || transform.b || transform.c || transform.a <= 0 || transform.d <= 0) {
      context.save(); context.strokeStyle = 'rgba(220,226,230,.28)'; context.lineWidth = .6;
      context.stroke(scaledPath()); context.restore(); return;
    }
    // Cache only visible physical pixels, so zooming an 8K tile never allocates an 8K overlay.
    const left = Math.max(0, Math.floor(transform.e - transform.a)), top = Math.max(0, Math.floor(transform.f - transform.d));
    const right = Math.min(context.canvas.width, Math.ceil(transform.e + (width + 1) * transform.a));
    const bottom = Math.min(context.canvas.height, Math.ceil(transform.f + (height + 1) * transform.d));
    if (right <= left || bottom <= top) return;
    const key = [width, height, transform.a, transform.d, transform.e, transform.f, left, top, right, bottom].join(',');
    let overlay = this.uvOverlays.get(setId);
    if (!overlay || overlay.key !== key) {
      const canvas = overlay?.canvas ?? document.createElement('canvas');
      canvas.width = right - left; canvas.height = bottom - top;
      const cache = canvas.getContext('2d')!;
      cache.setTransform(transform.a, 0, 0, transform.d, transform.e - left, transform.f - top);
      cache.strokeStyle = 'rgba(220,226,230,.28)'; cache.lineWidth = .6; cache.stroke(scaledPath());
      overlay = { key, canvas, x: (left - transform.e) / transform.a, y: (top - transform.f) / transform.d, scaleX: transform.a, scaleY: transform.d };
      this.uvOverlays.set(setId, overlay);
    }
    context.drawImage(overlay.canvas, overlay.x, overlay.y, overlay.canvas.width / overlay.scaleX, overlay.canvas.height / overlay.scaleY);
  }

  async importFile(file: File, beforeInstall?: (sets: ModelInfo['sets']) => void | Promise<void>): Promise<ModelInfo> {
    if (file.size > 100 * 1024 * 1024) throw new Error('Model exceeds the 100 MB import limit.');
    const ext = file.name.split('.').pop()?.toLowerCase();
    let object: THREE.Object3D;
    if (ext === 'obj') object = new OBJLoader().parse(await file.text());
    else if (ext === 'glb' || ext === 'gltf') {
      const bytes = await file.arrayBuffer();
      let json: { buffers?: { uri?: string }[]; images?: { uri?: string }[] };
      if (ext === 'gltf') json = JSON.parse(new TextDecoder().decode(bytes));
      else {
        if (bytes.byteLength < 20) throw new Error('The GLB file is truncated.');
        const view = new DataView(bytes), length = view.getUint32(12, true);
        if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(16, true) !== 0x4e4f534a || length > bytes.byteLength - 20) throw new Error('The file is not a valid glTF 2.0 GLB.');
        json = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 20, length)));
      }
      if ([...(json.buffers ?? []), ...(json.images ?? [])].some(entry => entry.uri && !entry.uri.startsWith('data:'))) throw new Error('This glTF uses external files. Export a self-contained GLB and import it instead.');
      object = (await new GLTFLoader().parseAsync(bytes, '')).scene;
    } else throw new Error('Supported model files: .obj, .glb and self-contained .gltf.');
    object.updateMatrixWorld(true);
    const warnings: string[] = [], group = new THREE.Group();
    group.name = file.name.replace(/\.[^.]+$/, '');
    const materialIds = new Map<THREE.Material, string>();
    let triangles = 0;
    try { object.traverse(child => {
      if (!(child instanceof THREE.Mesh)) return;
      const geometry = child.geometry.clone();
      const sourceMaterials = Array.isArray(child.material) ? child.material : [child.material];
      try { triangles += validateGeometry(geometry, sourceMaterials.length); }
      catch (error) { geometry.dispose(); throw error; }
      if (triangles > 2_000_000) { geometry.dispose(); return; }
      const materials = sourceMaterials.map(source => {
        let id = materialIds.get(source);
        if (!id) { id = `material_${materialIds.size + 1}`; materialIds.set(source, id); }
        const original = source as THREE.MeshStandardMaterial;
        const material = new THREE.MeshStandardMaterial({ name: source.name || `Material ${materialIds.size}`, color: original.color ?? 0xb8b8b8, roughness: original.roughness ?? .5, metalness: original.metalness ?? 0, side: THREE.DoubleSide });
        material.userData.setId = id;
        if (original.map && !warnings.includes('Embedded image textures are replaced by editable texture sets.')) warnings.push('Embedded image textures are replaced by editable texture sets.');
        return material;
      });
      if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
      if (!geometry.getAttribute('uv')) warnings.push(`${child.name || 'Mesh'} has no UV coordinates and cannot be painted. Unwrap it in a 3D editor before importing.`);
      else {
        const uv = geometry.getAttribute('uv');
        for (let i = 0; i < uv.count; i++) {
          if (uv.getX(i) < 0 || uv.getX(i) > 1 || uv.getY(i) < 0 || uv.getY(i) > 1) { warnings.push('UVs extend outside the 0–1 tile. UDIM tiles are not supported; only the 0–1 tile can be painted.'); break; }
        }
      }
      if (child instanceof THREE.SkinnedMesh) warnings.push('Skinned meshes are imported as static bind-pose geometry.');
      const mesh = new THREE.Mesh(geometry, materials);
      mesh.name = child.name; mesh.applyMatrix4(child.matrixWorld);
      mesh.userData.setIds = materials.map(material => material.userData.setId);
      group.add(mesh);
    }); } catch (error) { this.disposeObject(object); this.disposeObject(group); throw error; }
    this.disposeObject(object);
    if (triangles > 2_000_000) { this.disposeObject(group); throw new Error('Model exceeds the 2 million triangle import limit.'); }
    if (materialIds.size > 16) { this.disposeObject(group); throw new Error('A model can contain at most 16 texture sets. Merge some materials before importing.'); }
    if (!group.children.length) throw new Error('The file contains no mesh geometry.');
    let bounds: THREE.Box3, size: THREE.Vector3;
    try { ({ bounds, size } = validateBounds(group)); } catch (error) { this.disposeObject(group); throw error; }
    group.position.sub(bounds.getCenter(new THREE.Vector3()));
    const scale = 2.4 / Math.max(size.x, size.y, size.z);
    group.scale.setScalar(scale); group.position.multiplyScalar(scale);
    if (beforeInstall) {
      const sets = new Map<string, ModelInfo['sets'][number]>();
      group.traverse(child => {
        if (!(child instanceof THREE.Mesh)) return;
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        materials.forEach((material: THREE.MeshStandardMaterial, index) => {
          const id = child.userData.setIds[index];
          if (!sets.has(id)) sets.set(id, { id, name: material.name, color: `#${material.color.getHexString()}`, roughness: material.roughness, metallic: material.metalness });
        });
      });
      try { await beforeInstall([...sets.values()]); } catch (error) { this.disposeObject(group); throw error; }
    }
    return this.installModel(group, [...new Set(warnings)]);
  }

  private installModel(group: THREE.Group, warnings: string[]): ModelInfo {
    this.pointerUp();
    this.scene.remove(this.model); this.disposeObject(this.model);
    this.materials.clear();
    this.islandCache.clear(); this.uvPaths.clear(); this.uvOverlays.clear(); this.highlightedSet = null;
    this.textures.forEach(records => Object.values(records).forEach(texture => texture?.dispose())); this.textures.clear();
    this.channelTextures.forEach(texture => texture.dispose()); this.channelTextures.clear();
    this.model = group;
    const sets = new Map<string, ModelInfo['sets'][number]>();
    let triangleCount = 0;
    group.traverse(child => {
      if (!(child instanceof THREE.Mesh)) return;
      child.castShadow = child.receiveShadow = true;
      triangleCount += (child.geometry.index?.count ?? child.geometry.getAttribute('position').count) / 3;
      const sourceMaterials = Array.isArray(child.material) ? child.material : [child.material];
      const replacements = sourceMaterials.map((source, index) => {
        const id = child.userData.setIds?.[index] ?? source.userData.setId ?? `material_${sets.size + 1}`;
        if (!this.materials.has(id)) {
          const material = source as THREE.MeshStandardMaterial;
          const defaults: SetRecord = { id, name: material.name || id, color: material.color.getHex(), roughness: material.roughness, metalness: material.metalness };
          material.userData.defaults = defaults;
          this.materials.set(id, material);
          sets.set(id, { id, name: defaults.name, color: `#${material.color.getHexString()}`, roughness: defaults.roughness, metallic: defaults.metalness });
        } else if (this.materials.get(id) !== source) source.dispose();
        return this.materials.get(id)!;
      });
      child.material = replacements.length === 1 ? replacements[0] : replacements;
      child.userData.setIds = replacements.map(material => material.userData.defaults.id);
    });
    this.scene.add(group);
    const bounds = new THREE.Box3().setFromObject(group);
    this.floor.position.y = bounds.min.y - .01; this.grid.position.y = bounds.min.y - .012;
    this.materials.forEach((_, id) => this.applyMaterial(id));
    this.modelInfo = { name: group.name || 'Untitled model', sets: [...sets.values()], triangleCount: Math.round(triangleCount), warnings };
    this.activeSet = this.modelInfo.sets[0]?.id ?? '';
    this.frame();
    this.callbacks.onImportInfo?.(this.modelInfo);
    return this.modelInfo;
  }

  serializeModel(): ModelData {
    this.model.updateMatrixWorld(true);
    const meshes: ModelData['meshes'] = [];
    this.model.traverse(child => {
      if (child instanceof THREE.Mesh) {
        // Primitive toJSON stores constructor parameters and would lose our packed UV coordinates.
        const geometry = new THREE.BufferGeometry().copy(child.geometry);
        geometry.uuid = child.geometry.uuid;
        geometry.boundingSphere = null;
        meshes.push({ name: child.name, geometry: geometry.toJSON(), matrix: child.matrixWorld.toArray(), sets: [...child.userData.setIds] });
        geometry.dispose();
      }
    });
    return { version: 1, name: this.modelInfo.name, sets: [...this.materials.values()].map(material => ({ ...material.userData.defaults })), meshes };
  }
  restoreModel(value: unknown): ModelInfo {
    const data = value as ModelData;
    if (!data || data.version !== 1 || !Array.isArray(data.meshes) || !Array.isArray(data.sets) || !data.sets.length || data.sets.length > 16 || !data.meshes.length || data.meshes.length > 10000) throw new Error('Invalid project model data.');
    const group = new THREE.Group(), materials = new Map<string, THREE.MeshStandardMaterial>();
    group.name = String(data.name || 'Project model');
    for (const set of data.sets) {
      if (typeof set.id !== 'string' || !set.id.trim() || set.id.length > 128 || materials.has(set.id) || !Number.isInteger(set.color) || set.color < 0 || set.color > 0xffffff || !Number.isFinite(set.roughness) || set.roughness < 0 || set.roughness > 1 || !Number.isFinite(set.metalness) || set.metalness < 0 || set.metalness > 1) { materials.forEach(material => material.dispose()); throw new Error('Invalid project material data.'); }
      materials.set(set.id, new THREE.MeshStandardMaterial({ name: String(set.name), color: set.color, roughness: set.roughness, metalness: set.metalness, side: THREE.DoubleSide }));
    }
    try {
      let vertices = 0, triangles = 0;
      for (const record of data.meshes) {
        if (!Array.isArray(record.matrix) || record.matrix.length !== 16 || !record.matrix.every(Number.isFinite) || !Array.isArray(record.sets) || !record.sets.length || record.sets.length > 16 || !record.sets.every(id => materials.has(id))) throw new Error('Invalid project mesh transform or material.');
        const raw = record.geometry?.data;
        if (!raw?.attributes?.position) throw new Error('Invalid project vertex data.');
        const attributes = [...Object.values(raw.attributes), ...Object.values(raw.morphAttributes ?? {}).flat()];
        for (const attribute of attributes) if (!Array.isArray(attribute.array) || attribute.array.length > 24_000_000 || !attribute.array.every(Number.isFinite)) throw new Error('Project attributes must contain finite numbers.');
        if (raw.index && (!Array.isArray(raw.index.array) || !raw.index.array.every(index => Number.isInteger(index) && index >= 0))) throw new Error('Invalid project triangle indices.');
        const geometry = new THREE.BufferGeometryLoader().parse(record.geometry);
        geometry.uuid = record.geometry.uuid;
        const positions = geometry.getAttribute('position');
        vertices += positions?.count ?? 0;
        try { triangles += validateGeometry(geometry, record.sets.length); }
        catch (error) { geometry.dispose(); throw error; }
        if (vertices > 6_000_000 || triangles > 2_000_000) { geometry.dispose(); throw new Error('Project geometry exceeds the import limit.'); }
        if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
        const mesh = new THREE.Mesh(geometry, record.sets.map(id => materials.get(id)!));
        mesh.name = String(record.name); mesh.applyMatrix4(new THREE.Matrix4().fromArray(record.matrix)); mesh.userData.setIds = record.sets;
        group.add(mesh);
      }
      validateBounds(group);
      return this.installModel(group, []);
    } catch (error) { this.disposeObject(group); materials.forEach(material => material.dispose()); throw error; }
  }

  private disposeObject(object: THREE.Object3D) {
    const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>(), textures = new Set<THREE.Texture>();
    object.traverse(child => {
      if (!(child instanceof THREE.Mesh)) return;
      geometries.add(child.geometry);
      (Array.isArray(child.material) ? child.material : [child.material]).forEach(material => materials.add(material));
    });
    materials.forEach(material => { Object.values(material).forEach(value => { if (value instanceof THREE.Texture) textures.add(value); }); material.dispose(); });
    textures.forEach(texture => texture.dispose()); geometries.forEach(geometry => geometry.dispose());
  }
  dispose() {
    this.disposed = true; this.pointerUp(); cancelAnimationFrame(this.animation); this.resizeObserver.disconnect();
    this.bindings.forEach(remove => remove()); this.controls.dispose(); this.disposeObject(this.model);
    this.textures.forEach(records => Object.values(records).forEach(texture => texture?.dispose()));
    this.channelTextures.forEach(texture => texture.dispose());
    this.uvPaths.clear(); this.uvOverlays.clear(); this.islandCache.clear();
    this.environment.dispose(); this.disposeObject(this.floor); this.grid.geometry.dispose();
    (Array.isArray(this.grid.material) ? this.grid.material : [this.grid.material]).forEach(material => material.dispose());
    this.renderer.dispose(); this.renderer.domElement.remove();
  }
}
