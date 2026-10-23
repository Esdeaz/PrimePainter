import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => { await page.goto('/'); });

test('PBR layer compositing respects opacity, masks, visibility and undo', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { PainterEngine } = await import('/src/engine.ts');
    const e = new PainterEngine(256);
    e.setTextureSets([{ id: 'body', name: 'Body' }]);
    const lower = e.activeLayer;
    e.updateLayer(lower.id, { materialId: 'visor', color: '#204060', roughness: .4, metallic: .2, height: .5 });
    const pixel = (channel = 'baseColor') => Array.from(e.getChannels()[channel].getContext('2d').getImageData(128, 128, 1, 1).data);
    const base = pixel(), roughness = pixel('roughness'), metallic = pixel('metallic');
    const upper = e.addLayer('fill', 'visor');
    e.updateLayer(upper.id, { color: '#ff0000', opacity: .5 });
    const blended = pixel();
    e.addMask(upper.id, 'black'); const masked = pixel();
    e.undo(); const undone = pixel();
    e.redo(); const redone = pixel();
    e.removeMask(upper.id); e.updateLayer(upper.id, { visible: false }); const hidden = pixel();
    e.updateLayer(upper.id, { visible: true, color: '#808080', opacity: 1, blendMode: 'multiply' }); const multiplied = pixel();
    return { base, roughness, metallic, blended, masked, undone, redone, hidden, multiplied };
  });
  expect(result.base).toEqual([32, 64, 96, 255]);
  expect(result.roughness).toEqual([102, 102, 102, 255]);
  expect(result.metallic).toEqual([51, 51, 51, 255]);
  expect(Math.abs(result.blended[0] - 144)).toBeLessThanOrEqual(1);
  expect(Math.abs(result.blended[1] - 32)).toBeLessThanOrEqual(1);
  expect(result.masked).toEqual(result.base);
  expect(result.undone).toEqual(result.blended);
  expect(result.redone).toEqual(result.base);
  expect(result.hidden).toEqual(result.base);
  expect(result.multiplied).toEqual([16, 32, 48, 255]);
});

test('pressure strokes paint all PBR maps, symmetry mirrors, erasing and history restore pixels', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { PainterEngine } = await import('/src/engine.ts');
    const e = new PainterEngine(256); e.setTextureSets([{ id: 'body', name: 'Body' }]);
    e.updateLayer(e.activeLayerId, { materialId: 'visor', color: '#204060', height: .5 });
    e.addLayer('paint');
    Object.assign(e.brush, { color: '#ff0000', size: 40, hardness: 1, flow: 1, channel: 'material', roughness: .8, metallic: .9, height: .85, symmetry: true });
    const pixel = (u: number, v: number, channel = 'baseColor') => Array.from(e.getChannels()[channel].getContext('2d').getImageData(Math.floor(u * 256), Math.floor((1 - v) * 256), 1, 1).data);
    const before = pixel(.25, .5);
    e.beginStroke(); e.paint(.25, .5, 1); e.endStroke();
    const left = pixel(.25, .5), right = pixel(.75, .5), rough = pixel(.25, .5, 'roughness'), metal = pixel(.25, .5, 'metallic'), height = pixel(.25, .5, 'height');
    const normal = pixel((64 + 19) / 256, .5, 'normal');
    e.undo(); const undone = pixel(.25, .5); e.redo(); const redone = pixel(.25, .5);
    e.brush.erase = true; e.beginStroke(); e.paint(.25, .5, 1); e.endStroke(); const erased = pixel(.25, .5);
    e.undo(); const eraseUndone = pixel(.25, .5);
    e.brush.erase = false; e.brush.symmetry = false;
    e.beginStroke(); e.paint(.5, .8, .3); e.endStroke(); const pressure = pixel(.5, .8);
    return { before, left, right, rough, metal, height, normal, undone, redone, erased, eraseUndone, pressure };
  });
  expect(result.left).toEqual([255, 0, 0, 255]);
  expect(result.right).toEqual(result.left);
  expect(result.rough[0]).toBe(204);
  expect(result.metal[0]).toBe(230);
  expect(result.height[0]).toBe(217);
  expect(result.normal[0]).not.toBe(128);
  expect(result.undone).toEqual(result.before);
  expect(result.redone).toEqual(result.left);
  expect(result.erased).toEqual(result.before);
  expect(result.eraseUndone).toEqual(result.left);
  expect(result.pressure[0]).toBeGreaterThan(result.before[0]);
  expect(result.pressure[0]).toBeLessThan(255);
});

