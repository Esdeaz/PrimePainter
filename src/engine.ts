export type PaintChannel = 'baseColor' | 'roughness' | 'metallic' | 'height';
export type Channel = PaintChannel | 'normal';
export type BlendMode = 'source-over' | 'multiply' | 'screen' | 'overlay';
export type CanvasChannels = Record<Channel, HTMLCanvasElement>;
type PaintMaps = Record<PaintChannel, HTMLCanvasElement>;
export type MaterialPreset = {
  id: string; name: string; category: string; color: string;
  roughness: number; metallic: number; height: number; pattern: string;
};
export const MATERIALS: MaterialPreset[] = [
  { id: 'steel', name: 'Steel Brushed', category: 'Metal', color: '#889298', roughness: .3, metallic: 1, height: .5, pattern: 'brushed' },
  { id: 'iron', name: 'Iron Rough', category: 'Metal', color: '#42494d', roughness: .64, metallic: .95, height: .5, pattern: 'grain' },
  { id: 'copper', name: 'Copper Polished', category: 'Metal', color: '#b96b47', roughness: .2, metallic: 1, height: .5, pattern: 'brushed' },
  { id: 'gold', name: 'Gold Pure', category: 'Metal', color: '#d9ae4b', roughness: .23, metallic: 1, height: .5, pattern: 'brushed' },
  { id: 'enamel', name: 'Paint Industrial', category: 'Paint', color: '#d68835', roughness: .34, metallic: .2, height: .52, pattern: 'paint' },
  { id: 'plastic', name: 'Plastic Matte', category: 'Plastic', color: '#326d79', roughness: .58, metallic: 0, height: .5, pattern: 'grain' },
  { id: 'rubber', name: 'Rubber Soft', category: 'Plastic', color: '#25282b', roughness: .83, metallic: 0, height: .5, pattern: 'grain' },
  { id: 'concrete', name: 'Concrete Bare', category: 'Concrete', color: '#92928a', roughness: .92, metallic: 0, height: .5, pattern: 'concrete' },
  { id: 'fabric', name: 'Fabric Canvas', category: 'Fabric', color: '#95917a', roughness: .94, metallic: 0, height: .5, pattern: 'fabric' },
  { id: 'carbon', name: 'Carbon Fiber', category: 'Fabric', color: '#333a40', roughness: .29, metallic: .55, height: .5, pattern: 'carbon' },
  { id: 'wood', name: 'Wood Walnut', category: 'Wood', color: '#825234', roughness: .6, metallic: 0, height: .5, pattern: 'wood' },
  { id: 'leather', name: 'Leather Worn', category: 'Leather', color: '#563a30', roughness: .72, metallic: 0, height: .5, pattern: 'leather' },
  { id: 'ceramic', name: 'Ceramic Glazed', category: 'Ceramic', color: '#dcded1', roughness: .13, metallic: 0, height: .5, pattern: 'paint' },
  { id: 'visor', name: 'Glass Tinted', category: 'Glass', color: '#163a4b', roughness: .13, metallic: .72, height: .5, pattern: 'smooth' },
  { id: 'rust', name: 'Rust Fine', category: 'Metal', color: '#9c4c2c', roughness: .88, metallic: .18, height: .54, pattern: 'concrete' },
  { id: 'redpaint', name: 'Paint Signal Red', category: 'Paint', color: '#a8342b', roughness: .37, metallic: .12, height: .51, pattern: 'paint' },
];
export type Layer = {
  id: string; name: string; type: 'paint' | 'fill'; visible: boolean;
  opacity: number; blendMode: BlendMode; materialId?: string; color: string;
  roughness: number; metallic: number; height: number; scale: number;
  mask: HTMLCanvasElement | null; channels: PaintMaps;
};
export type TextureSet = { id: string; name: string; layers: Layer[] };
export type Brush = {
  color: string; size: number; flow: number; hardness: number; spacing: number;
  roughness: number; metallic: number; height: number;
  channel: PaintChannel | 'material'; symmetry: boolean; erase: boolean; mask: boolean;
};
type LayerParams = Partial<Pick<Layer, 'name' | 'visible' | 'opacity' | 'blendMode' | 'materialId' | 'color' | 'roughness' | 'metallic' | 'height' | 'scale'>>;
type Snapshot = { resolution: number; textureSets: TextureSet[]; activeTextureSetId: string; activeLayerId: string };
type Stroke = { started: boolean; cloned: Set<string>; last?: { x: number; y: number; pressure: number } };
type Bounds = { left: number; top: number; right: number; bottom: number };
const PAINT_CHANNELS: PaintChannel[] = ['baseColor', 'roughness', 'metallic', 'height'];
const RESOLUTIONS = [256, 512, 1024, 2048];
const BLENDS: BlendMode[] = ['source-over', 'multiply', 'screen', 'overlay'];
const clamp = (v: number, min = 0, max = 1) => Math.min(max, Math.max(min, v));
let sequence = 0;
const uid = () => `layer-${Date.now().toString(36)}-${++sequence}`;
const canvas = (size: number) => { const c = document.createElement('canvas'); c.width = c.height = size; return c; };
const ctx = (c: HTMLCanvasElement) => c.getContext('2d', { willReadFrequently: true })!;
const cloneCanvas = (c: HTMLCanvasElement, size = c.width) => { const copy = canvas(size); ctx(copy).drawImage(c, 0, 0, size, size); return copy; };
const makeMaps = (size: number): PaintMaps => Object.fromEntries(PAINT_CHANNELS.map(key => [key, canvas(size)])) as PaintMaps;
const rgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const gray = (value: number) => { const n = Math.round(clamp(value) * 255); return `rgb(${n},${n},${n})`; };
const noise = (x: number, y: number) => { let n = Math.imul(x, 374761393) + Math.imul(y, 668265263); n = Math.imul(n ^ n >>> 13, 1274126177); return ((n ^ n >>> 16) >>> 0) / 4294967295; };

