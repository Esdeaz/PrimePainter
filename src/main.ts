import './styles.css';
import { shortcutKey } from './shortcuts';
import { PainterEngine, MATERIALS, type Layer, type Channel, type PaintChannel, type MaterialPreset, type BlendMode } from './engine';
import { PainterViewport, type ModelInfo, type PaintHit, type ViewChannel } from './viewport';
import { zipSync, strToU8 } from 'fflate';
import { createElement, Paintbrush, Eraser, PaintBucket, Pipette, Move, FlipHorizontal2, Undo2, Redo2, Columns2, Box, Square, ArrowLeftRight, Camera, Maximize, Minimize, X, Minus, ChevronDown, ChevronRight, MoreHorizontal, Plus, Search, SlidersHorizontal, Layers, Eye, EyeOff, Trash2, Copy, FilePlus2, FolderOpen, Save, Download, Upload, Settings2, Sun, Grid2X2, Focus, CircleHelp, History, Image, Circle, Diamond, FlaskConical, ScanLine, PanelLeft, PanelRight, Check, CheckCircle2, AlertTriangle, FileBox, SquareDashed, ArrowUp, ArrowDown, Info, Palette, Star, GripVertical, RotateCcw, RotateCw, MousePointer2, Leaf, Brush, Cylinder, ZoomIn, Monitor, Cuboid } from 'lucide';

declare global {
  interface Window {
    primeDesktop?: { minimize(): void; maximize(): void; close(): void; setDirty(value: boolean): void; saveFile(name: string, data: Uint8Array): Promise<{ saved: boolean; path?: string }>; openFile(kind: 'mesh' | 'project' | 'texture'): Promise<{name:string;data:Uint8Array;type:string}|null> };
    __primePainter: { engine: PainterEngine; viewport: PainterViewport; getProject(): Promise<string>; openProject(text: string): Promise<void>; state: typeof state };
  }
}
const iconNodes: Record<string, Parameters<typeof createElement>[0]> = { Paintbrush, Eraser, PaintBucket, Pipette, Move, FlipHorizontal2, Undo2, Redo2, Columns2, Box, Square, ArrowLeftRight, Camera, Maximize, Minimize, X, Minus, ChevronDown, ChevronRight, MoreHorizontal, Plus, Search, SlidersHorizontal, Layers, Eye, EyeOff, Trash2, Copy, FilePlus2, FolderOpen, Save, Download, Upload, Settings2, Sun, Grid2X2, Focus, CircleHelp, History, Image, Circle, Diamond, FlaskConical, ScanLine, PanelLeft, PanelRight, Check, CheckCircle2, AlertTriangle, FileBox, SquareDashed, ArrowUp, ArrowDown, Info, Palette, Star, GripVertical, RotateCcw, RotateCw, MousePointer2, Leaf, Brush, Cylinder, ZoomIn, Monitor, Cuboid };
const i = (name: string) => createElement(iconNodes[name] || Circle).outerHTML;
const esc = (text: unknown) => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const $ = <T extends HTMLElement = HTMLElement>(selector: string, parent: ParentNode = document) => parent.querySelector<T>(selector)!;
const $$ = <T extends HTMLElement = HTMLElement>(selector: string, parent: ParentNode = document) => Array.from(parent.querySelectorAll<T>(selector));
const ib = (action: string, icon: string, title: string, classes = '') => `<button class="icon-button ${classes}" data-action="${action}" title="${esc(title)}" aria-label="${esc(title)}">${i(icon)}</button>`;
const CH_LABELS: Record<ViewChannel, string> = { material: 'Material', baseColor: 'Base color', roughness: 'Roughness', metallic: 'Metallic', normal: 'Normal', height: 'Height' };
const CHANNELS: Channel[] = ['baseColor', 'roughness', 'metallic', 'normal', 'height'];
const BRUSHES = [
  { id: 'basic-hard', name: 'Basic Hard', hardness: 1, size: 42, spacing: .12, flow: 1 },
  { id: 'basic-soft', name: 'Basic Soft', hardness: .1, size: 90, spacing: .08, flow: .65 },
  { id: 'paint-round', name: 'Paint Round', hardness: .65, size: 48, spacing: .16, flow: .8 },
  { id: 'fine-detail', name: 'Fine Detail', hardness: .9, size: 10, spacing: .08, flow: 1 },
];
type Tool = 'paint' | 'erase' | 'fill' | 'pick';
const state = {
  name: 'Explorer_Helmet', dirty: false, layout: 'split' as 'split' | '3d' | '2d', channel: 'material' as ViewChannel,
  tool: 'paint' as Tool, wireframe: false, uvWireframe: true, grid: true, swapped: false, category: 'all', search: '',
  selectedMaterial: '', selectedBrush: 'paint-round', fillMode: 'triangle' as 'triangle' | 'island' | 'mesh' | 'set',
  activeSetTab: 'list', propertiesTab: 'brush', assetScale: 3, history: ['Opened demo project'],
  uvZoom: 1, uvPan: { x: 0, y: 0 }, exposure: 1.05, environment: 0, background: '#28292b',
};
let engine = new PainterEngine();
let viewport: PainterViewport;
let modelInfo: ModelInfo;
let painting = false, refreshing = false, menuElement: HTMLElement | null = null;
let autosaveTimer: ReturnType<typeof setTimeout> | undefined;
let dbPromise: Promise<IDBDatabase> | undefined;
let lastHit: PaintHit | null = null, active3DStroke = false;
let actionNumber = 0, busy = false, restoring = false;
let pendingNewProject: {name: string; resolution: number} | null = null;
const importedAssets: { name: string; canvas: HTMLCanvasElement }[] = [];
const uploadedRevisions=new Map<string,Record<Channel,number>>();

$('#app').innerHTML = `
<main class="application">
  <header class="titlebar"><span class="app-mark">Pp</span><span class="title-text"><strong id="title-project">Explorer_Helmet</strong><span class="separator">—</span><span class="title-app-name">PrimePainter · PBR Metal Roughness</span></span><span class="title-meta"><span class="local-dot"></span>Local workspace</span><div class="window-controls ${window.primeDesktop ? '' : 'hidden'}">${ib('window-min','Minus','Minimize')}${ib('window-max','Square','Maximize')}${ib('window-close','X','Close')}</div><span class="browser-window-controls ${window.primeDesktop ? 'hidden' : ''}"></span></header>
  <nav class="menubar" aria-label="Application menu">${['File','Edit','Mode','View','Window','Help'].map(name => `<button class="menu-trigger" data-menu="${name}">${name}</button>`).join('')}<span class="workspace-name">${i('Paintbrush')}Painting<span style="color:#666;margin:0 2px">|</span>PBR · Metallic Roughness</span></nav>
  <div class="context-bar" aria-label="Brush toolbar"><div class="context-brush"><span class="brush-dot"></span>${i('ChevronDown')}</div><label class="context-property">Size<input id="toolbar-size" type="number" min="1" max="500" value="42" aria-label="Brush size"><span class="unit">px</span></label><label class="context-property">Flow<input id="toolbar-flow" type="number" min="1" max="100" value="100" aria-label="Brush flow"><span class="unit">%</span></label><label class="context-property opacity-control">Hardness<input id="toolbar-hardness" type="number" min="0" max="100" value="75" aria-label="Brush hardness"><span class="unit">%</span></label><label class="context-property spacing-control">Spacing<input id="toolbar-spacing" type="number" min="2.5" max="100" value="16" aria-label="Brush spacing"><span class="unit">%</span></label><div class="context-divider"></div>${ib('symmetry','FlipHorizontal2','Mirror symmetry across texture U (L)')}${ib('undo','Undo2','Undo (Ctrl+Z)')}${ib('redo','Redo2','Redo (Ctrl+Y)')}<span class="context-spacer"></span><div class="segmented" aria-label="Viewport layout">${ib('layout-split','Columns2','3D / 2D view (F1)','active')}${ib('layout-3d','Box','3D view (F2)')}${ib('layout-2d','Square','2D view (F3)')}</div>${ib('swap','ArrowLeftRight','Swap 3D / 2D (F4)')}<div class="context-divider"></div>${ib('screenshot','Camera','Export viewport screenshot')}</div>
  <div class="workspace">
    <aside class="tools" aria-label="Painting tools">${ib('tool-paint','Paintbrush','Paint (1)','active')}${ib('tool-erase','Eraser','Eraser (2)')}${ib('tool-fill','PaintBucket','Polygon fill (4)')}${ib('tool-pick','Pipette','Material picker (P)')}<div class="tool-separator"></div>${ib('frame','Focus','Frame model (F)')}${ib('wireframe','Grid2X2','Toggle wireframe (W)')}${ib('symmetry','FlipHorizontal2','Mirror symmetry (L)')}<div class="tool-separator"></div><button class="brush-color" data-action="color" title="Brush color" aria-label="Brush color"></button><div class="tool-bottom">${ib('shortcuts','CircleHelp','Keyboard shortcuts')}</div></aside>
    <aside class="assets-panel" aria-label="Assets"><div class="panel-header">Assets<span class="panel-actions">${ib('import-texture','Plus','Import a texture')}${ib('asset-menu','MoreHorizontal','Asset options')}${ib('toggle-assets','X','Hide Assets panel')}</span></div><div class="asset-location"><select id="asset-source" aria-label="Asset source"><option value="all">All libraries</option><option value="materials">Starter assets</option><option value="textures">Your assets</option></select></div><div class="search-field">${i('Search')}<input type="search" id="asset-search" placeholder="Search your assets" aria-label="Search assets"></div><div class="asset-categories">${[['all','Circle','All materials'],['metal','Cylinder','Metals'],['paint','PaintBucket','Paint and plastics'],['organic','Leaf','Organic materials'],['brushes','Paintbrush','Brushes'],['textures','Image','Imported textures']].map(([id,icon,title])=>`<button data-category="${id}" title="${title}" aria-label="${title}" class="${id==='all'?'active':''}">${i(icon)}</button>`).join('')}</div><div class="asset-subhead"><span id="asset-kind-label">Materials</span><span id="asset-count">16 assets</span></div><div id="asset-grid" class="asset-grid"></div><div class="asset-footer">${i('Grid2X2')}<span id="assets-footer-count">16 assets</span><input type="range" id="asset-size" min="2" max="4" step="1" value="3" aria-label="Asset columns">${ib('import-texture','Upload','Import texture')}</div><div class="asset-resizer" role="separator" aria-orientation="vertical" aria-label="Resize Assets" tabindex="0"></div></aside>
    <section class="center-panel" aria-label="Texture painting workspace"><div class="document-tabbar"><span class="document-tab">${i('FileBox')}<span id="document-name">Explorer_Helmet</span><span class="dirty-dot" id="document-dirty"></span></span><span class="document-meta"><span class="small-dot"></span>Realtime PBR</span></div><div class="viewports layout-split"><section class="viewport-3d" aria-label="3D view"><div class="viewport-header"><select class="camera-select" aria-label="Camera"><option>Default camera</option><option>Front</option><option>Back</option><option>Left</option><option>Right</option><option>Top</option></select><select class="view-channel" aria-label="3D display channel">${Object.entries(CH_LABELS).map(([id,label])=>`<option value="${id}">${label}</option>`).join('')}</select></div><div class="view-label">Perspective <span style="color:#606060">/</span> <strong id="viewport-set">Body</strong></div><div class="axes"><span class="y">Y</span><span class="x">X</span><span class="z">Z</span></div></section><section class="viewport-2d" aria-label="2D UV view"><div class="viewport-header"><select class="view-channel" aria-label="2D display channel">${Object.entries(CH_LABELS).map(([id,label])=>`<option value="${id}">${label}</option>`).join('')}</select></div><canvas class="uv-canvas" id="uv-canvas" tabindex="0" aria-label="2D UV painting canvas"></canvas><div class="uv-tile-label">1001 <span style="color:#636363">/</span> UV tile</div><div class="axes"><span class="y">V</span><span class="x">U</span></div></section></div><div class="viewport-hint" id="navigation-hint"><kbd>Alt + drag</kbd> Orbit <span style="color:#555;padding:0 7px">|</span><kbd>Scroll</kbd> Zoom <span style="color:#555;padding:0 7px">|</span><kbd>F</kbd> Frame</div><div class="center-bottom-bar"><span class="engine-status"><i></i>Ready</span><span id="texture-size">1024 × 1024</span><span class="center-bottom-right">${i('Box')}<span id="triangle-count">— triangles</span><span id="uv-zoom">100%</span></span></div><div class="drag-overlay">${i('Upload')}<strong>Import into your workspace</strong><span>OBJ · GLB · glTF · PNG · JPG · .prime project</span></div></section>
    <aside class="right-panel" aria-label="Texture sets, layers and properties"><div class="right-resizer" role="separator" aria-orientation="vertical" aria-label="Resize Properties" tabindex="0"></div><section class="texture-panel"><div class="panel-tabs"><button class="active" data-set-tab="list">Texture Set List</button><button data-set-tab="settings">Texture Set Settings</button><span class="tab-close"></span></div><div class="texture-list" id="texture-list"></div><div id="texture-settings" class="texture-settings hidden"></div></section><section class="layer-panel"><div class="panel-tabs"><button class="active">Layers</button><span class="tab-close">${ib('layer-menu','MoreHorizontal','Layer options')}</span></div><div class="layer-settings-bar"><select id="layer-channel" aria-label="Layer channel">${Object.entries(CH_LABELS).filter(([id])=>id!=='material'&&id!=='normal').map(([id,label])=>`<option value="${id}">${label}</option>`).join('')}</select>${ib('mask','SquareDashed','Add a white mask')}${ib('layer-menu','MoreHorizontal','Layer options')}</div><div class="layers-actions">${ib('add-paint','Paintbrush','Add paint layer')}${ib('add-fill','PaintBucket','Add fill layer')}${ib('add-mask','SquareDashed','Add white mask')}${ib('duplicate','Copy','Duplicate layer (Ctrl+D)')}${ib('move-up','ArrowUp','Move layer up')}${ib('move-down','ArrowDown','Move layer down')}${ib('delete','Trash2','Delete layer (Delete)','delete-layer')}</div><div class="layer-list" id="layer-list"></div><div class="layer-footer"><span>Opacity</span><input type="range" id="layer-opacity" min="0" max="100" value="100" aria-label="Layer opacity"><span id="layer-opacity-value">100</span><select id="layer-blend" aria-label="Layer blend mode"><option value="source-over">Normal</option><option value="multiply">Multiply</option><option value="screen">Screen</option><option value="overlay">Overlay</option></select></div></section><section class="properties-panel"><div class="panel-header"><span id="properties-title">Properties - Paint</span><span class="panel-actions">${ib('reset-brush','RotateCcw','Reset brush')}${ib('properties-info','CircleHelp','Tool help')}</span></div><div class="properties-content" id="properties"></div></section></aside>
    <aside class="right-docks" aria-label="Dock panels">${ib('display','Sun','Display settings')}${ib('shader','SlidersHorizontal','Shader settings')}${ib('history','History','History')}${ib('toggle-assets','PanelLeft','Toggle Assets')}${ib('toggle-right','PanelRight','Toggle Properties')}<div class="tool-separator"></div>${ib('export','Download','Export textures (Ctrl+Shift+E)')}${ib('project-settings','Settings2','Project settings')}</aside>
  </div>
  <footer class="statusbar"><span class="status-message" id="status-message">${i('CheckCircle2')}Project ready. Select a paint layer and paint directly on your model.</span><span class="status-info"><span>Texture sets: <strong id="set-count">3</strong></span><span>Normal: <strong>OpenGL</strong></span><span id="autosave-status">Local project</span></span></footer>
</main><div class="brush-cursor"></div><div class="toast-container" aria-live="polite"></div><input class="hidden" type="file" id="open-project" accept=".prime"><input class="hidden" type="file" id="import-mesh" accept=".obj,.glb,.gltf"><input class="hidden" type="file" id="import-texture" accept="image/png,image/jpeg,image/webp"><input class="hidden" type="color" id="quick-color" value="#df7139">`;

