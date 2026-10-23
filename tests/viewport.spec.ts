import { test, expect } from '@playwright/test';

// Load only the viewport module so these geometry regressions stay independent of application UI state.
test.beforeEach(async ({ page }) => { await page.goto('/src/viewport.ts'); });

test('all demo meshes have finite, separated UV atlas tiles for their three material sets', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { buildDemo } = await import('/src/demo-model.ts');
    const models = [];
    for (const preset of ['helmet', 'sphere', 'cube']) {
      const model = buildDemo(preset), tiles = new Map();
      let triangleCount = 0, validUV = true, overlaps = 0;
      model.traverse(mesh => {
        if (!mesh.isMesh) return;
        const uv = mesh.geometry.getAttribute('uv'), position = mesh.geometry.getAttribute('position');
        if (!uv || uv.count !== position.count) { validUV = false; return; }
        const bounds = [Infinity, Infinity, -Infinity, -Infinity];
        for (let i = 0; i < uv.count; i++) {
          const u = uv.getX(i), v = uv.getY(i);
          if (!Number.isFinite(u) || !Number.isFinite(v) || u < 0 || u > 1 || v < 0 || v > 1) validUV = false;
          bounds[0] = Math.min(bounds[0], u); bounds[1] = Math.min(bounds[1], v);
          bounds[2] = Math.max(bounds[2], u); bounds[3] = Math.max(bounds[3], v);
        }
        const id = mesh.userData.setIds[0];
        for (const other of tiles.get(id) ?? []) {
          if (!(bounds[2] <= other[0] || bounds[0] >= other[2] || bounds[3] <= other[1] || bounds[1] >= other[3])) overlaps++;
        }
        if (!tiles.has(id)) tiles.set(id, []);
        tiles.get(id).push(bounds);
        triangleCount += (mesh.geometry.index?.count ?? uv.count) / 3;
        mesh.geometry.dispose();
      });
      models.push({ preset, triangleCount, validUV, overlaps, sets: [...tiles.keys()].sort() });
    }
    return models;
  });
  for (const model of result) {
    expect(model.validUV, model.preset).toBe(true);
    expect(model.overlaps, model.preset).toBe(0);
    expect(model.sets).toEqual(['body', 'hardware', 'visor']);
    expect(model.triangleCount).toBeGreaterThan(1000);
  }
});

test('project model roundtrip retains the edited primitive UV coordinates and material groups', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { PainterViewport } = await import('/src/viewport.ts');
    document.body.innerHTML = '<div id="test-view" style="width:650px;height:750px"></div>';
    const viewport = new PainterViewport(document.getElementById('test-view'));
    try {
      const original = viewport.loadDemo('helmet');
      const before = Object.fromEntries(original.sets.map(set => [set.id, viewport.getUVTriangles(set.id)]));
      const serialized = JSON.stringify(viewport.serializeModel());
      const restored = viewport.restoreModel(JSON.parse(serialized));
      const after = Object.fromEntries(restored.sets.map(set => [set.id, viewport.getUVTriangles(set.id)]));
      return { sameUV: JSON.stringify(before) === JSON.stringify(after), originalTriangles: original.triangleCount, restoredTriangles: restored.triangleCount, sets: restored.sets.map(set => set.id).sort(), plainGeometry: JSON.parse(serialized).meshes.every(mesh => mesh.geometry.type === 'BufferGeometry' && mesh.geometry.data.attributes.uv) };
    } finally { viewport.dispose(); }
  });
  expect(result.sameUV).toBe(true);
  expect(result.restoredTriangles).toBe(result.originalTriangles);
  expect(result.sets).toEqual(['body', 'hardware', 'visor']);
  expect(result.plainGeometry).toBe(true);
});

test('malformed model replacement is rejected before the active project changes', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { PainterViewport } = await import('/src/viewport.ts');
    document.body.innerHTML = '<div id="test-view" style="width:650px;height:750px"></div>';
    const viewport = new PainterViewport(document.getElementById('test-view'));
    try {
      viewport.loadDemo('helmet');
      const before = JSON.stringify(viewport.serializeModel());
      const mutations = [
        data => { data.sets = []; },
        data => { data.meshes[0].sets = []; },
        data => { data.sets.push(data.sets[0]); },
        data => { data.meshes[0].geometry.data.attributes.position.array[0] = null; },
        data => { data.meshes[0].geometry.data.attributes.uv.itemSize = 3; },
        data => { data.meshes[0].matrix[0] = Infinity; },
        data => { data.meshes[0].geometry.data.index = { type: 'Uint32Array', array: [99999999, 0, 1] }; },
        data => { data.meshes[0].geometry.data.groups = [{ start: 0, count: 99999999, materialIndex: 0 }]; },
      ];
      let rejected = 0, preserved = true;
      for (const mutate of mutations) {
        const data = JSON.parse(before); mutate(data);
        try { viewport.restoreModel(data); } catch { rejected++; }
        if (JSON.stringify(viewport.serializeModel()) !== before) preserved = false;
      }
      return { rejected, total: mutations.length, preserved };
    } finally { viewport.dispose(); }
  });
  expect(result.rejected).toBe(result.total);
  expect(result.preserved).toBe(true);
});