test('project bitmap roundtrip, rejected loads stay atomic, resizing preserves strokes', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { PainterEngine } = await import('/src/engine.ts');
    const e = new PainterEngine(256); e.addLayer('paint');
    Object.assign(e.brush, { color: '#39c4e6', size: 50, hardness: 1, channel: 'baseColor' });
    e.beginStroke(); e.paint(.5, .5); e.endStroke();
    e.addMask(e.activeLayerId, 'white');
    const source = await e.serialize(), target = new PainterEngine(512);
    await target.load(source);
    const same = Object.keys(e.getChannels()).every(key => e.getChannels()[key].toDataURL() === target.getChannels()[key].toDataURL());
    const beforeInvalid = await target.serialize(), bad = JSON.parse(source); delete bad.textureSets[0].layers[0].color;
    let rejected = false; try { await target.load(JSON.stringify(bad)); } catch { rejected = true; }
    const unchanged = beforeInvalid === await target.serialize();
    const corrupt = JSON.parse(source); corrupt.textureSets[0].layers.at(-1).channels.baseColor = 'data:image/png;base64,AAAA';
    let corruptRejected = false; try { await target.load(JSON.stringify(corrupt)); } catch { corruptRejected = true; }
    const corruptUnchanged = beforeInvalid === await target.serialize();
    target.resize(512);
    const resized = Array.from(target.getChannels().baseColor.getContext('2d').getImageData(256, 256, 1, 1).data);
    const maskSize = target.activeLayer.mask.width;
    target.undo();
    return { same, rejected, unchanged, corruptRejected, corruptUnchanged, resized, maskSize, undoResolution: target.resolution, sets: target.textureSets.map(s => s.id) };
  });
  expect(result.same).toBe(true);
  expect(result.rejected).toBe(true);
  expect(result.unchanged).toBe(true);
  expect(result.corruptRejected).toBe(true);
  expect(result.corruptUnchanged).toBe(true);
  expect(result.resized).toEqual([57, 196, 230, 255]);
  expect(result.maskSize).toBe(512);
  expect(result.undoResolution).toBe(256);
  expect(result.sets).toEqual(['body', 'visor', 'hardware']);
});

test('UV polygon fill and black-mask painting affect only the intended region', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { PainterEngine } = await import('/src/engine.ts');
    const e = new PainterEngine(256); e.setTextureSets([{ id: 'body', name: 'Body' }]);
    e.updateLayer(e.activeLayerId, { materialId: 'visor', color: '#204060' }); e.addLayer('paint');
    Object.assign(e.brush, { color: '#ff0000', channel: 'baseColor' });
    e.fillPolygons([[.1, .1, .9, .1, .1, .9]]);
    const sample = (u: number, v: number) => Array.from(e.getChannels().baseColor.getContext('2d').getImageData(Math.floor(u * 256), Math.floor((1 - v) * 256), 1, 1).data);
    const inside = sample(.25, .25), outside = sample(.8, .8);
    Object.assign(e.brush, { mask: true, color: '#000000', size: 40, hardness: 1 });
    e.beginStroke(); e.paint(.25, .25); e.endStroke(); const masked = sample(.25, .25);
    e.undo(); const restored = sample(.25, .25);
    return { inside, outside, masked, restored };
  });
  expect(result.inside).toEqual([255, 0, 0, 255]);
  expect(result.outside).toEqual([32, 64, 96, 255]);
  expect(result.masked).toEqual(result.outside);
  expect(result.restored).toEqual(result.inside);
});

test('all material presets produce distinct previews and valid channel data', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { PainterEngine, MATERIALS } = await import('/src/engine.ts');
    const engine = new PainterEngine(256);
    const previews = MATERIALS.map(m => engine.createMaterialPreview(m, 32).toDataURL());
    const normal = Array.from(engine.getChannels('visor').normal.getContext('2d').getImageData(8, 8, 1, 1).data);
    return { count: MATERIALS.length, distinct: new Set(previews).size, normal };
  });
  expect(result.count).toBeGreaterThanOrEqual(12);
  expect(result.distinct).toBe(result.count);
  expect(result.normal).toEqual([128, 128, 255, 255]);
});