function toast(message: string, error = false) {
  const el = document.createElement('div'); el.className = `toast${error ? ' error' : ''}`;
  el.innerHTML = `${i(error ? 'AlertTriangle' : 'CheckCircle2')}<span>${esc(message)}</span><button class="toast-dismiss" aria-label="Dismiss">×</button>`;
  $('.toast-container').append(el); $('button', el).onclick = () => el.remove(); setTimeout(() => el.remove(), error ? 10000 : 5000);
}
function status(message: string) { $('#status-message').innerHTML = `${i('CheckCircle2')}${esc(message)}`; }
function setDirty(dirty = true) {
  state.dirty = dirty; window.primeDesktop?.setDirty(dirty);
  $('#document-dirty').textContent = dirty ? '●' : '';
  $('#title-project').textContent = state.name + (dirty ? ' *' : '');
  document.title = `${state.name}${dirty ? ' *' : ''} — PrimePainter`;
}
function history(label: string) { state.history.push(label); if (state.history.length > 100) state.history.shift(); }
function perform(label: string, action: () => unknown) {
  if (busy) return;
  try { action(); setDirty(); actionNumber++; history(label); scheduleAutosave(); status(label); } catch (error) { fail(error); }
}
function fail(error: unknown) { console.error(error); toast(error instanceof Error ? error.message : String(error), true); }
function waitFrame() { return new Promise<void>(resolve => requestAnimationFrame(() => resolve())); }
async function withBusy<T>(message: string, action: () => Promise<T>): Promise<T> {
  if (busy) throw new Error('Wait for the current operation to finish.');
  busy = true; closeMenu();
  const overlay = document.createElement('div'); overlay.className = 'progress-overlay'; overlay.innerHTML = `<div class="progress-box"><span class="spinner"></span>${esc(message)}</div>`; document.body.append(overlay);
  try { await waitFrame(); await new Promise(resolve=>setTimeout(resolve,20)); return await action(); }
  finally { busy = false; overlay.remove(); }
}