test('model import can be rejected by its staged engine callback without losing the current model', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { PainterViewport } = await import('/src/viewport.ts');
    document.body.innerHTML = '<div id="test-view" style="width:650px;height:750px"></div>';
    const viewport = new PainterViewport(document.getElementById('test-view'));
    try {
      viewport.loadDemo('cube');
      const before = JSON.stringify(viewport.serializeModel());
      const content = 'v -1 -1 0\nv 1 -1 0\nv 0 1 0\nvt 0 0\nvt 1 0\nvt 0.5 1\nf 1/1 2/2 3/3\n';
      let stagedSets = 0, error = '';
      try {
        await viewport.importFile(new File([content], 'triangle.obj'), async sets => { stagedSets = sets.length; throw new Error('Staged engine rejected the import'); });
      } catch (failure) { error = failure.message; }
      const preserved = before === JSON.stringify(viewport.serializeModel());
      const imported = await viewport.importFile(new File([content], 'triangle.obj'));
      const hit = viewport.pickUV(.5, .3, imported.sets[0].id);
      return { stagedSets, error, preserved, triangles: imported.triangleCount, hit: !!hit };
    } finally { viewport.dispose(); }
  });
  expect(result.stagedSets).toBe(1);
  expect(result.error).toContain('Staged engine rejected');
  expect(result.preserved).toBe(true);
  expect(result.triangles).toBe(1);
  expect(result.hit).toBe(true);
});

test('2D UV picking selects the same face, mesh and connected island used by 3D polygon fill', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { PainterViewport } = await import('/src/viewport.ts');
    document.body.innerHTML = '<div id="test-view" style="width:650px;height:750px"></div>';
    const viewport = new PainterViewport(document.getElementById('test-view'));
    try {
      viewport.loadDemo('cube'); viewport.setActiveSet('body');
      const triangle = viewport.getUVTriangles('body').find(t => Math.abs((t[2] - t[0]) * (t[5] - t[1]) - (t[4] - t[0]) * (t[3] - t[1])) > 1e-7);
      const u = (triangle[0] + triangle[2] + triangle[4]) / 3, v = (triangle[1] + triangle[3] + triangle[5]) / 3;
      const hit = viewport.pickUV(u, v);
      if (!hit) return { picked: false };
      const island = viewport.getUVIslandTriangles(hit), mesh = viewport.getUVTriangles(hit.setId, hit.meshId);
      return { picked: true, setId: hit.setId, triangle: hit.triangleUV.flatMap(uv => [uv.x, uv.y]), expected: triangle, face: hit.faceIndex, islandId: hit.islandId, islandCount: island.length, meshCount: mesh.length, cached: viewport.getUVIslandTriangles(hit) === island, empty: viewport.pickUV(.999, .999, 'body') === null, invalid: viewport.pickUV(NaN, .5) === null && viewport.pickUV(-.1, .5) === null };
    } finally { viewport.dispose(); }
  });
  expect(result.picked).toBe(true);
  expect(result.setId).toBe('body');
  expect(result.triangle).toEqual(result.expected);
  expect(result.face).toBeGreaterThanOrEqual(0);
  expect(result.islandId).toBeTruthy();
  expect(result.islandCount).toBe(50);
  expect(result.meshCount).toBe(300);
  expect(result.cached).toBe(true);
  expect(result.empty).toBe(true);
  expect(result.invalid).toBe(true);
});