test('duplicated masks are independent and image imports preserve alpha and scalar maps', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { PainterEngine } = await import('/src/engine.ts');
    const e = new PainterEngine(256); e.setTextureSets([{ id: 'body', name: 'Body' }]);
    e.updateLayer(e.activeLayerId, { materialId: 'visor', color: '#204060', roughness: .4, metallic: .2 });
    const image = document.createElement('canvas'); image.width = image.height = 16;
    const c = image.getContext('2d'); c.fillStyle = '#ff0000'; c.fillRect(0, 0, 8, 16);
    const original = e.addImageLayer(image, 'Decal'); e.addMask(original.id, 'white');
    const originalMask = original.mask.toDataURL(), copy = e.duplicateLayer(original.id);
    e.invertMask(copy.id);
    const pixel = (u: number, channel = 'baseColor') => Array.from(e.getChannels()[channel].getContext('2d').getImageData(u * 256, 128, 1, 1).data);
    const painted = pixel(.25), transparent = pixel(.75), roughness = pixel(.25, 'roughness'), metallic = pixel(.25, 'metallic');
    const independent = original.mask.toDataURL() === originalMask && copy.mask !== original.mask;
    e.updateLayer(original.id, { visible: false }); const hidden = pixel(.25);
    e.undo(); const restored = pixel(.25);
    return { painted, transparent, roughness, metallic, independent, hidden, restored };
  });
  expect(result.independent).toBe(true);
  expect(result.painted).toEqual([255, 0, 0, 255]);
  expect(result.transparent).toEqual([32, 64, 96, 255]);
  expect(result.roughness).toEqual([102, 102, 102, 255]);
  expect(result.metallic).toEqual([51, 51, 51, 255]);
  expect(result.hidden).toEqual(result.transparent);
  expect(result.restored).toEqual(result.painted);
});

test('merge down preserves all rendered maps and its undo restores editable masked sources', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { PainterEngine } = await import('/src/engine.ts');
    const e = new PainterEngine(256); e.setTextureSets([{ id: 'body', name: 'Body' }]);
    const layer = e.addLayer('paint');
    Object.assign(e.brush, { channel: 'material', color: '#55aacc', height: .7, size: 52, hardness: .5 });
    e.beginStroke(); e.paint(.3, .5); e.paint(.65, .5); e.endStroke();
    e.addMask(layer.id, 'white'); e.updateLayer(layer.id, { opacity: .65 });
    const before = Object.fromEntries(Object.entries(e.getChannels()).map(([key, value]) => [key, value.toDataURL()]));
    const merged = e.mergeDown(layer.id), mergeCount = e.activeSet.layers.length;
    const same = Object.entries(e.getChannels()).every(([key, value]) => before[key] === value.toDataURL());
    e.undo(); const restoredSources = e.activeSet.layers.length === 2 && e.activeLayer.mask !== null;
    e.redo(); e.clearLayer(merged.id);
    const cleared = Array.from(e.getChannels().baseColor.getContext('2d').getImageData(80, 128, 1, 1).data);
    e.undo(); const clearUndone = Object.entries(e.getChannels()).every(([key, value]) => before[key] === value.toDataURL());
    return { same, mergeCount, restoredSources, cleared, clearUndone };
  });
  expect(result.same).toBe(true);
  expect(result.mergeCount).toBe(1);
  expect(result.restoredSources).toBe(true);
  expect(result.cleared).toEqual([119, 119, 119, 255]);
  expect(result.clearUndone).toBe(true);
});

test('oversized procedural projects and invalid texture sets are rejected before replacing state', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { PainterEngine } = await import('/src/engine.ts');
    const e = new PainterEngine(256); e.setTextureSets([{ id: 'body', name: 'Body' }]);
    const saved = await e.serialize(), oversized = JSON.parse(saved);
    oversized.resolution = 2048;
    const template = oversized.textureSets[0].layers[0];
    oversized.textureSets[0].layers = Array.from({ length: 80 }, (_, i) => ({ ...template, id: `big-${i}` }));
    oversized.activeLayerId = 'big-0';
    let largeRejected = false; try { await e.load(JSON.stringify(oversized)); } catch (error) { largeRejected = /memory budget/.test(error.message); }
    const unchanged = saved === await e.serialize();
    let emptyRejected = false; try { e.setTextureSets([]); } catch { emptyRejected = true; }
    let invalidRejected = false; try { e.setTextureSets([{ id: 123, name: 'Bad' }]); } catch { invalidRejected = true; }
    return { largeRejected, unchanged, emptyRejected, invalidRejected, finalUnchanged: saved === await e.serialize() };
  });
  expect(result).toEqual({ largeRejected: true, unchanged: true, emptyRejected: true, invalidRejected: true, finalUnchanged: true });
});