function attachEngine(newEngine: PainterEngine) {
  engine.onChange = () => {}; engine = newEngine;uploadedRevisions.clear();
  if (window.__primePainter) window.__primePainter.engine = engine;
  engine.onChange = () => {
    if (refreshing) return;
    refreshing = true;
    try {
      syncTextures(); drawUV();
      if (!painting && !restoring) { renderSets(); renderLayers(); if(!$('#properties').contains(document.activeElement))renderProperties(); syncToolbar(); }
    } catch (error) { fail(error); }
    finally { refreshing = false; }
  };
}
function syncTextures() {
  if (!viewport) return;
  for (const set of engine.textureSets){const revisions=engine.getChannelRevisions(set.id),previous=uploadedRevisions.get(set.id),changed=CHANNELS.filter(channel=>previous?.[channel]!==revisions[channel]);if(changed.length){viewport.setTextureSet(set.id, engine.getChannels(set.id),changed);uploadedRevisions.set(set.id,revisions);}}
  viewport.setActiveSet(engine.activeTextureSetId);
  $('#texture-size').textContent = `${engine.resolution} × ${engine.resolution}`;
  $('#viewport-set').textContent = engine.activeSet.name;
  $('#set-count').textContent = String(engine.textureSets.length);
}
function changeActiveSet(id: string) {
  if (painting) return;
  engine.brush.mask = false; engine.setActiveSet(id); state.uvZoom = 1; state.uvPan = {x:0,y:0};
  renderSets(); renderLayers(); renderProperties(); syncTextures(); drawUV();
}
function renderSets() {
  $('#texture-list').innerHTML = engine.textureSets.map(set => `<button class="texture-row ${engine.activeTextureSetId===set.id?'active':''}" data-texture-set="${esc(set.id)}" title="${esc(set.name)}"><span class="texture-thumb" style="background:${esc(set.layers[0]?.color||'#999')}"></span><span>${esc(set.name)}</span><span>${engine.resolution}</span>${i('Eye')}</button>`).join('');
  $('#texture-settings').innerHTML = `<div class="property-row"><label>Size</label><select id="set-resolution" aria-label="Texture resolution">${[256,512,1024,2048].map(size=>`<option value="${size}" ${engine.resolution===size?'selected':''}>${size} × ${size}</option>`).join('')}</select></div><div class="channel-summary"><span>Base color · sRGB</span><span>Roughness</span><span>Metallic</span><span>Height</span><span>Normal · OpenGL</span></div>`;
  $('#texture-list').classList.toggle('hidden', state.activeSetTab!=='list'); $('#texture-settings').classList.toggle('hidden', state.activeSetTab!=='settings');
}
function makeThumbnail(source: HTMLCanvasElement, size = 32) { const c = document.createElement('canvas'); c.width=c.height=size; c.getContext('2d')!.drawImage(source,0,0,size,size); return c; }
function renderLayers() {
  const list = $('#layer-list'); const scroll = list.scrollTop;
  list.replaceChildren();
  for (const layer of [...engine.activeSet.layers].reverse()) {
    const el = document.createElement('div'); el.className = `layer-row ${layer.id===engine.activeLayerId?'active':''} ${layer.visible?'':'hidden-layer'}`; el.dataset.layer=layer.id; el.tabIndex=0; el.setAttribute('role','button'); el.setAttribute('aria-label',`Select layer ${layer.name}`); el.setAttribute('aria-pressed',String(layer.id===engine.activeLayerId));
    el.innerHTML = `<button class="layer-eye" data-layer-visibility="${esc(layer.id)}" title="${layer.visible?'Hide':'Show'} layer" aria-label="${layer.visible?'Hide':'Show'} ${esc(layer.name)}">${i(layer.visible?'Eye':'EyeOff')}</button><span class="layer-thumb-holder"></span>${layer.mask?`<span class="layer-mask-holder" data-layer-mask="${esc(layer.id)}"></span>`:''}<span class="layer-name"><span>${esc(layer.name)}</span><span class="layer-type">${layer.type==='fill'?'Fill layer':'Paint layer'}${layer.mask?' · mask':''}</span></span><span class="layer-values"><span>${Math.round(layer.opacity*100)}</span><span>${layer.blendMode==='source-over'?'Norm':layer.blendMode.slice(0,4)}</span></span>`;
    const thumb = makeThumbnail(layer.channels.baseColor); thumb.className = 'layer-preview'; $('.layer-thumb-holder',el).append(thumb);
    if (layer.mask) { const mask = makeThumbnail(layer.mask); mask.className = `layer-mask ${engine.brush.mask&&layer.id===engine.activeLayerId?'active':''}`; mask.title='Edit layer mask'; $('.layer-mask-holder',el).append(mask); }
    if (!layer.visible) el.style.opacity='.5';
    list.append(el);
  }
  list.scrollTop = scroll;
  const layer = engine.activeLayer;
  $('#layer-opacity-value').textContent = String(Math.round(layer.opacity*100));
  $<HTMLInputElement>('#layer-opacity').value = String(Math.round(layer.opacity*100)); $<HTMLSelectElement>('#layer-blend').value=layer.blendMode;
  $$<HTMLButtonElement>('[data-action="undo"]').forEach(b=>b.disabled=!engine.canUndo); $$<HTMLButtonElement>('[data-action="redo"]').forEach(b=>b.disabled=!engine.canRedo);
  $$<HTMLButtonElement>('[data-action="delete"]').forEach(b=>b.disabled=engine.activeSet.layers.length<=1);
}
const sectionTitle = (name: string) => `<div class="property-section-title" data-collapse>${i('ChevronDown')}${name}<span class="property-help">?</span></div>`;
function propertyRange(label: string, key: string, value: number, min=0, max=100, step=1, display?: string) {
  return `<div class="property-row"><label for="property-${key}">${label}</label><span class="property-input"><input type="range" id="property-${key}" data-property="${key}" min="${min}" max="${max}" step="${step}" value="${value}" aria-label="${label}"><span class="number-value" data-value="${key}">${display??(Number.isInteger(value)?value:value.toFixed(2))}</span></span></div>`;
}
function renderProperties() {
  const layer = engine.activeLayer, brush = engine.brush;
  const fill = layer.type==='fill'&&!brush.mask, erase = state.tool==='erase', polygon = state.tool==='fill';
  $('#properties-title').textContent = `Properties - ${brush.mask?'Mask':fill?'Fill':erase?'Eraser':polygon?'Polygon Fill':state.tool==='pick'?'Material Picker':'Paint'}`;
  let body = `<div class="properties-modebar"><button data-property-tab="brush" class="${state.propertiesTab==='brush'?'active':''}" title="Brush properties" aria-label="Brush properties">${i(fill?'PaintBucket':'Paintbrush')}</button><button data-property-tab="material" class="${state.propertiesTab==='material'?'active':''}" title="Material properties" aria-label="Material properties">${i('Circle')}</button><button data-property-tab="alpha" class="${state.propertiesTab==='alpha'?'active':''}" title="Alpha properties" aria-label="Alpha properties">${i('SquareDashed')}</button></div>`;
  if (state.tool==='pick') body+=`<div class="properties-note">Click the model or the 2D texture to sample its base color, roughness, metallic and height into the brush. Press 1 to return to Paint.</div>`;
  if (polygon) body+=sectionTitle('Selection')+`<div class="property-fields"><div class="property-row"><label for="fill-mode">Fill mode</label><select id="fill-mode"><option value="triangle" ${state.fillMode==='triangle'?'selected':''}>Triangle</option><option value="island" ${state.fillMode==='island'?'selected':''}>UV island</option><option value="mesh" ${state.fillMode==='mesh'?'selected':''}>Mesh element</option><option value="set" ${state.fillMode==='set'?'selected':''}>Texture set</option></select></div><div class="properties-note" style="padding:4px 0 0">Click the visible model surface to fill its UV polygons.</div></div>`;
  if (!fill && state.tool!=='pick' && state.propertiesTab==='brush') {
    body+=`<div class="brush-preview-wrapper"><canvas class="brush-preview" width="280" height="60" id="brush-preview" aria-label="Current brush stroke preview"></canvas></div>`+sectionTitle('Brush')+`<div class="property-fields">${propertyRange('Size','size',brush.size,1,500,1,`${brush.size.toFixed(0)}`)}${propertyRange('Flow','flow',Math.round(brush.flow*100),1,100)}${propertyRange('Hardness','hardness',Math.round(brush.hardness*100))}${propertyRange('Spacing','spacing',Math.round(brush.spacing*100),3,100)}<label class="property-toggle"><input type="checkbox" id="brush-symmetry" ${brush.symmetry?'checked':''}>Mirror symmetry (texture U)</label></div>`;
  }
  if (state.propertiesTab==='alpha'&&!fill) body+=sectionTitle('Alpha')+`<div class="property-fields"><div class="property-row">Procedural round alpha<span class="alpha-preview"></span></div>${propertyRange('Hardness','hardness',Math.round(brush.hardness*100))}<div class="properties-note" style="padding:8px 0 0">Pressure controls stroke size and flow when a pen tablet is available.</div></div>`;
  if (fill) body+=sectionTitle('Fill')+`<div class="property-fields"><div class="property-row"><label>Projection</label><select aria-label="Fill projection"><option>UV projection</option></select></div>${propertyRange('UV scale','scale',layer.scale,.1,20,.1,layer.scale.toFixed(1))}</div>`;
  if (!erase || brush.mask) {
    const activeChannel=brush.channel;
    body+=sectionTitle(brush.mask?'Grayscale':'Material')+(brush.mask?'':`<div class="channel-buttons">${[['material','All'],['baseColor','color'],['roughness','rough'],['metallic','metal'],['height','height']].map(([id,label])=>`<button class="${activeChannel===id?'active':''}" data-brush-channel="${id}" title="Paint ${id==='material'?'all channels':label}">${label}</button>`).join('')}</div>`)+`<div class="material-color-row"><span>${brush.mask?'Mask value':'Base color'}</span><input type="color" id="property-color" value="${fill?layer.color:brush.color}" aria-label="${brush.mask?'Mask value':'Base color'}"></div>`;
    if (brush.mask) body+=`<div class="property-fields"><button class="action-button" data-action="mask-invert-color">Swap black / white (X)</button><div class="properties-note" style="padding:7px 0 0">White reveals the layer. Black hides it.</div></div>`;
    else body+=`<div class="property-fields">${propertyRange('Roughness','roughness',fill?layer.roughness:brush.roughness,0,1,.01)}${propertyRange('Metallic','metallic',fill?layer.metallic:brush.metallic,0,1,.01)}${propertyRange('Height','height',fill?layer.height:brush.height,0,1,.01)}</div>`;
  }
  if (fill) body+=`<div class="properties-note">Fill layers update procedurally. Add a paint layer or edit a mask to paint strokes.</div>`;
  const content=$('#properties'),scroll=content.scrollTop; content.innerHTML=body;content.scrollTop=scroll; drawBrushPreview();
  viewport?.setPaintEnabled(true);
}
function drawBrushPreview() {
  const c=$<HTMLCanvasElement>('#brush-preview'); if (!c) return;
  const ctx=c.getContext('2d')!;ctx.fillStyle='#242424';ctx.fillRect(0,0,c.width,c.height);
  const r=8+engine.brush.size/35;
  for(let x=20;x<c.width-20;x+=Math.max(1,r*engine.brush.spacing)){
    const y=31+Math.sin(x/45)*8,grad=ctx.createRadialGradient(x,y,r*engine.brush.hardness,x,y,r);grad.addColorStop(0,`rgba(218,218,218,${engine.brush.flow})`);grad.addColorStop(1,'rgba(218,218,218,0)');ctx.fillStyle=grad;ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fill();
  }
}
function syncToolbar() {
  const b=engine.brush;
  for(const [id,value] of [['size',b.size],['flow',Math.round(b.flow*100)],['hardness',Math.round(b.hardness*100)],['spacing',Math.round(b.spacing*100)]] as const) $<HTMLInputElement>(`#toolbar-${id}`).value=String(value);
  $$('[data-action="symmetry"]').forEach(el=>el.classList.toggle('active',b.symmetry));
  $$('[data-action^="tool-"]').forEach(el=>el.classList.toggle('active',el.dataset.action===`tool-${state.tool}`));
  $('.brush-color').style.background=b.color;$<HTMLInputElement>('#quick-color').value=b.color;
}

const previewCache = new Map<string,HTMLCanvasElement>();
function spherePreview(preset: MaterialPreset) {
  if (previewCache.has(preset.id)) return makeThumbnail(previewCache.get(preset.id)!,96);
  const texture=engine.createMaterialPreview(preset,128),data=texture.getContext('2d')!.getImageData(0,0,128,128).data;
  const c=document.createElement('canvas');c.width=c.height=128;const ctx=c.getContext('2d')!,image=ctx.createImageData(128,128),out=image.data;
  for(let y=0;y<128;y++)for(let x=0;x<128;x++){
    const nx=(x-63.5)/57,ny=-(y-58)/57,rr=nx*nx+ny*ny;
    if(rr>1)continue;const nz=Math.sqrt(1-rr),diff=Math.max(0,nx*-.43+ny*.64+nz*.62),u=(Math.atan2(nx,nz)/Math.PI+.5),v=(Math.asin(ny)/Math.PI+.5),ti=(Math.min(127,Math.floor((1-v)*128))*128+Math.min(127,Math.floor(u*128)))*4;
    const shine=Math.pow(Math.max(0,nx*-.35+ny*.45+nz*.82),12+(1-preset.roughness)*90)*(1-preset.roughness)*1.2;
    const sideLight=Math.pow(Math.max(0,nx*.8+ny*.2+nz*.56),20)*preset.metallic*.35;
    const shade=.23+diff*.76,idx=(y*128+x)*4;
    for(let k=0;k<3;k++)out[idx+k]=Math.min(255,data[ti+k]*shade+255*(shine+sideLight));out[idx+3]=255;
  }
  ctx.fillStyle='rgba(0,0,0,.25)';ctx.beginPath();ctx.ellipse(65,117,42,5,0,0,Math.PI*2);ctx.fill();ctx.putImageData(image,0,0);previewCache.set(preset.id,c);return makeThumbnail(c,96);
}
function renderAssets() {
  const grid=$('#asset-grid');grid.replaceChildren();
  const query=state.search.toLowerCase();let count=0;
  if(state.category==='brushes'){
    for(const brush of BRUSHES.filter(b=>b.name.toLowerCase().includes(query))){
      const el=document.createElement('button');el.className=`asset-card ${state.selectedBrush===brush.id?'selected':''}`;el.dataset.brushPreset=brush.id;el.title=`${brush.name} — select brush`;el.innerHTML=`<canvas width="96" height="96"></canvas><span class="asset-label">${brush.name}</span>`;
      const ctx=$<HTMLCanvasElement>('canvas',el).getContext('2d')!,g=ctx.createRadialGradient(48,45,30*brush.hardness,48,45,34);g.addColorStop(0,'#ddd');g.addColorStop(1,'#ddd0');ctx.fillStyle=g;ctx.beginPath();ctx.arc(48,45,34,0,Math.PI*2);ctx.fill();grid.append(el);count++;
    }
  }else if(state.category==='textures'){
    importedAssets.forEach((asset,index)=>{if(!asset.name.toLowerCase().includes(query))return;const el=document.createElement('button');el.className='asset-card';el.dataset.textureAsset=String(index);el.title=`Add ${asset.name} as a paint layer`;el.append(makeThumbnail(asset.canvas,96));el.insertAdjacentHTML('beforeend',`<span class="asset-label">${esc(asset.name)}</span>`);grid.append(el);count++;});
    if(!count)grid.innerHTML=`<div class="empty-assets">No imported textures.<br><button class="action-button" data-action="import-texture" style="margin-top:12px">Import resources…</button></div>`;
  }else{
    const materials=MATERIALS.filter(m=>(state.category==='all'||(state.category==='metal'&&m.category==='Metal')||(state.category==='paint'&&['Paint','Plastic','Glass','Ceramic'].includes(m.category))||(state.category==='organic'&&['Wood','Leather','Fabric','Concrete'].includes(m.category)))&&`${m.name} ${m.category}`.toLowerCase().includes(query));
    for(const preset of materials){const el=document.createElement('button');el.className=`asset-card ${state.selectedMaterial===preset.id?'selected':''}`;el.dataset.material=preset.id;el.title=`${preset.name}\nDouble-click to add a fill layer. Drag onto the viewport to apply.`;el.draggable=true;el.append(spherePreview(preset));el.insertAdjacentHTML('beforeend',`<span class="asset-label">${preset.name}</span><span class="asset-badge">⁙</span>`);grid.append(el);count++;}
    if(!count)grid.innerHTML='<div class="empty-assets">No matching assets.</div>';
  }
  $('#asset-kind-label').textContent=state.category==='brushes'?'Brushes':state.category==='textures'?'Your textures':'Materials';$('#asset-count').textContent=`${count} assets`;$('#assets-footer-count').textContent=`${count} assets`;grid.style.gridTemplateColumns=`repeat(${state.assetScale},minmax(0,1fr))`;
  $$('[data-category]').forEach(el=>el.classList.toggle('active',el.dataset.category===state.category));
}