test('reused canvas textures retain their material and upload only the changed PBR channels', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { PainterViewport } = await import('/src/viewport.ts');
    document.body.innerHTML = '<div id="test-view" style="width:500px;height:500px"></div>';
    const viewport = new PainterViewport(document.getElementById('test-view'));
    try {
      viewport.loadDemo('helmet');
      const maps = {};
      for (const channel of ['baseColor', 'roughness', 'metallic', 'normal', 'height']) {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
        const context = canvas.getContext('2d'); context.fillStyle = channel === 'baseColor' ? '#a98a45' : channel === 'normal' ? '#8080ff' : '#808080'; context.fillRect(0, 0, 64, 64);
        maps[channel] = canvas;
      }
      viewport.setTextureSet('body', maps);
      let material;
      viewport.scene.traverse(object => {
        if (!object.isMesh) return;
        for (const candidate of Array.isArray(object.material) ? object.material : [object.material]) if (candidate.userData.defaults?.id === 'body') material = candidate;
      });
      const before = viewport.screenshot(), version = material.version;
      const versions = { color: material.map.version, roughness: material.roughnessMap.version, normal: material.normalMap.version, metallic: material.metalnessMap.version, height: material.bumpMap.version };
      for (let i = 0; i < 10; i++) viewport.setTextureSet('body', maps, ['baseColor']);
      const sameImage = before === viewport.screenshot();
      const changes = { color: material.map.version - versions.color, roughness: material.roughnessMap.version - versions.roughness, normal: material.normalMap.version - versions.normal, metallic: material.metalnessMap.version - versions.metallic, height: material.bumpMap.version - versions.height };
      const sameMaterial = material.version === version;
      viewport.setChannel('roughness');
      const roughnessBefore = viewport.screenshot(), displayVersion = material.emissiveMap.version;
      viewport.setTextureSet('body', maps, ['baseColor']);
      const unchangedDisplay = roughnessBefore === viewport.screenshot() && displayVersion === material.emissiveMap.version;
      const context = maps.roughness.getContext('2d'); context.fillStyle = '#eeeeee'; context.fillRect(0, 0, 64, 64);
      viewport.setTextureSet('body', maps, ['roughness']);
      return { sameImage, sameMaterial, changes, unchangedDisplay, roughnessChanged: roughnessBefore !== viewport.screenshot() };
    } finally { viewport.dispose(); }
  });
  expect(result.sameImage).toBe(true);
  expect(result.sameMaterial).toBe(true);
  expect(result.changes).toEqual({ color: 10, roughness: 0, normal: 0, metallic: 0, height: 0 });
  expect(result.unchangedDisplay).toBe(true);
  expect(result.roughnessChanged).toBe(true);
});

test('UV overlay reuses the visible raster and preserves wireframe pixels at zoom and fractional pan', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { PainterViewport } = await import('/src/viewport.ts');
    document.body.innerHTML = '<div id="test-view" style="width:500px;height:500px"></div>';
    const viewport = new PainterViewport(document.getElementById('test-view'));
    try {
      viewport.loadDemo('helmet');
      const expected = document.createElement('canvas'), actual = document.createElement('canvas');
      expected.width = actual.width = 650; expected.height = actual.height = 500;
      const reference = expected.getContext('2d'), context = actual.getContext('2d');
      reference.setTransform(1.5, 0, 0, 1.5, -165.25, -120.5); context.setTransform(1.5, 0, 0, 1.5, -165.25, -120.5);
      reference.strokeStyle = 'rgba(220,226,230,.28)'; reference.lineWidth = .6; reference.beginPath();
      for (const uv of viewport.getUVTriangles('body')) {
        reference.moveTo(uv[0] * 650, (1 - uv[1]) * 650); reference.lineTo(uv[2] * 650, (1 - uv[3]) * 650); reference.lineTo(uv[4] * 650, (1 - uv[5]) * 650); reference.closePath();
      }
      reference.stroke();
      let topologyReads = 0;
      const getTriangles = viewport.getUVTriangles.bind(viewport);
      viewport.getUVTriangles = (...args) => { topologyReads++; return getTriangles(...args); };
      viewport.drawUV(context, 'body', 650, 650);
      const pixels = context.getImageData(0, 0, 650, 500).data, target = reference.getImageData(0, 0, 650, 500).data;
      let difference = 0;
      for (let i = 0; i < pixels.length; i++) difference += Math.abs(pixels[i] - target[i]);
      const overlay = viewport.uvOverlays.get('body');
      const clear = () => { context.save(); context.setTransform(1, 0, 0, 1, 0, 0); context.clearRect(0, 0, 650, 500); context.restore(); };
      clear(); viewport.drawUV(context, 'body', 650, 650);
      const sameRaster = overlay === viewport.uvOverlays.get('body');
      clear(); viewport.drawUV(context, 'body', 8000, 8000);
      const huge = viewport.uvOverlays.get('body').canvas;
      viewport.loadDemo('cube'); clear(); viewport.drawUV(context, 'body', 650, 650);
      return { averageDifference: difference / pixels.length, sameRaster, topologyReads, overlayWidth: huge.width, overlayHeight: huge.height };
    } finally { viewport.dispose(); }
  });
  expect(result.averageDifference).toBeLessThan(0.1);
  expect(result.sameRaster).toBe(true);
  expect(result.topologyReads).toBe(2);
  expect(result.overlayWidth).toBeLessThanOrEqual(650);
  expect(result.overlayHeight).toBeLessThanOrEqual(500);
});