test('normal updates match a complete recompute, and synchronous reads preserve change notifications', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { PainterEngine } = await import('/src/engine.ts');
    const e = new PainterEngine(256); e.setTextureSets([{ id: 'body', name: 'Body' }]); e.addLayer('paint');
    await new Promise(resolve => requestAnimationFrame(resolve));
    let notified = 0; e.onChange = () => notified++;
    e.updateLayer(e.activeLayerId, { name: 'Read immediately' }); e.getChannels();
    await new Promise(resolve => requestAnimationFrame(resolve));
    const readNotified = notified > 0;
    Object.assign(e.brush, { channel: 'height', height: .9, size: 32, hardness: .4, symmetry: true });
    e.beginStroke();
    for (let i = 0; i < 5; i++) { e.paint(.1 + i * .07, .15 + i * .12, .2 + i * .18); e.getChannels(); }
    e.endStroke();
    const regional = e.getChannels().normal.toDataURL();
    const restored = new PainterEngine(256); await restored.load(await e.serialize());
    return { matches: regional === restored.getChannels().normal.toDataURL(), readNotified };
  });
  expect(result.matches).toBe(true);
  expect(result.readNotified).toBe(true);
});

test('default 1024 project paints and composites an interactive multi-channel stroke', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { PainterEngine } = await import('/src/engine.ts');
    const start = performance.now(), e = new PainterEngine();
    const initMs = performance.now() - start, frames: number[] = [];
    Object.assign(e.brush, { channel: 'material', color: '#ff0000', roughness: .2, height: .65, size: 42, hardness: 1 });
    e.beginStroke();
    for (let i = 0; i < 20; i++) { const before = performance.now(); e.paint(.4 + i * .005, .5); e.getChannels(); frames.push(performance.now() - before); }
    e.endStroke();
    const pixel = Array.from(e.getChannels().roughness.getContext('2d').getImageData(460, 512, 1, 1).data);
    return { pixel, initMs, averageMs: frames.reduce((sum, value) => sum + value, 0) / frames.length, maxMs: Math.max(...frames), size: e.resolution };
  });
  console.log(`1024 engine benchmark: init ${result.initMs.toFixed(0)}ms, paint+composite average ${result.averageMs.toFixed(1)}ms, max ${result.maxMs.toFixed(1)}ms (GPU upload excluded).`);
  expect(result.size).toBe(1024);
  expect(result.pixel).toEqual([51, 51, 51, 255]);
});

test('merging dependent blend modes refuses an appearance-changing merge without mutating layers', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { PainterEngine } = await import('/src/engine.ts');
    const e = new PainterEngine(256); e.setTextureSets([{ id: 'body', name: 'Body' }]); e.addLayer('paint');
    const upper = e.addLayer('fill', 'visor'); e.updateLayer(upper.id, { blendMode: 'multiply' });
    const before = await e.serialize(); let rejected = false;
    try { e.mergeDown(upper.id); } catch (error) { rejected = /translucent/.test(error.message); }
    return { rejected, unchanged: before === await e.serialize() };
  });
  expect(result).toEqual({ rejected: true, unchanged: true });
});

test('cleared import history cannot restore unrelated mesh sets and revisions track changed sets', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { PainterEngine } = await import('/src/engine.ts');
    const e = new PainterEngine(256);
    const bodyBefore = e.getRevision('body'), visorBefore = e.getRevision('visor');
    e.beginStroke(); e.paint(.5, .5); e.endStroke();
    const changedBody = e.getRevision('body') > bodyBefore, untouchedVisor = e.getRevision('visor') === visorBefore;
    e.setTextureSets([{ id: 'imported-shell', name: 'Imported shell' }]); e.addLayer('paint');
    e.clearHistory(); const noUndo = !e.canUndo && !e.canRedo; e.undo();
    const preserved = e.textureSets.length === 1 && e.activeSet.id === 'imported-shell';
    e.beginStroke(); e.paint(.5, .5); e.endStroke(); e.undo(); const validUndoSet = e.activeSet.id === 'imported-shell';
    e.clearHistory();
    return { changedBody, untouchedVisor, noUndo, preserved, validUndoSet, noRedo: !e.canRedo };
  });
  expect(result).toEqual({ changedBody: true, untouchedVisor: true, noUndo: true, preserved: true, validUndoSet: true, noRedo: true });
});