const uvCanvas=$<HTMLCanvasElement>('#uv-canvas');
let uvBox={x:0,y:0,size:1},uvDrawing=false,uvPanning=false,uvPointer={x:0,y:0};
function drawUV(){
  const area=$('.viewport-2d'),w=area.clientWidth,h=area.clientHeight;if(!w||!h||!viewport)return;
  const dpr=Math.min(devicePixelRatio,2);if(uvCanvas.width!==Math.round(w*dpr)||uvCanvas.height!==Math.round(h*dpr)){uvCanvas.width=Math.round(w*dpr);uvCanvas.height=Math.round(h*dpr);}
  const ctx=uvCanvas.getContext('2d')!;ctx.setTransform(dpr,0,0,dpr,0,0);ctx.fillStyle='#242424';ctx.fillRect(0,0,w,h);
  const size=Math.min(w-38,h-106)*state.uvZoom,x=(w-size)/2+state.uvPan.x,y=(h-size)/2+state.uvPan.y;uvBox={x,y,size};
  ctx.strokeStyle='#2b2b2b';ctx.lineWidth=1;ctx.beginPath();
  for(let gx=((x%size)+size)%size;gx<w;gx+=Math.max(size,1)){ctx.moveTo(gx,0);ctx.lineTo(gx,h);}for(let gy=((y%size)+size)%size;gy<h;gy+=Math.max(size,1)){ctx.moveTo(0,gy);ctx.lineTo(w,gy);}ctx.stroke();
  const source=engine.brush.mask&&engine.activeLayer.mask?engine.activeLayer.mask:engine.getChannels()[state.channel==='material'?'baseColor':state.channel];
  ctx.fillStyle='#181818';ctx.fillRect(x-1,y-1,size+2,size+2);ctx.drawImage(source,x,y,size,size);
  if(state.uvWireframe){ctx.save();ctx.translate(x,y);viewport.drawUV(ctx,engine.activeTextureSetId,size,size);ctx.restore();}
  ctx.strokeStyle='#767676';ctx.strokeRect(x,y,size,size);ctx.fillStyle='#8c8c8c';ctx.font='9px Segoe UI';ctx.fillText('1001',x+4,y+size+14);
  $('#uv-zoom').textContent=`${Math.round(state.uvZoom*100)}%`;
}
const uvAt=(event:PointerEvent)=>{const rect=uvCanvas.getBoundingClientRect();return {u:(event.clientX-rect.left-uvBox.x)/uvBox.size,v:1-(event.clientY-rect.top-uvBox.y)/uvBox.size};};
function showCursor(event:{clientX:number;clientY:number},visible=true,scale=1){const c=$('.brush-cursor');c.style.display=visible&&state.tool!=='pick'?'block':'none';c.style.left=`${event.clientX}px`;c.style.top=`${event.clientY}px`;const size=Math.max(5,engine.brush.size*scale);c.style.width=c.style.height=`${size}px`;}
function canPaint(){
  if(engine.activeLayer.type==='fill'&&!engine.brush.mask){toast('Fill layers are procedural. Add a paint layer, or select its mask to paint.');return false;}
  return true;
}
function sample(u:number,v:number,setId=engine.activeTextureSetId){
  const maps=engine.getChannels(setId),x=Math.max(0,Math.min(engine.resolution-1,Math.floor(u*engine.resolution))),y=Math.max(0,Math.min(engine.resolution-1,Math.floor((1-v)*engine.resolution)));
  const pixel=maps.baseColor.getContext('2d')!.getImageData(x,y,1,1).data;engine.brush.color='#'+Array.from(pixel.slice(0,3)).map(n=>n.toString(16).padStart(2,'0')).join('');
  for(const channel of ['roughness','metallic','height'] as const)engine.brush[channel]=maps[channel].getContext('2d')!.getImageData(x,y,1,1).data[0]/255;
  syncToolbar();renderProperties();status(`Sampled ${engine.brush.color.toUpperCase()} · roughness ${engine.brush.roughness.toFixed(2)} · metallic ${engine.brush.metallic.toFixed(2)}`);
}
function endPaint(){
  if(!painting)return;engine.endStroke();painting=false;active3DStroke=false;lastHit=null;setDirty();actionNumber++;history(state.tool==='erase'?'Erase stroke':engine.brush.mask?'Paint mask':'Paint stroke');scheduleAutosave();renderLayers();
}
function paintStart(hit:PaintHit){
  lastHit=null;
  if(state.tool==='pick'){sample(hit.uv.x,hit.uv.y,hit.setId);return;}
  if(hit.setId!==engine.activeTextureSetId){const name=engine.textureSets.find(s=>s.id===hit.setId)?.name??hit.setId;status(`Select the “${name}” texture set to paint this surface.`);return;}
  if(!canPaint())return;
  if(state.tool==='fill'){
    const triangles=state.fillMode==='set'?viewport.getUVTriangles(hit.setId):state.fillMode==='mesh'?viewport.getUVTriangles(hit.setId,hit.meshId):state.fillMode==='island'?viewport.getUVIslandTriangles(hit):[hit.triangleUV.flatMap(uv=>[uv.x,uv.y])];
    perform(`Polygon fill · ${state.fillMode}`,()=>engine.fillPolygons(triangles));return;
  }
  painting=true;active3DStroke=true;engine.beginStroke();engine.paint(hit.uv.x,hit.uv.y,hit.pressure);lastHit=hit;
}
function paintMove(hit:PaintHit){
  if(!active3DStroke||!painting)return;
  if(hit.setId!==engine.activeTextureSetId){engine.breakStroke();lastHit=null;return;}
  // UV islands are discontinuous; reconnecting them would paint across unrelated atlas regions.
  if(lastHit&&(lastHit.meshId!==hit.meshId||lastHit.islandId!==hit.islandId||Math.hypot(lastHit.uv.x-hit.uv.x,lastHit.uv.y-hit.uv.y)>.16))engine.breakStroke();
  engine.paint(hit.uv.x,hit.uv.y,hit.pressure);lastHit=hit;
}
function setTool(tool:Tool){endPaint();state.tool=tool;engine.brush.erase=tool==='erase';syncToolbar();renderProperties();status(({paint:'Paint · left mouse paints. Alt + drag orbits.',erase:'Eraser · removes paint from the active layer.',fill:'Polygon Fill · click a triangle, mesh element, or texture set.',pick:'Material Picker · click the surface to sample its PBR values.'})[tool]);}
function setLayout(layout:typeof state.layout){state.layout=layout;$('.viewports').className=`viewports layout-${layout}${state.swapped?' swapped':''}`;for(const name of ['split','3d','2d'])$$(`[data-action="layout-${name}"]`).forEach(el=>el.classList.toggle('active',layout===name));requestAnimationFrame(()=>{drawUV();requestAnimationFrame(()=>viewport?.frame());});}
function setChannel(channel:ViewChannel){state.channel=channel;viewport.setChannel(channel);$$<HTMLSelectElement>('.view-channel').forEach(el=>el.value=channel);drawUV();}
function applyMaterial(id:string){const preset=MATERIALS.find(m=>m.id===id);if(!preset)return;perform(`Applied ${preset.name}`,()=>{engine.brush.mask=false;engine.addLayer('fill',id);});state.selectedMaterial=id;renderAssets();renderProperties();}
function applyBrush(id:string){const brush=BRUSHES.find(b=>b.id===id);if(!brush)return;Object.assign(engine.brush,{size:brush.size,hardness:brush.hardness,spacing:brush.spacing,flow:brush.flow});state.selectedBrush=id;setTool('paint');renderAssets();syncToolbar();renderProperties();}