export class PainterEngine {
  resolution: number;
  textureSets: TextureSet[] = [];
  activeTextureSetId = 'body';
  activeLayerId = '';
  onChange: () => void = () => {};
  brush: Brush = { color: '#df7139', size: 42, flow: 1, hardness: .75, spacing: .16, roughness: .45, metallic: 0, height: .5, channel: 'material', symmetry: false, erase: false, mask: false };
  private past: Snapshot[] = [];
  private future: Snapshot[] = [];
  private outputs = new Map<string, CanvasChannels>();
  private versions = new Map<string, number>();
  private channelVersions = new Map<string, Record<Channel, number>>();
  private revision = 0;
  private dirty = new Set<string>();
  private dirtyAreas = new Map<string, Bounds | null>();
  private dirtyChannels = new Map<string, Set<PaintChannel>>();
  private normalDirty = new Set<string>();
  private normalAreas = new Map<string, Bounds | null>();
  private maskAlpha = new WeakMap<HTMLCanvasElement, HTMLCanvasElement>();
  private maskAlphaDirty = new WeakMap<HTMLCanvasElement, Bounds>();
  private scratch: HTMLCanvasElement | null = null;
  private stroke: Stroke | null = null;
  private frame = 0;

  constructor(resolution = 1024) {
    if (!RESOLUTIONS.includes(resolution)) throw new Error('Texture resolution must be 256, 512, 1024 or 2048.');
    this.assertRasterBudget(resolution, [{ layers: [{ mask: null }, { mask: true }, { mask: null }] }, { layers: [{ mask: null }] }, { layers: [{ mask: null }] }]);
    this.resolution = resolution;
    const body = this.newSet('body', 'Body', 'steel');
    const enamel = this.createLayer('fill', 'enamel');
    enamel.name = 'Industrial paint';
    enamel.mask = canvas(resolution);
    const mask = ctx(enamel.mask); mask.fillStyle = '#fff'; mask.fillRect(0, 0, resolution, resolution);
    mask.fillStyle = '#000'; mask.fillRect(0, 0, resolution * .024, resolution); mask.fillRect(resolution * .976, 0, resolution * .024, resolution);
    for (let i = 0; i < 85; i++) {
      const x = noise(i, 9) * resolution, y = noise(i, 14) * resolution;
      mask.fillStyle = i % 3 ? '#777' : '#222'; mask.fillRect(x, y, resolution * (.002 + noise(i, 5) * .018), resolution * .0015);
    }
    body.layers.push(enamel, this.createLayer('paint'));
    body.layers.at(-1)!.name = 'Paint details';
    this.textureSets = [body, this.newSet('visor', 'Visor', 'visor'), this.newSet('hardware', 'Hardware', 'iron')];
    this.activeLayerId = body.layers.at(-1)!.id;
    this.markAll(); this.flush();
  }