test('long stroke CPU profile at 1024 and 2048 retains full resolution PBR outputs', async ({ page }) => {
  const results = await page.evaluate(async () => {
    const { PainterEngine } = await import('/src/engine.ts');
    const results: { resolution: number; mode: string; paintAverage: number; flushAverage: number; flushMax: number; correctSize: boolean }[] = [];
    for (const resolution of [1024, 2048]) {
      const e = new PainterEngine(resolution);
      for (const mode of ['material', 'baseColor', 'mask']) {
        Object.assign(e.brush, { channel: mode === 'baseColor' ? 'baseColor' : 'material', mask: mode === 'mask', color: mode === 'mask' ? '#000000' : '#f08833', size: 64, hardness: .75, flow: .8 });
        const paints: number[] = [], flushes: number[] = [];
        e.beginStroke();
        for (let i = 0; i < 35; i++) {
          const before = performance.now(); e.paint(.15 + i * .018, .5 + Math.sin(i * .2) * .2); const painted = performance.now(); e.getChannels(); const flushed = performance.now();
          if (i >= 5) { paints.push(painted - before); flushes.push(flushed - painted); }
        }
        e.endStroke();
        results.push({ resolution, mode, paintAverage: paints.reduce((a, b) => a + b, 0) / paints.length, flushAverage: flushes.reduce((a, b) => a + b, 0) / flushes.length, flushMax: Math.max(...flushes), correctSize: Object.values(e.getChannels()).every(c => c.width === resolution && c.height === resolution) });
      }
      e.clearHistory();
    }
    return results;
  });
  console.log(`Long stroke CPU profile (GPU excluded): ${JSON.stringify(results.map(r => ({ ...r, paintAverage: +r.paintAverage.toFixed(2), flushAverage: +r.flushAverage.toFixed(2), flushMax: +r.flushMax.toFixed(2) })))}`);
  expect(results.every(result => result.correctSize && Number.isFinite(result.paintAverage + result.flushAverage))).toBe(true);
});

test('regional channel composition matches complete recomposition through blended masks and erase', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { PainterEngine } = await import('/src/engine.ts');
    const e = new PainterEngine(256), paintLayer = e.activeLayerId;
    const upper = e.addLayer('fill', 'plastic'); e.updateLayer(upper.id, { opacity: .37, blendMode: 'overlay' }); e.addMask(upper.id, 'white');
    e.setActiveLayer(paintLayer); e.getChannels();
    const before = e.getChannelRevisions();
    Object.assign(e.brush, { channel: 'baseColor', color: '#d938ab', size: 52, hardness: .3, flow: .65 });
    e.beginStroke();
    for (let i = 0; i < 6; i++) { e.paint(.02 + i * .06, .97 - i * .07, .4 + i * .1); e.getChannels(); }
    e.endStroke();
    const after = e.getChannelRevisions(), onlyBaseChanged = after.baseColor > before.baseColor && ['roughness', 'metallic', 'height', 'normal'].every(c => after[c] === before[c]);
    const matches: boolean[] = [];
    const verify = async () => {
      const full = new PainterEngine(256); await full.load(await e.serialize());
      matches.push(Object.entries(e.getChannels()).every(([key, value]) => value.toDataURL() === full.getChannels()[key].toDataURL()));
    };
    await verify();
    e.setActiveLayer(upper.id); Object.assign(e.brush, { mask: true, color: '#000000', symmetry: true, size: 45, hardness: .15, flow: .44 });
    e.beginStroke();
    for (let i = 0; i < 6; i++) { e.paint(.12 + i * .055, .13 + i * .065, .5 + i * .08); e.getChannels(); }
    e.endStroke(); await verify();
    e.setActiveLayer(paintLayer); Object.assign(e.brush, { mask: false, erase: true, channel: 'material', size: 35, hardness: .6, flow: .7 });
    e.beginStroke(); e.paint(.09, .88); e.getChannels(); e.paint(.28, .68); e.getChannels(); e.endStroke(); await verify();
    return { onlyBaseChanged, matches };
  });
  expect(result.onlyBaseChanged).toBe(true);
  expect(result.matches).toEqual([true, true, true]);
});