async function getProject(){
  const engineJson=await engine.serialize();
  return JSON.stringify({format:'primepainter',version:1,name:state.name,engine:JSON.parse(engineJson),model:viewport.serializeModel(),brush:engine.brush,view:{layout:state.layout,channel:state.channel}});
}
async function openProject(text:string){
  if(text.length>220_000_000)throw new Error('Project exceeds the 220 MB file limit.');
  const data=JSON.parse(text);
  if(!data||data.format!=='primepainter'||data.version!==1||typeof data.name!=='string'||data.name.length>120||!data.engine||!data.model)throw new Error('This is not a supported .prime project. Substance .spp files are not supported.');
  const candidate=new PainterEngine(256);await candidate.load(JSON.stringify(data.engine));
  if(!Array.isArray(data.model.sets)||data.model.sets.length!==candidate.textureSets.length||!data.model.sets.every((s:{id:string})=>candidate.textureSets.some(t=>t.id===s.id)))throw new Error('Model material IDs do not match the project texture sets.');
  const info=viewport.restoreModel(data.model);restoring=true;attachEngine(candidate);modelInfo=info;
  if(data.brush&&typeof data.brush==='object'){
    for(const key of ['size','flow','hardness','spacing','roughness','metallic','height'] as const){const value=data.brush[key],min=key==='size'?1:key==='spacing'?.025:key==='flow'?.01:0;if(typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=(key==='size'?500:1))engine.brush[key]=value;}
    if(/^#[0-9a-f]{6}$/i.test(data.brush.color))engine.brush.color=data.brush.color;
    if(['material','baseColor','roughness','metallic','height'].includes(data.brush.channel))engine.brush.channel=data.brush.channel;
    if(typeof data.brush.symmetry==='boolean')engine.brush.symmetry=data.brush.symmetry;
    if(typeof data.brush.mask==='boolean')engine.brush.mask=data.brush.mask&&!!engine.activeLayer.mask;
  }
  state.name=data.name;state.history=['Opened project'];state.tool='paint';state.uvPan={x:0,y:0};state.uvZoom=1;
  if(['split','3d','2d'].includes(data.view?.layout))setLayout(data.view.layout);
  setChannel(Object.hasOwn(CH_LABELS,data.view?.channel)?data.view.channel:'material');setDirty(false);actionNumber++;restoring=false;refreshAll();status(`Opened ${state.name}.`);
}
async function saveOutput(name:string,data:Uint8Array,mime='application/octet-stream'){
  if(window.primeDesktop)return (await window.primeDesktop.saveFile(name,data)).saved;
  const copy=new Uint8Array(data.byteLength);copy.set(data);const blob=new Blob([copy],{type:mime}),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=name;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);return true;
}
const safeFilename=(name:string)=>{const cleaned=name.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').slice(0,100).replace(/[. ]+$/,'')||'Untitled';return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned)?`_${cleaned}`:cleaned;};
async function saveProject(){
  try{
    const revision=actionNumber;const saved=await withBusy('Saving project…',async()=>saveOutput(`${safeFilename(state.name)}.prime`,strToU8(await getProject()),'application/json'));
    if(saved){if(actionNumber===revision)setDirty(false);toast(`Saved ${state.name}.prime`);status('Project saved.');}
  }catch(error){fail(error);}
}
function getDB(){
  return dbPromise??=new Promise<IDBDatabase>((resolve,reject)=>{const request=indexedDB.open('primepainter',1);request.onupgradeneeded=()=>request.result.createObjectStore('projects');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
}
async function storeAutosave(value:string){const db=await getDB();return new Promise<void>((resolve,reject)=>{const t=db.transaction('projects','readwrite');t.objectStore('projects').put({text:value,name:state.name,time:Date.now()},'autosave');t.oncomplete=()=>resolve();t.onerror=()=>reject(t.error);});}
async function readAutosave(){const db=await getDB();return new Promise<{text:string,name:string,time:number}|undefined>((resolve,reject)=>{const request=db.transaction('projects').objectStore('projects').get('autosave');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}
function scheduleAutosave(){
  clearTimeout(autosaveTimer);$('#autosave-status').textContent='Unsaved changes';
  autosaveTimer=setTimeout(async()=>{if(painting||busy){scheduleAutosave();return;}try{const revision=actionNumber;await storeAutosave(await getProject());if(revision===actionNumber)$('#autosave-status').textContent='Recovery copy saved';}catch{ $('#autosave-status').textContent='Recovery unavailable · save project';}},2500);
}
function canvasBytes(canvas:HTMLCanvasElement){return new Promise<Uint8Array>((resolve,reject)=>canvas.toBlob(async blob=>{if(!blob){reject(new Error('PNG encoding failed.'));return;}resolve(new Uint8Array(await blob.arrayBuffer()));},'image/png'));}
function normalDirectX(source:HTMLCanvasElement){const c=makeThumbnail(source,source.width),ctx=c.getContext('2d')!,image=ctx.getImageData(0,0,c.width,c.height);for(let j=1;j<image.data.length;j+=4)image.data[j]=255-image.data[j];ctx.putImageData(image,0,0);return c;}
function packedMap(maps:ReturnType<PainterEngine['getChannels']>,template:string){
  const n=engine.resolution,c=document.createElement('canvas');c.width=c.height=n;const ctx=c.getContext('2d')!,out=ctx.createImageData(n,n),rough=maps.roughness.getContext('2d')!.getImageData(0,0,n,n).data,metal=maps.metallic.getContext('2d')!.getImageData(0,0,n,n).data;
  for(let j=0;j<out.data.length;j+=4){if(template==='unreal'){out.data[j]=255;out.data[j+1]=rough[j];out.data[j+2]=metal[j];out.data[j+3]=255;}else if(template==='hdrp'){out.data[j]=metal[j];out.data[j+1]=255;out.data[j+2]=255;out.data[j+3]=255-rough[j];}else{out.data[j]=out.data[j+1]=out.data[j+2]=metal[j];out.data[j+3]=255-rough[j];}}ctx.putImageData(out,0,0);return c;
}
async function exportTextures(){
  const dialog=$('.dialog');const template=$<HTMLSelectElement>('#export-template',dialog).value,normalFormat=$<HTMLSelectElement>('#export-normal',dialog).value;
  const selected=$$<HTMLInputElement>('[data-export-set]:checked',dialog).map(el=>el.dataset.exportSet!);if(!selected.length){toast('Select at least one texture set.',true);return;}
  const selectedChannels=$$<HTMLInputElement>('[data-export-channel]:checked',dialog).map(el=>el.dataset.exportChannel as Channel);if(template==='pbr'&&!selectedChannels.length){toast('Select at least one output map.',true);return;}
  try{
    await withBusy('Exporting texture maps…',async()=>{
      const files:Record<string,Uint8Array>={},usedNames=new Set<string>(),exportedSets:{id:string;name:string;directory:string}[]=[];
      for(const setId of selected){const set=engine.textureSets.find(s=>s.id===setId)!,base=safeFilename(set.name);let prefix=base,suffix=2;while(usedNames.has(prefix.toLowerCase()))prefix=`${base}_${suffix++}`;usedNames.add(prefix.toLowerCase());exportedSets.push({id:set.id,name:set.name,directory:prefix});const maps=engine.getChannels(setId);const directX=normalFormat==='directx'||template==='unreal';
        if(template==='pbr'){for(const channel of selectedChannels)files[`${prefix}/${prefix}_${({baseColor:'BaseColor',roughness:'Roughness',metallic:'Metallic',normal:'Normal',height:'Height'})[channel]}.png`]=await canvasBytes(channel==='normal'&&directX?normalDirectX(maps.normal):maps[channel]);}
        else{files[`${prefix}/${prefix}_BaseColor.png`]=await canvasBytes(maps.baseColor);files[`${prefix}/${prefix}_Normal.png`]=await canvasBytes(directX?normalDirectX(maps.normal):maps.normal);files[`${prefix}/${prefix}_${template==='unreal'?'OcclusionRoughnessMetallic':template==='hdrp'?'MaskMap':'MetallicSmoothness'}.png`]=await canvasBytes(packedMap(maps,template));files[`${prefix}/${prefix}_Height.png`]=await canvasBytes(maps.height);}
        await waitFrame();
      }
      files['manifest.json']=strToU8(JSON.stringify({application:'PrimePainter',version:1,project:state.name,template,resolution:engine.resolution,precision:'8-bit PNG',normal:template==='unreal'?'DirectX':normalFormat,sets:exportedSets,occlusion:'Not baked; packed AO channel defaults to white (1).'},null,2));
      files['README.txt']=strToU8('PrimePainter texture export\nBase Color: sRGB. All other maps: linear data.\nNormal format is specified in manifest.json.\nHeight is centered at 0.5. PNG precision: 8-bit per channel.\nUnity HDRP: R=metallic, G=AO (white, not baked), B=detail mask (white), A=smoothness.\nUnity URP: RGB=metallic, A=smoothness. Unreal: R=AO (white, not baked), G=roughness, B=metallic.\n');
      const zip=zipSync(files,{level:1});if(await saveOutput(`${safeFilename(state.name)}_textures.zip`,zip,'application/zip')){closeDialog();toast(`Exported ${selected.length} texture set${selected.length>1?'s':''} at ${engine.resolution}².`);status('Texture export complete.');}
    });
  }catch(error){fail(error);}
}

function closeDialog(){ $('.dialog-backdrop')?.remove(); }
function showDialog(title:string,body:string,footer:string,wide=false){closeMenu();closeDialog();const backdrop=document.createElement('div');backdrop.className='dialog-backdrop';backdrop.innerHTML=`<section class="dialog ${wide?'wide':''}" role="dialog" aria-modal="true" aria-label="${esc(title)}"><header class="dialog-title">${i('FileBox')}${esc(title)}<button class="dialog-close icon-button" data-action="close-dialog" aria-label="Close dialog">${i('X')}</button></header><div class="dialog-body">${body}</div><footer class="dialog-footer">${footer}</footer></section>`;document.body.append(backdrop);const focus=backdrop.querySelector<HTMLElement>('input,select,button');focus?.focus();return backdrop;}
const cancelButton='<button class="action-button" data-action="close-dialog">Cancel</button>';
async function confirmDiscard():Promise<boolean>{
  if(!state.dirty)return true;
  return new Promise(resolve=>{const el=showDialog('Unsaved changes',`<p>“${esc(state.name)}” has unsaved changes. Save the project before replacing it, or discard the changes.</p>`,`${cancelButton}<button class="action-button danger" id="confirm-discard">Discard changes</button>`);$('#confirm-discard',el).onclick=()=>{closeDialog();resolve(true);};$$('[data-action="close-dialog"]',el).forEach(b=>b.addEventListener('click',()=>resolve(false)));});
}
function showNew(){showDialog('New project',`<div class="form-row"><label for="new-name">Project name</label><input type="text" id="new-name" value="Untitled" maxlength="120"></div><div class="form-row"><label for="new-model">Mesh</label><select id="new-model"><option value="helmet">Explorer helmet</option><option value="sphere">Material preview sphere</option><option value="cube">Calibration cube</option><option value="import">Select a mesh file…</option></select></div><div class="form-row"><label for="new-resolution">Document resolution</label><select id="new-resolution"><option>256</option><option>512</option><option selected>1024</option><option>2048</option></select></div><div class="form-row"><label>Normal map format</label><span>OpenGL (+Y)</span></div><div class="notice">Paint in 3D or directly in the UV view. Import OBJ, GLB, or self-contained glTF meshes with UV coordinates.</div>`,`${cancelButton}<button class="action-button primary" data-action="create-project">OK</button>`);}
async function createProject(){
  const name=$<HTMLInputElement>('#new-name').value.trim()||'Untitled',preset=$<HTMLSelectElement>('#new-model').value,resolution=Number($<HTMLSelectElement>('#new-resolution').value);
  closeDialog();if(!await confirmDiscard())return;
  if(preset==='import'){pendingNewProject={name,resolution};await pickFile('mesh');return;}
  try{await withBusy('Creating project…',async()=>{const candidate=new PainterEngine(resolution);modelInfo=viewport.loadDemo(preset as 'helmet'|'sphere'|'cube');if(preset!=='helmet'){candidate.setTextureSets(modelInfo.sets);for(const set of modelInfo.sets){candidate.setActiveSet(set.id);candidate.addLayer('paint');}candidate.setActiveSet(modelInfo.sets[0].id);}candidate.clearHistory();attachEngine(candidate);state.name=name;state.history=['Created project'];state.uvZoom=1;state.uvPan={x:0,y:0};state.tool='paint';setDirty(false);actionNumber++;refreshAll();});}catch(error){fail(error);}
}
function showExport(){showDialog('Export textures',`<div class="form-row"><label>Output template</label><select id="export-template"><option value="pbr">PBR Metallic Roughness</option><option value="urp">Unity Universal Render Pipeline</option><option value="hdrp">Unity High Definition Render Pipeline</option><option value="unreal">Unreal Engine · packed ORM</option></select></div><div class="form-row"><label>File type</label><span>PNG · 8 bits per channel · ZIP archive</span></div><div class="form-row"><label>Size</label><span>${engine.resolution} × ${engine.resolution} pixels</span></div><div class="form-row"><label>Normal format</label><select id="export-normal"><option value="opengl">OpenGL (+Y)</option><option value="directx">DirectX (−Y)</option></select></div><h3>Texture sets</h3><div class="export-checks">${engine.textureSets.map(set=>`<label><input type="checkbox" data-export-set="${esc(set.id)}" checked>${esc(set.name)}</label>`).join('')}</div><h3>Output maps <span style="font-size:10px;font-weight:400;color:#888">(PBR template)</span></h3><div class="export-checks">${CHANNELS.map(c=>`<label><input type="checkbox" data-export-channel="${c}" checked>${CH_LABELS[c]}</label>`).join('')}</div><div class="notice">Normal is derived from painted height. Ambient occlusion is not baked: packed engine presets use white AO. Unreal exports use DirectX normals.</div>`,`${cancelButton}<button class="action-button primary" data-action="export-confirm">Export</button>`);}
function showSettings(){showDialog('Project configuration',`<div class="form-row"><label>Project name</label><input id="project-name-input" type="text" value="${esc(state.name)}" maxlength="120"></div><div class="form-row"><label>Texture resolution</label><select id="project-resolution">${[256,512,1024,2048].map(n=>`<option ${n===engine.resolution?'selected':''}>${n}</option>`).join('')}</select></div><div class="form-row"><label>Normal map</label><span>OpenGL (DirectX conversion on export)</span></div><div class="form-row"><label>Shader</label><span>PBR Metallic Roughness</span></div><div class="notice">Changing resolution resamples painted maps; increasing it cannot restore detail lost by downsampling. The operation can be undone.</div>`,`${cancelButton}<button class="action-button primary" data-action="settings-confirm">OK</button>`);}
function showShortcuts(){showDialog('Keyboard shortcuts',`<table class="shortcut-table">${[['Paint / Eraser / Polygon Fill','1 / 2 / 4'],['Material picker','P'],['Orbit camera','Alt + left drag'],['Pan camera','Middle / right drag'],['Zoom','Scroll'],['Frame model / reset 2D view','F'],['3D + 2D / 3D / 2D','F1 / F2 / F3'],['Swap 3D and 2D','F4'],['Brush size','[ / ]'],['Mirror symmetry (texture U)','L'],['Toggle wireframe','W'],['Cycle display channel','C'],['Swap mask black / white','X'],['Undo / redo','Ctrl+Z / Ctrl+Y'],['New / Open / Save','Ctrl+N / Ctrl+O / Ctrl+S'],['Import mesh','Ctrl+I'],['Export textures','Ctrl+Shift+E'],['Duplicate layer / delete layer','Ctrl+D / Delete'],['Hide panels','Tab']].map(([label,key])=>`<tr><td>${label}</td><td>${key}</td></tr>`).join('')}</table>`,`<button class="action-button primary" data-action="close-dialog">Close</button>`);}
function showAbout(){showDialog('About PrimePainter',`<h3>PrimePainter <span style="color:#888">0.1.1</span></h3><p>A local PBR texture painting editor, built around the layout and workflows of Substance 3D Painter 12.2.0 (21 October 2026). This is an independent implementation.</p><h3>Working in this version</h3><ul class="capability-list"><li>3D and 2D painting, PBR channels, pressure, eraser and polygon fill.</li><li>Paint / fill layers, masks, blend modes, procedural materials, undo / redo.</li><li>OBJ / GLB / glTF import, .prime project saving, recovery copy, PNG texture export.</li><li>Unity URP / HDRP and Unreal packed texture exports.</li></ul><h3>Scope still to implement</h3><p>Substance .spp / .sbsar, FBX / USD, UDIM, high-to-low mesh baking, cage / skew painting, ribbon / particles / clone / smudge, anchors / filters / layer groups, Iray and full OpenPBR / transparency.</p><div class="notice">This version uses 8-bit raster channels at up to 2048². Its material library and demo meshes are original procedural assets. It does not include Adobe code or assets.</div>`,`<button class="action-button primary" data-action="close-dialog">Close</button>`,true);}

type MenuItem={label:string;action:string;icon?:string;key?:string;disabled?:boolean}|null;
function closeMenu(){menuElement?.remove();menuElement=null;$$('.menu-trigger').forEach(el=>el.classList.remove('open'));}
function popup(items:MenuItem[],x:number,y:number){
  closeMenu();const el=document.createElement('div');el.className='dropdown';el.setAttribute('role','menu');
  el.innerHTML=items.map(item=>item?`<button role="menuitem" data-action="${item.action}" ${item.disabled?'disabled':''}>${item.icon?i(item.icon):'<span style="width:13px"></span>'}<span>${item.label}</span>${item.key?`<span class="key">${item.key}</span>`:''}</button>`:'<div class="divider"></div>').join('');document.body.append(el);el.style.left=`${Math.min(x,innerWidth-el.offsetWidth-6)}px`;el.style.top=`${Math.min(y,innerHeight-el.offsetHeight-6)}px`;menuElement=el;
}
function showMenu(name:string,trigger:HTMLElement){
  const menus:Record<string,MenuItem[]>={
    File:[{label:'New…',action:'new',icon:'FilePlus2',key:'Ctrl+N'},{label:'Open…',action:'open',icon:'FolderOpen',key:'Ctrl+O'},null,{label:'Save project…',action:'save',icon:'Save',key:'Ctrl+S'},null,{label:'Import mesh…',action:'import-mesh',icon:'FileBox',key:'Ctrl+I'},{label:'Import resources…',action:'import-texture',icon:'Image'},null,{label:'Export textures…',action:'export',icon:'Download',key:'Ctrl+Shift+E'},{label:'Export viewport…',action:'screenshot',icon:'Camera'},null,{label:'Project configuration…',action:'project-settings',icon:'Settings2'}],
    Edit:[{label:'Undo',action:'undo',icon:'Undo2',key:'Ctrl+Z',disabled:!engine.canUndo},{label:'Redo',action:'redo',icon:'Redo2',key:'Ctrl+Y',disabled:!engine.canRedo},null,{label:'Add paint layer',action:'add-paint',icon:'Paintbrush'},{label:'Add fill layer',action:'add-fill',icon:'PaintBucket'},{label:'Duplicate layer',action:'duplicate',icon:'Copy',key:'Ctrl+D'},{label:'Rename layer…',action:'rename-layer'},{label:'Delete layer',action:'delete',icon:'Trash2',key:'Delete',disabled:engine.activeSet.layers.length<=1}],
    Mode:[{label:`${state.tool==='paint'?'✓ ':''}Paint`,action:'tool-paint',icon:'Paintbrush',key:'1'},{label:`${state.tool==='erase'?'✓ ':''}Eraser`,action:'tool-erase',icon:'Eraser',key:'2'},{label:`${state.tool==='fill'?'✓ ':''}Polygon fill`,action:'tool-fill',icon:'PaintBucket',key:'4'},{label:'Material picker',action:'tool-pick',icon:'Pipette',key:'P'}],
    View:[{label:'3D / 2D',action:'layout-split',icon:'Columns2',key:'F1'},{label:'3D only',action:'layout-3d',icon:'Box',key:'F2'},{label:'2D only',action:'layout-2d',icon:'Square',key:'F3'},{label:'Swap 3D / 2D',action:'swap',icon:'ArrowLeftRight',key:'F4'},null,{label:'Frame model',action:'frame',icon:'Focus',key:'F'},{label:`${state.wireframe?'✓ ':''}Wireframe`,action:'wireframe',icon:'Grid2X2',key:'W'},{label:`${state.uvWireframe?'✓ ':''}UV wireframe`,action:'uv-wireframe',icon:'ScanLine'},null,{label:'Display settings',action:'display',icon:'Sun'}],
    Window:[{label:'Assets',action:'toggle-assets',icon:'PanelLeft'},{label:'Texture sets / Layers / Properties',action:'toggle-right',icon:'PanelRight'},{label:'Display settings',action:'display',icon:'Sun'},{label:'Shader settings',action:'shader',icon:'SlidersHorizontal'},{label:'History',action:'history',icon:'History'},null,{label:'Reset layout',action:'reset-layout',icon:'RotateCcw'}],
    Help:[{label:'Keyboard shortcuts',action:'shortcuts',icon:'CircleHelp'},{label:'Tool help',action:'properties-info',icon:'Info'},null,{label:'About PrimePainter / feature coverage',action:'about',icon:'FileBox'}],
  };
  if(!menus[name])return;const rect=trigger.getBoundingClientRect();popup(menus[name],rect.left,rect.bottom);trigger.classList.add('open');
}
function showLayerMenu(x?:number,y?:number){
  const layer=engine.activeLayer,rect=$('.layer-panel').getBoundingClientRect();
  popup([{label:'Add paint layer',action:'add-paint',icon:'Paintbrush'},{label:'Add fill layer',action:'add-fill',icon:'PaintBucket'},null,{label:'Duplicate layer',action:'duplicate',icon:'Copy',key:'Ctrl+D'},{label:'Rename layer…',action:'rename-layer'},{label:'Merge down',action:'merge-down',icon:'Layers',disabled:engine.activeSet.layers.indexOf(layer)===0},{label:'Clear paint',action:'clear-layer',icon:'Eraser',disabled:layer.type!=='paint'},null,{label:'Add white mask',action:'add-mask',icon:'SquareDashed'},{label:'Add black mask',action:'add-black-mask',icon:'Square'},{label:'Invert mask',action:'invert-mask',disabled:!layer.mask},{label:'Remove mask',action:'remove-mask',disabled:!layer.mask},null,{label:'Move up',action:'move-up',icon:'ArrowUp'},{label:'Move down',action:'move-down',icon:'ArrowDown'},{label:'Delete layer',action:'delete',icon:'Trash2',key:'Delete',disabled:engine.activeSet.layers.length<=1}],x??rect.right-235,y??rect.top+30);
}
function renameLayer(){showDialog('Rename layer',`<input type="text" id="rename-layer-input" value="${esc(engine.activeLayer.name)}" maxlength="120" aria-label="Layer name">`,`${cancelButton}<button class="action-button primary" data-action="rename-confirm">OK</button>`);$<HTMLInputElement>('#rename-layer-input').select();}
function showPopover(kind:'display'|'history'|'shader'){
  const existing=$('.popover-panel');if(existing?.dataset.kind===kind){existing.remove();return;}existing?.remove();
  const el=document.createElement('div');el.className='popover-panel';el.dataset.kind=kind;
  const title=kind==='display'?'Display Settings':kind==='shader'?'Shader Settings':'History';let body='';
  if(kind==='display')body=sectionTitle('Environment settings')+`<div class="setting-row"><label>Environment</label><span>Studio softbox</span></div><div class="setting-row"><label>Rotation</label><input type="range" id="display-rotation" min="0" max="360" value="${state.environment}" aria-label="Environment rotation"></div>`+sectionTitle('Camera settings')+`<div class="setting-row"><label>Field of view</label><input type="range" id="display-fov" min="20" max="70" value="${viewport.camera.fov}" aria-label="Camera field of view"></div>`+sectionTitle('Post effects')+`<div class="setting-row"><label>Exposure</label><input type="range" id="display-exposure" min="0.2" max="3" step=".05" value="${state.exposure}" aria-label="Exposure"></div>`+sectionTitle('Visualization settings')+`<div class="setting-row"><label for="display-grid">Ground grid</label><input type="checkbox" id="display-grid" ${state.grid?'checked':''}></div><div class="setting-row"><label for="display-wireframe">Mesh wireframe</label><input type="checkbox" id="display-wireframe" ${state.wireframe?'checked':''}></div><div class="setting-row"><label>Background color</label><input type="color" id="display-background" value="${state.background}"></div>`;
  if(kind==='shader')body=`<div class="setting-row"><label>Shader</label><span>PBR Metallic Roughness</span></div><div class="setting-row"><label>Display channel</label><select id="shader-channel">${Object.entries(CH_LABELS).map(([id,label])=>`<option value="${id}" ${state.channel===id?'selected':''}>${label}</option>`).join('')}</select></div><div class="setting-row"><label>Normal convention</label><span>OpenGL (+Y)</span></div><div class="properties-note" style="padding:9px 0">Base color is sampled in sRGB. Roughness, metallic, height and normal are linear data. Normal is derived from height; material preview uses image based studio lighting.</div>`;
  if(kind==='history')body=`<div class="history-list">${state.history.map(label=>`<div class="history-entry">${i('History')}${esc(label)}</div>`).join('')}</div><div style="display:flex;gap:6px;padding:9px 0 0"><button class="action-button" data-action="undo" ${engine.canUndo?'':'disabled'}>Undo</button><button class="action-button" data-action="redo" ${engine.canRedo?'':'disabled'}>Redo</button></div><div class="properties-note" style="padding:7px 0 0">Session activity. Raster undo history retains up to 16 actions within its memory budget.</div>`;
  el.innerHTML=`<header class="panel-header">${title}<button class="icon-button" data-action="close-popover" aria-label="Close panel">${i('X')}</button></header><div class="popover-body">${body}</div>`;$('.center-panel').append(el);
}

const actions:Record<string,()=>unknown>={
  new:showNew,open:()=>pickFile('project'),save:saveProject,export:showExport,'export-confirm':exportTextures,
  'import-mesh':()=>pickFile('mesh'),'import-texture':()=>pickFile('texture'),
  undo:()=>perform('Undo',()=>engine.undo()),redo:()=>perform('Redo',()=>engine.redo()),
  'add-paint':()=>perform('Added paint layer',()=>{engine.brush.mask=false;engine.addLayer('paint');}),
  'add-fill':()=>perform('Added fill layer',()=>{engine.brush.mask=false;engine.addLayer('fill',state.selectedMaterial||'enamel');}),
  duplicate:()=>perform('Duplicated layer',()=>engine.duplicateLayer(engine.activeLayerId)),
  delete:()=>perform('Deleted layer',()=>engine.deleteLayer(engine.activeLayerId)),
  'move-up':()=>perform('Moved layer up',()=>engine.moveLayer(engine.activeLayerId,1)),
  'move-down':()=>perform('Moved layer down',()=>engine.moveLayer(engine.activeLayerId,-1)),
  mask:()=>actions['add-mask'](),'add-mask':()=>perform('Added white mask',()=>{engine.addMask(engine.activeLayerId);engine.brush.mask=true;}),
  'add-black-mask':()=>perform('Added black mask',()=>{engine.addMask(engine.activeLayerId,'black');engine.brush.mask=true;}),
  'remove-mask':()=>perform('Removed mask',()=>{engine.removeMask(engine.activeLayerId);engine.brush.mask=false;}),
  'invert-mask':()=>perform('Inverted mask',()=>engine.invertMask(engine.activeLayerId)),
  'clear-layer':()=>perform('Cleared paint layer',()=>engine.clearLayer(engine.activeLayerId)),
  'merge-down':()=>perform('Merged layer down',()=>engine.mergeDown(engine.activeLayerId)),
  'rename-layer':renameLayer,'rename-confirm':()=>{const name=$<HTMLInputElement>('#rename-layer-input').value.trim();if(!name)return;perform('Renamed layer',()=>engine.updateLayer(engine.activeLayerId,{name}));closeDialog();},
  'layer-menu':()=>showLayerMenu(),'asset-menu':()=>{const rect=$('.asset-footer').getBoundingClientRect();popup([{label:'Import texture…',action:'import-texture',icon:'Upload'},{label:'Materials',action:'assets-materials',icon:'Circle'},{label:'Brushes',action:'assets-brushes',icon:'Paintbrush'},{label:'Reset asset search',action:'assets-reset',icon:'RotateCcw'}],rect.left,rect.bottom-180);},
  'assets-materials':()=>{state.category='all';renderAssets();},'assets-brushes':()=>{state.category='brushes';renderAssets();},'assets-reset':()=>{state.search='';state.category='all';$<HTMLInputElement>('#asset-search').value='';renderAssets();},
  'tool-paint':()=>setTool('paint'),'tool-erase':()=>setTool('erase'),'tool-fill':()=>setTool('fill'),'tool-pick':()=>setTool('pick'),
  symmetry:()=>{engine.brush.symmetry=!engine.brush.symmetry;syncToolbar();renderProperties();status(`Mirror symmetry ${engine.brush.symmetry?'enabled':'disabled'} (texture U).`);},
  wireframe:()=>{state.wireframe=!state.wireframe;viewport.setWireframe(state.wireframe);$$('[data-action="wireframe"]').forEach(el=>el.classList.toggle('active',state.wireframe));},
  'uv-wireframe':()=>{state.uvWireframe=!state.uvWireframe;drawUV();},
  frame:()=>{viewport.frame();state.uvZoom=1;state.uvPan={x:0,y:0};drawUV();},
  'layout-split':()=>setLayout('split'),'layout-3d':()=>setLayout('3d'),'layout-2d':()=>setLayout('2d'),swap:()=>{state.swapped=!state.swapped;setLayout(state.layout);},
  'toggle-assets':()=>{$('.application').classList.toggle('asset-hidden');requestAnimationFrame(drawUV);},
  'toggle-right':()=>{$('.application').classList.toggle('right-hidden');requestAnimationFrame(drawUV);},
  'reset-layout':()=>{const app=$('.application');app.classList.remove('asset-hidden','right-hidden');document.documentElement.style.removeProperty('--asset-width');document.documentElement.style.removeProperty('--right-width');state.swapped=false;setLayout('split');actions.frame();},
  'reset-brush':()=>{Object.assign(engine.brush,{size:42,flow:1,hardness:.75,spacing:.16});syncToolbar();renderProperties();},
  color:()=>$<HTMLInputElement>('#quick-color').click(),'mask-invert-color':()=>{engine.brush.color=engine.brush.color==='#ffffff'?'#000000':'#ffffff';syncToolbar();renderProperties();},
  'project-settings':showSettings,'settings-confirm':()=>{const name=$<HTMLInputElement>('#project-name-input').value.trim()||'Untitled',size=Number($<HTMLSelectElement>('#project-resolution').value);try{engine.resize(size);state.name=name;perform('Updated project configuration',()=>{});closeDialog();refreshAll();}catch(error){fail(error);}},
  'create-project':createProject,'close-dialog':closeDialog,'close-popover':()=>$('.popover-panel')?.remove(),
  shortcuts:showShortcuts,about:showAbout,display:()=>showPopover('display'),shader:()=>showPopover('shader'),history:()=>showPopover('history'),
  'properties-info':()=>showDialog('Painting workflow',`<h3>Paint on the model</h3><p>Select the matching Texture Set, then a Paint layer. Drag with the left mouse button in 3D or 2D. Hold Alt to orbit; use the scroll wheel to zoom.</p><h3>Materials and masks</h3><p>Double-click a material asset to add it as a fill layer. Fill layers use UV projection and cannot receive brush strokes. Add a white or black mask to reveal or hide their material with paint.</p><h3>Polygon fill</h3><p>Select the Polygon Fill tool and choose Triangle, UV island, Mesh element or Texture set. Click a visible part of the 3D model to fill its corresponding UV polygons.</p><h3>Save and export</h3><p>Save an editable .prime project with Ctrl+S. Export PNG maps with Ctrl+Shift+E. A recovery copy is kept locally after edits.</p>`,`<button class="action-button primary" data-action="close-dialog">Close</button>`),
  screenshot:async()=>{try{const data=viewport.screenshot();const bytes=Uint8Array.from(atob(data.split(',')[1]),c=>c.charCodeAt(0));if(await saveOutput(`${safeFilename(state.name)}_viewport.png`,bytes,'image/png'))toast('Viewport image exported.');}catch(error){fail(error);}},
  'window-min':()=>window.primeDesktop?.minimize(),'window-max':()=>window.primeDesktop?.maximize(),'window-close':()=>window.primeDesktop?.close(),
};
document.addEventListener('click',event=>{
  const target=event.target as HTMLElement;
  const menu=target.closest<HTMLElement>('[data-menu]');if(menu){if(menu.classList.contains('open'))closeMenu();else showMenu(menu.dataset.menu!,menu);return;}
  const action=target.closest<HTMLElement>('[data-action]');if(action){const name=action.dataset.action!;closeMenu();if(!(action instanceof HTMLButtonElement&&action.disabled)){try{const result=actions[name]?.();if(result instanceof Promise)result.catch(fail);}catch(error){fail(error);}}return;}
  if(!target.closest('.dropdown'))closeMenu();
  const category=target.closest<HTMLElement>('[data-category]');if(category){state.category=category.dataset.category!;renderAssets();return;}
  const material=target.closest<HTMLElement>('[data-material]');if(material){state.selectedMaterial=material.dataset.material!;$$('[data-material]').forEach(el=>el.classList.toggle('selected',el===material));status(`${MATERIALS.find(m=>m.id===state.selectedMaterial)?.name} · double-click or drag onto the model to add a fill layer.`);return;}
  const preset=target.closest<HTMLElement>('[data-brush-preset]');if(preset){applyBrush(preset.dataset.brushPreset!);return;}
  const texture=target.closest<HTMLElement>('[data-texture-asset]');if(texture){const a=importedAssets[Number(texture.dataset.textureAsset)];perform('Added imported texture',()=>engine.addImageLayer(a.canvas,a.name));return;}
  const set=target.closest<HTMLElement>('[data-texture-set]');if(set){changeActiveSet(set.dataset.textureSet!);return;}
  const visibility=target.closest<HTMLElement>('[data-layer-visibility]');if(visibility){const layer=engine.activeSet.layers.find(l=>l.id===visibility.dataset.layerVisibility)!;perform(`${layer.visible?'Hid':'Showed'} ${layer.name}`,()=>engine.updateLayer(layer.id,{visible:!layer.visible}));return;}
  const mask=target.closest<HTMLElement>('[data-layer-mask]');if(mask){engine.setActiveLayer(mask.dataset.layerMask!);engine.brush.mask=true;engine.brush.color='#000000';renderProperties();renderLayers();syncToolbar();return;}
  const layer=target.closest<HTMLElement>('[data-layer]');if(layer){engine.brush.mask=false;engine.setActiveLayer(layer.dataset.layer!);renderLayers();renderProperties();return;}
  const channel=target.closest<HTMLElement>('[data-brush-channel]');if(channel){engine.brush.channel=channel.dataset.brushChannel as PaintChannel|'material';renderProperties();return;}
  const tab=target.closest<HTMLElement>('[data-property-tab]');if(tab){state.propertiesTab=tab.dataset.propertyTab!;renderProperties();return;}
  const setTab=target.closest<HTMLElement>('[data-set-tab]');if(setTab){state.activeSetTab=setTab.dataset.setTab!;$$('[data-set-tab]').forEach(el=>el.classList.toggle('active',el===setTab));renderSets();return;}
  const collapse=target.closest<HTMLElement>('[data-collapse]');if(collapse){let next=collapse.nextElementSibling;while(next&&!next.hasAttribute('data-collapse')){next.classList.toggle('hidden');next=next.nextElementSibling;}return;}
});
document.addEventListener('dblclick',event=>{const target=event.target as HTMLElement,material=target.closest<HTMLElement>('[data-material]'),layer=target.closest('[data-layer]');if(material)applyMaterial(material.dataset.material!);else if(layer)renameLayer();});
document.addEventListener('contextmenu',event=>{const layer=(event.target as HTMLElement).closest<HTMLElement>('[data-layer]');if(layer){event.preventDefault();engine.setActiveLayer(layer.dataset.layer!);showLayerMenu(event.clientX,event.clientY);}});
document.addEventListener('input',event=>{
  const el=event.target as HTMLInputElement;
  if(el.id==='asset-search'){state.search=el.value;renderAssets();return;}
  if(el.id==='asset-size'){state.assetScale=Number(el.value);renderAssets();return;}
  if(el.id==='property-color'||el.id==='quick-color'){if(engine.activeLayer.type!=='fill'||engine.brush.mask){engine.brush.color=el.value;syncToolbar();drawBrushPreview();}return;}
  if(el.dataset.property){const key=el.dataset.property as keyof typeof engine.brush,display=$(`[data-value="${key}"]`);if(display)display.textContent=Number(el.value).toFixed(key==='size'||['flow','hardness','spacing'].includes(key)?0:2);if(engine.activeLayer.type!=='fill'||engine.brush.mask){const value=Number(el.value);if(key==='size')engine.brush.size=value;else if(['flow','hardness','spacing'].includes(key))(engine.brush as unknown as Record<string,unknown>)[key]=value/100;else if(['roughness','metallic','height'].includes(key))(engine.brush as unknown as Record<string,unknown>)[key]=value;syncToolbar();drawBrushPreview();}return;}
  if(el.id.startsWith('toolbar-')){const key=el.id.slice(8),value=Number(el.value);if(!Number.isFinite(value))return;if(key==='size')engine.brush.size=Math.max(1,Math.min(500,value));else if(['flow','hardness','spacing'].includes(key))(engine.brush as unknown as Record<string,unknown>)[key]=Math.max(key==='hardness'?0:.025,Math.min(1,value/100));drawBrushPreview();return;}
  if(el.id==='display-rotation'){state.environment=Number(el.value);viewport.setEnvironmentRotation(state.environment*Math.PI/180);}
  if(el.id==='display-exposure'){state.exposure=Number(el.value);viewport.setExposure(state.exposure);}
  if(el.id==='display-fov'){viewport.camera.fov=Number(el.value);viewport.camera.updateProjectionMatrix();}
  if(el.id==='display-background'){state.background=el.value;viewport.setBackground(state.background);}
});
document.addEventListener('change',event=>{
  const el=event.target as HTMLInputElement;
  if(el.classList.contains('view-channel')||el.id==='shader-channel'){setChannel(el.value as ViewChannel);return;}
  if(el.classList.contains('camera-select')){viewport.setCameraView(el.value==='Default camera'?'default':el.value.toLowerCase() as 'front'|'back'|'left'|'right'|'top');return;}
  if(el.id==='asset-source'){state.category=el.value==='textures'?'textures':'all';renderAssets();return;}
  if(el.id==='set-resolution'){perform('Resized textures',()=>engine.resize(Number(el.value)));return;}
  if(el.id==='layer-opacity'){perform('Changed layer opacity',()=>engine.updateLayer(engine.activeLayerId,{opacity:Number(el.value)/100}));return;}
  if(el.id==='layer-blend'){perform('Changed blend mode',()=>engine.updateLayer(engine.activeLayerId,{blendMode:el.value as BlendMode}));return;}
  if(el.id==='fill-mode'){state.fillMode=el.value as typeof state.fillMode;return;}
  if(el.id==='layer-channel'){setChannel(el.value as ViewChannel);return;}
  if(el.id==='brush-symmetry'){engine.brush.symmetry=el.checked;syncToolbar();return;}
  if(el.id==='display-grid'){state.grid=el.checked;viewport.setGrid(state.grid);}
  if(el.id==='display-wireframe'){state.wireframe=el.checked;viewport.setWireframe(state.wireframe);}
  if(el.id==='property-color'&&engine.activeLayer.type==='fill'&&!engine.brush.mask)perform('Changed fill color',()=>engine.updateLayer(engine.activeLayerId,{color:el.value}));
  if(el.dataset.property&&engine.activeLayer.type==='fill'&&!engine.brush.mask){const key=el.dataset.property;if(['scale','roughness','metallic','height'].includes(key))perform(`Changed fill ${key}`,()=>engine.updateLayer(engine.activeLayerId,{[key]:Number(el.value)}));}
});

uvCanvas.addEventListener('pointerdown',event=>{
  if(event.button===1||event.button===2||event.altKey){event.preventDefault();uvPanning=true;uvPointer={x:event.clientX,y:event.clientY};uvCanvas.setPointerCapture(event.pointerId);return;}
  if(event.button!==0)return;const {u,v}=uvAt(event);if(u<0||v<0||u>1||v>1)return;uvCanvas.focus();event.preventDefault();
  if(state.tool==='pick'){sample(u,v);return;}if(!canPaint())return;
  if(state.tool==='fill'){const hit=viewport.pickUV(u,v,engine.activeTextureSetId);if(hit)paintStart(hit);return;}
  uvDrawing=true;painting=true;engine.beginStroke();engine.paint(u,v,event.pointerType==='pen'?event.pressure:1);uvCanvas.setPointerCapture(event.pointerId);
});
uvCanvas.addEventListener('pointermove',event=>{
  showCursor(event,true,uvBox.size/engine.resolution);
  if(uvPanning){state.uvPan.x+=event.clientX-uvPointer.x;state.uvPan.y+=event.clientY-uvPointer.y;uvPointer={x:event.clientX,y:event.clientY};drawUV();return;}
  if(!uvDrawing)return;const {u,v}=uvAt(event);if(u<0||v<0||u>1||v>1){engine.breakStroke();return;}engine.paint(u,v,event.pointerType==='pen'?event.pressure:1);
});
uvCanvas.addEventListener('pointerup',()=>{if(uvDrawing){uvDrawing=false;endPaint();}uvPanning=false;});
uvCanvas.addEventListener('pointercancel',()=>{uvDrawing=false;uvPanning=false;endPaint();});
uvCanvas.addEventListener('pointerleave',()=>{$('.brush-cursor').style.display='none';});uvCanvas.addEventListener('contextmenu',event=>event.preventDefault());
uvCanvas.addEventListener('wheel',event=>{event.preventDefault();state.uvZoom=Math.max(.2,Math.min(8,state.uvZoom*Math.exp(-event.deltaY*.001)));drawUV();},{passive:false});

function initResizer(selector:string,variable:string,min:number,max:number,reverse=false){
  const handle=$(selector);let start=0,initial=0;
  handle.addEventListener('pointerdown',event=>{start=event.clientX;initial=reverse?$('.right-panel').clientWidth:$('.assets-panel').clientWidth;handle.setPointerCapture(event.pointerId);handle.dataset.dragging='true';event.preventDefault();});
  handle.addEventListener('pointermove',event=>{if(handle.dataset.dragging!=='true')return;document.documentElement.style.setProperty(variable,`${Math.max(min,Math.min(max,initial+(event.clientX-start)*(reverse?-1:1)))}px`);drawUV();});
  handle.addEventListener('pointerup',()=>delete handle.dataset.dragging);handle.addEventListener('pointercancel',()=>delete handle.dataset.dragging);
  handle.addEventListener('keydown',event=>{if(event.key!=='ArrowLeft'&&event.key!=='ArrowRight')return;event.preventDefault();const current=reverse?$('.right-panel').clientWidth:$('.assets-panel').clientWidth;document.documentElement.style.setProperty(variable,`${Math.max(min,Math.min(max,current+(event.key==='ArrowRight'?10:-10)*(reverse?-1:1)))}px`);drawUV();});
}
initResizer('.asset-resizer','--asset-width',145,360);initResizer('.right-resizer','--right-width',245,440,true);
document.addEventListener('keydown',event=>{
  const dialog=$('.dialog-backdrop');
  if(dialog){if(event.key==='Escape'){event.preventDefault();$<HTMLButtonElement>('[data-action="close-dialog"]',dialog)?.click();}if(event.key==='Tab'){const focusable=$$<HTMLElement>('button:not([disabled]),input,select,[tabindex="0"]',dialog);if(focusable.length){const first=focusable[0],last=focusable[focusable.length-1];if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}}if(event.key==='Enter'&&!(event.target instanceof HTMLSelectElement)){$<HTMLButtonElement>('.dialog-footer .primary',dialog)?.click();event.preventDefault();}return;}
  const key=shortcutKey(event),el=event.target as HTMLElement;if(['INPUT','TEXTAREA','SELECT'].includes(el.tagName)||el.isContentEditable){if(!(event.ctrlKey||event.metaKey)||['z','y','a','c','v','x'].includes(key))return;}
  if(event.altKey)return;
  if(busy)return;
  const ctrl=event.ctrlKey||event.metaKey;let action:string|undefined;
  if(ctrl){action=({s:'save',o:'open',n:'new',i:'import-mesh',d:'duplicate',z:event.shiftKey?'redo':'undo',y:'redo',e:event.shiftKey?'export':undefined})[key];}
  else action=({'1':'tool-paint','2':'tool-erase','4':'tool-fill',p:'tool-pick',f:'frame',w:'wireframe',l:'symmetry',x:'mask-invert-color',f1:'layout-split',f2:'layout-3d',f3:'layout-2d',f4:'swap',delete:'delete'})[key];
  if(action){event.preventDefault();void actions[action]?.();return;}
  if(key==='escape'){closeMenu();$('.popover-panel')?.remove();}
  if(!ctrl&&(key==='['||key===']')){event.preventDefault();engine.brush.size=Math.max(1,Math.min(500,Math.round(engine.brush.size*(key==='['?.85:1.15))));syncToolbar();renderProperties();}
  if(!ctrl&&key==='c'){const keys=Object.keys(CH_LABELS) as ViewChannel[];setChannel(keys[(keys.indexOf(state.channel)+1)%keys.length]);}
  if(key==='tab'&&!ctrl&&(el.tagName==='CANVAS'||el===document.body)){event.preventDefault();const app=$('.application'),hidden=app.classList.contains('asset-hidden')&&app.classList.contains('right-hidden');app.classList.toggle('asset-hidden',!hidden);app.classList.toggle('right-hidden',!hidden);}
  if((key==='enter'||key===' ')&&el.dataset.layer){event.preventDefault();el.click();}
});
window.addEventListener('beforeunload',event=>{if(state.dirty&&!window.primeDesktop){event.preventDefault();event.returnValue='';}});

function refreshAll(){
  $('#document-name').textContent=state.name;$('#triangle-count').textContent=`${modelInfo.triangleCount.toLocaleString('en-US')} triangles`;syncTextures();renderSets();renderLayers();renderProperties();syncToolbar();drawUV();
}
async function importModel(file:File){
  const requested=pendingNewProject;pendingNewProject=null;
  if(!requested&&!await confirmDiscard())return;
  try{await withBusy('Importing model…',async()=>{
    const resolution=requested?.resolution??Math.min(engine.resolution,1024),candidate=new PainterEngine(256);
    const info=await viewport.importFile(file,sets=>{
      candidate.setTextureSets(sets);
      for(const set of sets){candidate.setActiveSet(set.id);if(set.color)candidate.updateLayer(candidate.activeLayerId,{color:set.color,roughness:set.roughness??.5,metallic:set.metallic??0});candidate.addLayer('paint');}
      candidate.clearHistory();candidate.resize(resolution);candidate.clearHistory();
    });
    candidate.setActiveSet(info.sets[0].id);candidate.clearHistory();attachEngine(candidate);modelInfo=info;state.name=requested?.name??info.name;state.history=['Imported mesh'];state.tool='paint';state.uvZoom=1;state.uvPan={x:0,y:0};setDirty();actionNumber++;refreshAll();scheduleAutosave();info.warnings.forEach(w=>toast(w,true));status(`Imported ${file.name}.`);
  });}catch(error){fail(error);}
}
async function importTexture(file:File){
  if(file.size>32*1024*1024)throw new Error('Texture image exceeds the 32 MB import limit.');
  const bitmap=await createImageBitmap(file);try{if(bitmap.width>8192||bitmap.height>8192)throw new Error('Texture dimensions exceed 8192 × 8192.');const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;canvas.getContext('2d')!.drawImage(bitmap,0,0);importedAssets.push({name:file.name,canvas});perform('Imported texture',()=>engine.addImageLayer(canvas,file.name));state.category='textures';renderAssets();}finally{bitmap.close();}
}
async function handleFile(file:File){const ext=file.name.split('.').pop()?.toLowerCase();if(ext==='prime'){if(!await confirmDiscard())return;if(file.size>220_000_000)throw new Error('Project exceeds the 220 MB file limit.');await withBusy('Opening project…',async()=>openProject(await file.text()));toast(`Opened ${file.name}.`);}else if(['obj','glb','gltf'].includes(ext||''))await importModel(file);else if(file.type.startsWith('image/'))await importTexture(file);else throw new Error('Supported files: .prime, .obj, .glb, .gltf, PNG, JPG and WebP.');}
async function pickFile(kind:'mesh'|'project'|'texture'){
  if(!window.primeDesktop){$<HTMLInputElement>(kind==='project'?'#open-project':kind==='mesh'?'#import-mesh':'#import-texture').click();return;}
  try{
    endPaint();
    const chosen=await withBusy('Choose a file…',()=>window.primeDesktop!.openFile(kind));
    if(!chosen)return;
    const bytes=new Uint8Array(chosen.data.byteLength);bytes.set(chosen.data);
    await handleFile(new File([bytes],chosen.name,{type:chosen.type}));
  }catch(error){fail(error);
  }finally{if(kind==='mesh')pendingNewProject=null;}
}
for(const id of ['open-project','import-mesh','import-texture'])$<HTMLInputElement>(`#${id}`).addEventListener('change',async event=>{const input=event.target as HTMLInputElement,file=input.files?.[0];if(!file)return;try{await handleFile(file);}catch(error){fail(error);}finally{input.value='';}});
$<HTMLInputElement>('#import-mesh').addEventListener('cancel',()=>{pendingNewProject=null;});
const center=$('.center-panel');let dragCount=0;
document.addEventListener('dragstart',event=>{const material=(event.target as HTMLElement).closest<HTMLElement>('[data-material]');if(material){event.dataTransfer?.setData('application/x-prime-material',material.dataset.material!);if(event.dataTransfer)event.dataTransfer.effectAllowed='copy';}});
center.addEventListener('dragenter',event=>{event.preventDefault();dragCount++;$('.drag-overlay').classList.add('visible');});
center.addEventListener('dragover',event=>{event.preventDefault();if(event.dataTransfer)event.dataTransfer.dropEffect='copy';});
center.addEventListener('dragleave',()=>{dragCount--;if(dragCount<=0){dragCount=0;$('.drag-overlay').classList.remove('visible');}});
center.addEventListener('drop',async event=>{event.preventDefault();dragCount=0;$('.drag-overlay').classList.remove('visible');const material=event.dataTransfer?.getData('application/x-prime-material');if(material){applyMaterial(material);return;}const file=event.dataTransfer?.files[0];if(file)try{await handleFile(file);}catch(error){fail(error);}});

try{
  viewport=new PainterViewport($('.viewport-3d'),{
    onPaintStart:paintStart,onPaint:paintMove,onPaintEnd:endPaint,
    onHover:hit=>{if(!hit){engine.breakStroke();lastHit=null;$('.brush-cursor').style.display='none';return;}const rect=$('.viewport-3d').getBoundingClientRect();showCursor({clientX:rect.left+hit.x,clientY:rect.top+hit.y},hit.setId===engine.activeTextureSetId,Math.max(.2,Math.min(1,$('.viewport-3d').clientWidth/engine.resolution)));},
  });
  viewport.renderer.domElement.classList.add('renderer');
  viewport.renderer.domElement.addEventListener('pointerleave',()=>{$('.brush-cursor').style.display='none';engine.breakStroke();lastHit=null;});
  modelInfo=viewport.loadDemo('helmet');attachEngine(engine);syncTextures();renderAssets();refreshAll();setDirty(false);
  window.__primePainter={engine,viewport,getProject,openProject,state};
  new ResizeObserver(drawUV).observe($('.viewport-2d'));
  setTimeout(()=>{$('#navigation-hint').style.opacity='0';setTimeout(()=>$('#navigation-hint').remove(),400);},14000);
  void readAutosave().then(saved=>{
    if(!saved||state.dirty||busy)return;
    const el=showDialog('Recover local project',`<p>A local recovery copy of “${esc(saved.name)}” is available.</p><p style="font-size:10px">${esc(new Date(saved.time).toLocaleString())}</p>`,`<button class="action-button" data-action="close-dialog">Start fresh</button><button class="action-button primary" id="restore-project">Recover</button>`);
    $('#restore-project',el).onclick=async()=>{closeDialog();try{await withBusy('Recovering project…',()=>openProject(saved.text));setDirty();toast('Recovered the local project. Save it as a .prime file.');}catch(error){fail(error);}};
  }).catch(()=>{$('#autosave-status').textContent='Recovery unavailable';});
}catch(error){fail(error);$('#status-message').textContent='The 3D renderer could not initialize. Check WebGL / GPU availability.';}