  get activeSet() { return this.textureSets.find(s => s.id === this.activeTextureSetId)!; }
  get activeLayer() { return this.activeSet?.layers.find(l => l.id === this.activeLayerId)!; }
  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }
  setActiveSet(id: string) {
    const set = this.textureSets.find(s => s.id === id);
    if (!set || !set.layers.length) throw new Error('Texture set does not exist or has no layers.');
    this.endStroke(); this.activeTextureSetId = id; this.activeLayerId = set.layers.at(-1)!.id; this.onChange();
  }
  setActiveLayer(id: string) {
    if (!this.activeSet.layers.some(l => l.id === id)) throw new Error('Layer does not exist.');
    this.endStroke(); this.activeLayerId = id; this.onChange();
  }
  getChannels(setId = this.activeTextureSetId): CanvasChannels {
    if (!this.textureSets.some(s => s.id === setId)) throw new Error('Texture set does not exist.');
    this.flush(); return this.outputs.get(setId)!;
  }
  getRevision(setId = this.activeTextureSetId) { this.getChannels(setId); return this.versions.get(setId)!; }
  getChannelRevisions(setId = this.activeTextureSetId) { this.getChannels(setId); return { ...this.channelVersions.get(setId)! }; }
  exportChannel(channel: Channel, setId = this.activeTextureSetId) { return cloneCanvas(this.getChannels(setId)[channel]); }
  createMaterialPreview(preset: MaterialPreset | string, size = 96) {
    const material = typeof preset === 'string' ? MATERIALS.find(m => m.id === preset) : preset;
    if (!material || size < 1 || size > 512) throw new Error('Invalid material preview.');
    return this.renderFill({ materialId: material.id, color: material.color, roughness: material.roughness, metallic: material.metallic, height: material.height, scale: 1 } as Layer, size).baseColor;
  }

  addLayer(type: 'paint' | 'fill' = 'paint', materialId?: string) {
    this.checkLayerLimit(); const layer = this.createLayer(type, materialId); this.checkpoint();
    const index = this.activeSet.layers.findIndex(l => l.id === this.activeLayerId);
    this.activeSet.layers.splice(index + 1, 0, layer); this.activeLayerId = layer.id; this.changed(); return layer;
  }
  addImageLayer(image: HTMLCanvasElement, name = 'Imported texture') {
    if (!image.width || !image.height || image.width > 16384 || image.height > 16384) throw new Error('Image dimensions are unsupported.');
    this.checkLayerLimit();
    this.checkpoint(); const layer = this.createLayer('paint'); layer.name = name.slice(0, 120) || 'Imported texture';
    ctx(layer.channels.baseColor).drawImage(image, 0, 0, this.resolution, this.resolution);
    this.activeSet.layers.push(layer); this.activeLayerId = layer.id; this.changed(); return layer;
  }
  updateLayer(id: string, values: LayerParams) {
    const layer = this.findLayer(id); this.validateLayerParams(values); this.checkpoint();
    Object.assign(layer, values);
    if (layer.type === 'fill' && ['materialId', 'color', 'roughness', 'metallic', 'height', 'scale'].some(k => k in values)) {
      if (values.materialId) { const preset = MATERIALS.find(m => m.id === values.materialId)!; Object.assign(layer, { color: preset.color, roughness: preset.roughness, metallic: preset.metallic, height: preset.height }, values); }
      layer.channels = this.renderFill(layer);
    }
    this.changed();
  }
  deleteLayer(id: string) {
    if (this.activeSet.layers.length <= 1) throw new Error('Keep at least one layer in a texture set.');
    const index = this.activeSet.layers.findIndex(l => l.id === id); if (index < 0) throw new Error('Layer does not exist.');
    this.checkpoint(); this.activeSet.layers.splice(index, 1); this.activeLayerId = this.activeSet.layers[Math.min(index, this.activeSet.layers.length - 1)].id; this.changed();
  }
  duplicateLayer(id: string) {
    const layer = this.findLayer(id); this.checkLayerLimit(layer.mask ? 6 : 4); this.checkpoint();
    const copy = { ...layer, id: uid(), name: `${layer.name} copy`.slice(0, 120), channels: { ...layer.channels } };
    this.activeSet.layers.splice(this.activeSet.layers.indexOf(layer) + 1, 0, copy); this.activeLayerId = copy.id; this.changed(); return copy;
  }
  moveLayer(id: string, direction: -1 | 1) {
    const layers = this.activeSet.layers, index = layers.findIndex(l => l.id === id), target = index + direction;
    if (index < 0 || target < 0 || target >= layers.length) return;
    this.checkpoint(); [layers[index], layers[target]] = [layers[target], layers[index]]; this.changed();
  }
  addMask(id: string, color: 'white' | 'black' = 'white') {
    const layer = this.findLayer(id); if (!layer.mask) this.assertRasterBudget(this.resolution, this.textureSets, 2); this.checkpoint(); layer.mask = canvas(this.resolution);
    const c = ctx(layer.mask); c.fillStyle = color === 'white' ? '#fff' : '#000'; c.fillRect(0, 0, this.resolution, this.resolution); this.changed();
  }
  removeMask(id: string) { const layer = this.findLayer(id); if (!layer.mask) return; this.checkpoint(); layer.mask = null; this.changed(); }
  invertMask(id: string) {
    const layer = this.findLayer(id); if (!layer.mask) throw new Error('Add a mask before inverting it.');
    this.checkpoint(); const replacement = cloneCanvas(layer.mask), c = ctx(replacement), pixels = c.getImageData(0, 0, this.resolution, this.resolution);
    for (let i = 0; i < pixels.data.length; i += 4) for (let channel = 0; channel < 3; channel++) pixels.data[i + channel] = 255 - pixels.data[i + channel];
    c.putImageData(pixels, 0, 0); layer.mask = replacement; this.changed();
  }
  clearLayer(id: string) {
    const layer = this.findLayer(id); if (layer.type !== 'paint') throw new Error('Only paint layers contain strokes to clear.');
    this.checkpoint(); layer.channels = makeMaps(this.resolution); this.changed();
  }
  mergeDown(id: string) {
    const index = this.activeSet.layers.findIndex(l => l.id === id);
    if (index <= 0) throw new Error('There is no layer below this one.');
    const upper = this.activeSet.layers[index], lower = this.activeSet.layers[index - 1];
    if (lower.visible && lower.opacity > 0 && lower.blendMode !== 'source-over') throw new Error('Set the lower layer blend mode to Normal before merging. Its blend depends on the layers below.');
    if (upper.visible && upper.opacity > 0 && upper.blendMode !== 'source-over') {
      const opaque = lower.visible && lower.opacity === 1 && PAINT_CHANNELS.every(channel => {
        const source = lower.mask ? this.maskedSource(lower, channel) : lower.channels[channel];
        const pixels = ctx(source).getImageData(0, 0, this.resolution, this.resolution).data;
        for (let i = 3; i < pixels.length; i += 4) if (pixels[i] !== 255) return false;
        return true;
      });
      if (!opaque) throw new Error('Use Normal blending before merging over a translucent layer. Its blend depends on the layers below.');
    }
    this.checkpoint(); const channels = makeMaps(this.resolution); this.composite([lower, upper], channels, false);
    const merged: Layer = { ...lower, name: `${lower.name} + ${upper.name}`.slice(0, 120), type: 'paint', visible: true, opacity: 1, blendMode: 'source-over', materialId: undefined, channels, mask: null };
    this.activeSet.layers.splice(index - 1, 2, merged); this.activeLayerId = merged.id; this.changed(); return merged;
  }
  setTextureSets(sets: { id: string; name: string }[]) {
    if (!Array.isArray(sets) || !sets.length || sets.length > 16 || sets.some(s => !s || typeof s.id !== 'string' || typeof s.name !== 'string' || !s.id || !s.name || s.id.length > 120 || s.name.length > 120) || new Set(sets.map(s => s.id)).size !== sets.length) throw new Error('Supply 1–16 uniquely named texture sets.');
    this.assertRasterBudget(this.resolution, sets.map(() => ({ layers: [{ mask: null }] })));
    this.checkpoint(); this.textureSets = sets.map(s => this.newSet(s.id, s.name, 'plastic'));
    this.activeTextureSetId = this.textureSets[0].id; this.activeLayerId = this.textureSets[0].layers[0].id;
    this.outputs.clear(); this.markAll(); this.notify();
  }

  beginStroke() { if (!this.stroke) this.stroke = { started: false, cloned: new Set() }; }
  breakStroke() { if (this.stroke) this.stroke.last = undefined; }
  fillPolygons(triangles: number[][]) {
    if (!Array.isArray(triangles) || triangles.length > 500_000 || triangles.some(t => !Array.isArray(t) || t.length !== 6 || t.some(v => !Number.isFinite(v)))) throw new Error('Invalid UV triangles.');
    const layer = this.activeLayer;
    if (!triangles.length || !layer || (!this.brush.mask && layer.type === 'fill')) return;
    if (this.brush.mask && !layer.mask) this.assertRasterBudget(this.resolution, this.textureSets, 2);
    this.endStroke(); this.checkpoint();
    const targets = this.brush.mask ? ['mask'] : this.brush.channel === 'material' ? PAINT_CHANNELS : [this.brush.channel];
    for (const channel of targets) {
      if (channel === 'mask') {
        if (layer.mask) layer.mask = cloneCanvas(layer.mask);
        else { layer.mask = canvas(this.resolution); const c = ctx(layer.mask); c.fillStyle = '#fff'; c.fillRect(0, 0, this.resolution, this.resolution); }
      } else layer.channels[channel as PaintChannel] = cloneCanvas(layer.channels[channel as PaintChannel]);
      const target = channel === 'mask' ? layer.mask! : layer.channels[channel as PaintChannel], c = ctx(target);
      const color = channel === 'baseColor' || channel === 'mask' ? this.brush.color : gray(this.brush[channel as 'roughness' | 'metallic' | 'height']);
      c.save(); c.globalCompositeOperation = this.brush.erase && channel !== 'mask' ? 'destination-out' : 'source-over'; c.globalAlpha = clamp(this.brush.flow);
      c.fillStyle = channel === 'mask' && this.brush.erase ? '#000' : color; c.beginPath();
      for (const triangle of triangles) {
        const reverse = (triangle[2] - triangle[0]) * (triangle[5] - triangle[1]) - (triangle[3] - triangle[1]) * (triangle[4] - triangle[0]) < 0;
        const second = reverse ? 4 : 2, third = reverse ? 2 : 4;
        c.moveTo(clamp(triangle[0]) * this.resolution, (1 - clamp(triangle[1])) * this.resolution);
        c.lineTo(clamp(triangle[second]) * this.resolution, (1 - clamp(triangle[second + 1])) * this.resolution);
        c.lineTo(clamp(triangle[third]) * this.resolution, (1 - clamp(triangle[third + 1])) * this.resolution); c.closePath();
      }
      c.fill(); c.restore(); if (channel === 'mask') this.maskAlpha.delete(target);
    }
    this.changed(this.brush.mask || this.brush.channel === 'height' || this.brush.channel === 'material', undefined, this.brush.mask || this.brush.channel === 'material' ? PAINT_CHANNELS : [this.brush.channel]);
  }
  paint(u: number, v: number, pressure = 1) {
    if (![u, v, pressure].every(Number.isFinite)) return;
    const layer = this.activeLayer;
    if (!layer || (!this.brush.mask && layer.type === 'fill')) return;
    if (this.brush.mask && !layer.mask) this.assertRasterBudget(this.resolution, this.textureSets, 2);
    this.beginStroke(); const stroke = this.stroke!;
    if (!stroke.started) { this.checkpoint(false); stroke.started = true; }
    const point = { x: clamp(u) * this.resolution, y: (1 - clamp(v)) * this.resolution, pressure: clamp(pressure, .01, 1) };
    const previous = stroke.last;
    if (!previous) this.dab(point.x, point.y, point.pressure, layer, stroke);
    else {
      const distance = Math.hypot(point.x - previous.x, point.y - previous.y);
      const step = Math.max(1, this.brush.size * clamp(this.brush.spacing, .025, 1));
      const steps = Math.max(1, Math.ceil(distance / step));
      for (let i = 1; i <= steps; i++) { const t = i / steps; this.dab(previous.x + (point.x - previous.x) * t, previous.y + (point.y - previous.y) * t, previous.pressure + (point.pressure - previous.pressure) * t, layer, stroke); }
    }
    const radius = clamp(this.brush.size, 1, this.resolution) / 2 + 2;
    const bounds = { left: Math.min(previous?.x ?? point.x, point.x) - radius, top: Math.min(previous?.y ?? point.y, point.y) - radius, right: Math.max(previous?.x ?? point.x, point.x) + radius, bottom: Math.max(previous?.y ?? point.y, point.y) + radius };
    if (this.brush.symmetry) { const mirroredLeft = this.resolution - bounds.right; bounds.right = Math.max(bounds.right, this.resolution - bounds.left); bounds.left = Math.min(bounds.left, mirroredLeft); }
    stroke.last = point; this.changed(this.brush.mask || this.brush.channel === 'height' || this.brush.channel === 'material', bounds, this.brush.mask || this.brush.channel === 'material' ? PAINT_CHANNELS : [this.brush.channel]);
  }
  endStroke() { if (!this.stroke) return; const hadPaint = this.stroke.started; this.stroke = null; if (hadPaint) { this.trimHistory(); this.flush(); if (this.frame) { cancelAnimationFrame(this.frame); this.frame = 0; } this.onChange(); } }
  undo() { this.endStroke(); const snapshot = this.past.pop(); if (!snapshot) return; this.future.push(this.snapshot()); this.restore(snapshot); }
  redo() { this.endStroke(); const snapshot = this.future.pop(); if (!snapshot) return; this.past.push(this.snapshot()); this.restore(snapshot); }
  clearHistory() { this.endStroke(); this.past = []; this.future = []; }
  resize(size: number) {
    if (!RESOLUTIONS.includes(size)) throw new Error('Texture resolution must be 256, 512, 1024 or 2048.');
    this.assertRasterBudget(size, this.textureSets);
    if (size === this.resolution) return; this.checkpoint(); this.resolution = size;
    for (const set of this.textureSets) for (const layer of set.layers) {
      layer.channels = layer.type === 'fill' ? this.renderFill(layer) : Object.fromEntries(PAINT_CHANNELS.map(c => [c, cloneCanvas(layer.channels[c], size)])) as PaintMaps;
      if (layer.mask) layer.mask = cloneCanvas(layer.mask, size);
    }
    this.outputs.clear(); this.markAll(); this.notify();
  }

  async serialize() {
    this.endStroke();
    return JSON.stringify({ format: 'primepainter-engine', version: 1, resolution: this.resolution, activeTextureSetId: this.activeTextureSetId, activeLayerId: this.activeLayerId,
      textureSets: this.textureSets.map(set => ({ ...set, layers: set.layers.map(layer => ({ ...layer, mask: layer.mask?.toDataURL('image/png') ?? null, channels: layer.type === 'fill' ? null : Object.fromEntries(PAINT_CHANNELS.map(c => [c, layer.channels[c].toDataURL('image/png')])) })) })) });
  }
  async load(json: string) {
    if (json.length > 180_000_000) throw new Error('Project exceeds the 180 MB limit.');
    const data = JSON.parse(json);
    if (!data || data.format !== 'primepainter-engine' || data.version !== 1 || !RESOLUTIONS.includes(data.resolution) || !Array.isArray(data.textureSets) || data.textureSets.length < 1 || data.textureSets.length > 16) throw new Error('Unsupported or invalid PrimePainter project.');
    const ids = new Set<string>(); let layerCount = 0;
    const validateName = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 120;
    for (const set of data.textureSets) {
      if (!set || !validateName(set.id) || !validateName(set.name) || ids.has(set.id) || !Array.isArray(set.layers) || set.layers.length < 1 || (layerCount += set.layers.length) > 80) throw new Error('Invalid texture sets or layer count.');
      ids.add(set.id);
      for (const layer of set.layers) {
        if (!layer || !validateName(layer.id) || ids.has(layer.id) || !validateName(layer.name) || !['paint', 'fill'].includes(layer.type) || typeof layer.visible !== 'boolean') throw new Error('Invalid layer.');
        if (['color', 'roughness', 'metallic', 'height', 'opacity', 'scale', 'blendMode'].some(k => layer[k] === undefined) || (layer.type === 'fill' && typeof layer.materialId !== 'string')) throw new Error('Missing layer properties.');
        ids.add(layer.id); this.validateLayerParams(layer);
        if (layer.mask !== null && (typeof layer.mask !== 'string' || !layer.mask.length)) throw new Error('Invalid layer mask.');
        if (layer.type === 'paint' && (!layer.channels || PAINT_CHANNELS.some(c => typeof layer.channels[c] !== 'string'))) throw new Error('Missing paint channel.');
      }
    }
    this.assertRasterBudget(data.resolution, data.textureSets);
    if (!data.textureSets.some((s: { id: string }) => s.id === data.activeTextureSetId)) throw new Error('Invalid active texture set.');
    const active = data.textureSets.find((s: { id: string }) => s.id === data.activeTextureSetId);
    if (!active.layers.some((l: { id: string }) => l.id === data.activeLayerId)) throw new Error('Invalid active layer.');
    const decode = async (source: string) => {
      if (source.length > 32_000_000 || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(source)) throw new Error('Only embedded PNG channel data is supported.');
      let header: string;
      try { header = atob(source.slice(22, 66)); } catch { throw new Error('Invalid PNG channel data.'); }
      const uint32 = (offset: number) => (header.charCodeAt(offset) * 16777216 + header.charCodeAt(offset + 1) * 65536 + header.charCodeAt(offset + 2) * 256 + header.charCodeAt(offset + 3));
      if (!header.startsWith('\x89PNG\r\n\x1a\n') || header.slice(12, 16) !== 'IHDR' || uint32(16) !== data.resolution || uint32(20) !== data.resolution) throw new Error('Texture dimensions do not match the project.');
      const image = new Image(); image.src = source; await image.decode();
      if (image.width !== data.resolution || image.height !== data.resolution) throw new Error('Texture dimensions do not match the project.');
      const c = canvas(data.resolution); ctx(c).drawImage(image, 0, 0); return c;
    };
    // Validate and decode the complete replacement before touching the open project.
    const replacement: TextureSet[] = [];
    for (const set of data.textureSets) {
      const layers: Layer[] = [];
      for (const raw of set.layers) {
        const layer = { id: raw.id, name: raw.name, type: raw.type, visible: raw.visible, opacity: raw.opacity, blendMode: raw.blendMode, materialId: raw.materialId, color: raw.color, roughness: raw.roughness, metallic: raw.metallic, height: raw.height, scale: raw.scale, mask: raw.mask ? await decode(raw.mask) : null } as Layer;
        layer.channels = layer.type === 'fill' ? this.renderFill(layer, data.resolution) : Object.fromEntries(await Promise.all(PAINT_CHANNELS.map(async c => [c, await decode(raw.channels[c])]))) as PaintMaps;
        layers.push(layer);
      }
      replacement.push({ id: set.id, name: set.name, layers });
    }
    this.endStroke(); this.resolution = data.resolution; this.textureSets = replacement;
    this.activeTextureSetId = data.activeTextureSetId; this.activeLayerId = data.activeLayerId;
    this.past = []; this.future = []; this.outputs.clear(); this.markAll(); this.notify();
  }

  private validateLayerParams(values: LayerParams) {
    if (values.name !== undefined && (typeof values.name !== 'string' || values.name.length < 1 || values.name.length > 120)) throw new Error('Layer names must have 1–120 characters.');
    if (values.visible !== undefined && typeof values.visible !== 'boolean') throw new Error('Invalid layer visibility.');
    if (values.color !== undefined && !/^#[0-9a-f]{6}$/i.test(values.color)) throw new Error('Use a six digit hex color.');
    for (const key of ['opacity', 'roughness', 'metallic', 'height'] as const) if (values[key] !== undefined && (!Number.isFinite(values[key]) || values[key]! < 0 || values[key]! > 1)) throw new Error(`Invalid ${key} value.`);
    if (values.scale !== undefined && (!Number.isFinite(values.scale) || values.scale < .1 || values.scale > 20)) throw new Error('Material scale must be between 0.1 and 20.');
    if (values.blendMode !== undefined && !BLENDS.includes(values.blendMode)) throw new Error('Unsupported blend mode.');
    if (values.materialId !== undefined && !MATERIALS.some(m => m.id === values.materialId)) throw new Error('Unknown material preset.');
  }
  private checkLayerLimit(extraMaps = 4) {
    if (this.textureSets.reduce((sum, s) => sum + s.layers.length, 0) >= 80) throw new Error('This project has reached its 80-layer limit.');
    this.assertRasterBudget(this.resolution, this.textureSets, extraMaps);
  }
  private assertRasterBudget(resolution: number, sets: { layers: { mask: unknown }[] }[], extraMaps = 0) {
    const maps = sets.reduce((sum, set) => sum + 5 + set.layers.reduce((count, layer) => count + 4 + (layer.mask ? 2 : 0), 0), 1 + extraMaps);
    if (resolution * resolution * 4 * maps > 768 * 1024 * 1024) throw new Error('This project exceeds the 768 MiB texture memory budget. Use fewer layers or texture sets, or a lower resolution.');
  }
  private findLayer(id: string) { const layer = this.activeSet.layers.find(l => l.id === id); if (!layer) throw new Error('Layer does not exist.'); return layer; }
  private newSet(id: string, name: string, material: string): TextureSet { return { id, name, layers: [this.createLayer('fill', material)] }; }
  private createLayer(type: 'paint' | 'fill', materialId = 'enamel'): Layer {
    if (!['paint', 'fill'].includes(type)) throw new Error('Unsupported layer type.');
    const preset = MATERIALS.find(m => m.id === materialId); if (!preset) throw new Error('Unknown material preset.');
    const layer: Layer = { id: uid(), name: type === 'fill' ? preset.name : 'Paint layer', type, visible: true, opacity: 1, blendMode: 'source-over', materialId: type === 'fill' ? materialId : undefined, color: preset.color, roughness: preset.roughness, metallic: preset.metallic, height: preset.height, scale: 1, mask: null, channels: makeMaps(this.resolution) };
    if (type === 'fill') layer.channels = this.renderFill(layer); return layer;
  }
  private renderFill(layer: Layer, size = this.resolution): PaintMaps {
    const maps = makeMaps(size), images = Object.fromEntries(PAINT_CHANNELS.map(c => [c, ctx(maps[c]).createImageData(size, size)])) as Record<PaintChannel, ImageData>;
    const color = rgb(layer.color), pattern = MATERIALS.find(m => m.id === layer.materialId)?.pattern ?? 'smooth';
    const base = images.baseColor.data, rough = images.roughness.data, metal = images.metallic.data, height = images.height.data;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const sx = x * 1024 / size * layer.scale, sy = y * 1024 / size * layer.scale;
      const n = noise(Math.floor(sx), Math.floor(sy)) - .5;
      let detail = n * .045, bump = n * .01;
      if (pattern === 'brushed') { detail = (noise(Math.floor(sx / 28), Math.floor(sy * 2)) - .5) * .15 + n * .025; bump = detail * .08; }
      else if (pattern === 'grain') { detail = n * .09; bump = n * .025; }
      else if (pattern === 'paint') { detail = n * .025; bump = n * .008; }
      else if (pattern === 'concrete') { detail = n * .3 + (noise(Math.floor(sx / 18), Math.floor(sy / 18)) - .5) * .17; bump = detail * .17; }
      else if (pattern === 'fabric') { detail = Math.sin(sx * 1.5) * Math.cos(sy * 1.5) * .16 + n * .06; bump = detail * .14; }
      else if (pattern === 'carbon') { const a = Math.floor(sx / 9), b = Math.floor(sy / 9); detail = ((a + b) % 2 ? Math.sin(sx * .75) : Math.sin(sy * .75)) * .2 + ((a + b) % 2 ? .08 : -.08); bump = detail * .07; }
      else if (pattern === 'wood') { detail = Math.sin(sx * .19 + Math.sin(sy * .013) * 4 + noise(Math.floor(sx / 45), Math.floor(sy / 180)) * 2) * .17 + n * .065; bump = detail * .055; }
      else if (pattern === 'leather') { const cell = noise(Math.floor(sx / 6), Math.floor(sy / 6)); detail = cell * .16 + n * .1 - .08; bump = (cell < .25 ? -.05 : .008) + n * .01; }
      else { detail = 0; bump = 0; }
      const i = (y * size + x) * 4;
      base[i] = clamp(color[0] * (1 + detail), 0, 255); base[i + 1] = clamp(color[1] * (1 + detail), 0, 255); base[i + 2] = clamp(color[2] * (1 + detail), 0, 255); base[i + 3] = 255;
      const r = Math.round(clamp(layer.roughness + detail * .2) * 255), m = Math.round(layer.metallic * 255), h = Math.round(clamp(layer.height + bump) * 255);
      rough[i] = rough[i + 1] = rough[i + 2] = r; rough[i + 3] = 255;
      metal[i] = metal[i + 1] = metal[i + 2] = m; metal[i + 3] = 255;
      height[i] = height[i + 1] = height[i + 2] = h; height[i + 3] = 255;
    }
    for (const c of PAINT_CHANNELS) ctx(maps[c]).putImageData(images[c], 0, 0); return maps;
  }
  private dab(x: number, y: number, pressure: number, layer: Layer, stroke: Stroke) {
    const targets = this.brush.mask ? ['mask'] : this.brush.channel === 'material' ? PAINT_CHANNELS : [this.brush.channel];
    for (const channel of targets) {
      if (!stroke.cloned.has(channel)) {
        if (channel === 'mask') {
          if (layer.mask) {
            const previous = layer.mask; layer.mask = cloneCanvas(previous);
            const alpha = this.maskAlpha.get(previous); if (alpha) this.maskAlpha.set(layer.mask, cloneCanvas(alpha));
          } else {
            layer.mask = canvas(this.resolution); const c = ctx(layer.mask); c.fillStyle = '#fff'; c.fillRect(0, 0, this.resolution, this.resolution);
            this.maskAlpha.set(layer.mask, cloneCanvas(layer.mask));
          }
        } else layer.channels[channel as PaintChannel] = cloneCanvas(layer.channels[channel as PaintChannel]);
        stroke.cloned.add(channel);
      }
      const target = channel === 'mask' ? layer.mask! : layer.channels[channel as PaintChannel], c = ctx(target);
      let color = channel === 'baseColor' || channel === 'mask' ? this.brush.color : gray(this.brush[channel as 'roughness' | 'metallic' | 'height']);
      if (channel === 'mask') { const v = rgb(color).reduce((a, b) => a + b, 0) / (3 * 255); color = this.brush.erase ? '#000000' : gray(v); }
      const radius = Math.max(.5, clamp(this.brush.size, 1, this.resolution) * (.2 + pressure * .8) / 2), opacity = clamp(this.brush.flow) * pressure;
      c.save(); c.globalCompositeOperation = this.brush.erase && channel !== 'mask' ? 'destination-out' : 'source-over'; c.globalAlpha = opacity;
      const stamp = (px: number) => {
        const gradient = c.createRadialGradient(px, y, radius * clamp(this.brush.hardness, 0, .999), px, y, radius);
        gradient.addColorStop(0, color); gradient.addColorStop(1, 'rgba(0,0,0,0)'); c.fillStyle = gradient;
        c.beginPath(); c.arc(px, y, radius, 0, Math.PI * 2); c.fill();
      };
      stamp(x); if (this.brush.symmetry && Math.abs(x - this.resolution / 2) > .5) stamp(this.resolution - x); c.restore();
      if (channel === 'mask') {
        const left = this.brush.symmetry ? Math.min(x, this.resolution - x) : x, right = this.brush.symmetry ? Math.max(x, this.resolution - x) : x;
        this.maskAlphaDirty.set(target, this.unionBounds(this.maskAlphaDirty.get(target), { left: left - radius - 1, top: y - radius - 1, right: right + radius + 1, bottom: y + radius + 1 }));
      }
    }
  }
  private snapshot(): Snapshot { return { resolution: this.resolution, activeTextureSetId: this.activeTextureSetId, activeLayerId: this.activeLayerId, textureSets: this.textureSets.map(s => ({ ...s, layers: s.layers.map(l => ({ ...l, channels: { ...l.channels } })) })) }; }
  private checkpoint(endStroke = true) { if (endStroke) this.endStroke(); this.past.push(this.snapshot()); if (this.past.length > 16) this.past.shift(); this.future = []; }
  private trimHistory() {
    const maps = (layer: Layer) => { const alpha = layer.mask && this.maskAlpha.get(layer.mask); return [...Object.values(layer.channels), ...(layer.mask ? [layer.mask] : []), ...(alpha ? [alpha] : [])]; };
    const current = new Set(this.textureSets.flatMap(s => s.layers.flatMap(maps)));
    const retainedBytes = () => {
      const retained = new Set<HTMLCanvasElement>();
      for (const state of this.past) for (const set of state.textureSets) for (const layer of set.layers) for (const c of maps(layer)) if (!current.has(c)) retained.add(c);
      return [...retained].reduce((sum, c) => sum + c.width * c.height * 4, 0);
    };
    // shortcut: history targets 128 MiB but keeps one undo action; use disk-backed history for larger projects.
    while (this.past.length > 1 && retainedBytes() > 128 * 1024 * 1024) this.past.shift();
  }
  private restore(state: Snapshot) {
    this.resolution = state.resolution; this.textureSets = state.textureSets.map(s => ({ ...s, layers: s.layers.map(l => ({ ...l, channels: { ...l.channels } })) }));
    this.activeTextureSetId = state.activeTextureSetId; this.activeLayerId = state.activeLayerId; this.outputs.clear(); this.markAll(); this.notify();
  }
  private unionBounds(previous: Bounds | undefined, area: Bounds): Bounds {
    return previous ? { left: Math.min(previous.left, area.left), top: Math.min(previous.top, area.top), right: Math.max(previous.right, area.right), bottom: Math.max(previous.bottom, area.bottom) } : area;
  }
  private region(area?: Bounds) {
    const x = Math.max(0, Math.floor(area?.left ?? 0)), y = Math.max(0, Math.floor(area?.top ?? 0));
    return { x, y, width: Math.min(this.resolution, Math.ceil(area?.right ?? this.resolution)) - x, height: Math.min(this.resolution, Math.ceil(area?.bottom ?? this.resolution)) - y };
  }
  private markAll() { for (const set of this.textureSets) { this.dirty.add(set.id); this.dirtyAreas.set(set.id, null); this.dirtyChannels.set(set.id, new Set(PAINT_CHANNELS)); this.normalDirty.add(set.id); this.normalAreas.set(set.id, null); } }
  private changed(normal = true, area?: Bounds, channels: PaintChannel[] = PAINT_CHANNELS) {
    const id = this.activeTextureSetId; this.dirty.add(id);
    const previousArea = this.dirtyAreas.get(id);
    this.dirtyAreas.set(id, !area || previousArea === null ? null : this.unionBounds(previousArea, area));
    if (!this.dirtyChannels.has(id)) this.dirtyChannels.set(id, new Set());
    for (const channel of channels) this.dirtyChannels.get(id)!.add(channel);
    if (normal) {
      const previous = this.normalAreas.get(id);
      if (!area || previous === null) this.normalAreas.set(id, null);
      else this.normalAreas.set(id, this.unionBounds(previous, area));
      this.normalDirty.add(id);
    }
    this.notify();
  }
  private notify() { if (!this.stroke) this.trimHistory(); if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.flush(); this.onChange(); }); }
  private flush() {
    for (const id of this.dirty) {
      const set = this.textureSets.find(s => s.id === id); if (!set) continue;
      let output = this.outputs.get(id);
      if (!output) { output = { ...makeMaps(this.resolution), normal: canvas(this.resolution) }; this.outputs.set(id, output); this.dirtyAreas.set(id, null); this.dirtyChannels.set(id, new Set(PAINT_CHANNELS)); this.normalDirty.add(id); this.normalAreas.set(id, null); }
      const channels = this.dirtyChannels.get(id) ?? new Set(PAINT_CHANNELS);
      this.composite(set.layers, output, true, channels, this.dirtyAreas.get(id) ?? undefined);
      if (this.normalDirty.has(id)) this.renderNormal(output, this.normalAreas.get(id) ?? undefined);
      const revision = ++this.revision, versions = this.channelVersions.get(id) ?? { baseColor: 0, roughness: 0, metallic: 0, height: 0, normal: 0 };
      for (const channel of channels) versions[channel] = revision;
      if (this.normalDirty.has(id)) versions.normal = revision;
      this.channelVersions.set(id, versions); this.versions.set(id, revision);
    }
    this.dirty.clear(); this.dirtyAreas.clear(); this.dirtyChannels.clear(); this.normalDirty.clear(); this.normalAreas.clear();
  }
  private maskedSource(layer: Layer, channel: PaintChannel, area?: Bounds) {
    const { x, y, width, height } = this.region(area);
    if (!this.scratch) this.scratch = canvas(width);
    if (this.scratch.width !== width) this.scratch.width = width;
    if (this.scratch.height !== height) this.scratch.height = height;
    const scratch = this.scratch, c = ctx(scratch);
    let alpha = this.maskAlpha.get(layer.mask!);
    const dirty = this.maskAlphaDirty.get(layer.mask!);
    if (!alpha || dirty) {
      const region = this.region(alpha ? dirty : undefined);
      if (!alpha) alpha = canvas(this.resolution);
      const mask = ctx(layer.mask!).getImageData(region.x, region.y, region.width, region.height);
      for (let i = 0; i < mask.data.length; i += 4) mask.data[i + 3] = Math.round((mask.data[i] + mask.data[i + 1] + mask.data[i + 2]) / 3 * mask.data[i + 3] / 255);
      ctx(alpha).putImageData(mask, region.x, region.y); this.maskAlpha.set(layer.mask!, alpha); this.maskAlphaDirty.delete(layer.mask!);
    }
    c.globalCompositeOperation = 'source-over'; c.clearRect(0, 0, width, height); c.drawImage(layer.channels[channel], x, y, width, height, 0, 0, width, height);
    c.globalCompositeOperation = 'destination-in'; c.drawImage(alpha!, x, y, width, height, 0, 0, width, height); return scratch;
  }
  private composite(layers: Layer[], output: PaintMaps, background: boolean, channels: Iterable<PaintChannel> = PAINT_CHANNELS, area?: Bounds) {
    const { x, y, width, height } = this.region(area); if (width <= 0 || height <= 0) return;
    for (const channel of channels) {
      const c = ctx(output[channel]); c.globalCompositeOperation = 'source-over'; c.globalAlpha = 1; c.clearRect(x, y, width, height);
      if (background) { c.fillStyle = channel === 'baseColor' ? '#777777' : gray(channel === 'metallic' ? 0 : .5); c.fillRect(x, y, width, height); }
      for (const layer of layers) {
        if (!layer.visible || layer.opacity <= 0) continue;
        const source = layer.mask ? this.maskedSource(layer, channel, area) : layer.channels[channel];
        c.globalAlpha = layer.opacity; c.globalCompositeOperation = layer.blendMode; c.drawImage(source, layer.mask ? 0 : x, layer.mask ? 0 : y, width, height, x, y, width, height);
      }
      c.globalCompositeOperation = 'source-over'; c.globalAlpha = 1;
    }
  }
  private renderNormal(output: CanvasChannels, area?: Bounds) {
    const size = this.resolution, x0 = Math.max(0, Math.floor(area?.left ?? 0)), y0 = Math.max(0, Math.floor(area?.top ?? 0)), x1 = Math.min(size, Math.ceil(area?.right ?? size)), y1 = Math.min(size, Math.ceil(area?.bottom ?? size));
    const width = x1 - x0, height = y1 - y0; if (width <= 0 || height <= 0) return;
    const sx = Math.max(0, x0 - 1), sy = Math.max(0, y0 - 1), sw = Math.min(size, x1 + 1) - sx, sh = Math.min(size, y1 + 1) - sy;
    const source = ctx(output.height).getImageData(sx, sy, sw, sh).data, image = ctx(output.normal).createImageData(width, height), dest = image.data;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const left = source[((y - sy) * sw + Math.max(0, x - 1) - sx) * 4], right = source[((y - sy) * sw + Math.min(size - 1, x + 1) - sx) * 4];
      const top = source[((Math.max(0, y - 1) - sy) * sw + x - sx) * 4], bottom = source[((Math.min(size - 1, y + 1) - sy) * sw + x - sx) * 4];
      const nx = (left - right) * .025, ny = (bottom - top) * .025, length = Math.hypot(nx, ny, 1), i = ((y - y0) * width + x - x0) * 4;
      dest[i] = (nx / length * .5 + .5) * 255; dest[i + 1] = (ny / length * .5 + .5) * 255; dest[i + 2] = (1 / length * .5 + .5) * 255; dest[i + 3] = 255;
    }
    ctx(output.normal).putImageData(image, x0, y0);
  }
}
