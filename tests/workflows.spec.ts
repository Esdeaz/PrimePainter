import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
import { unzipSync, strFromU8 } from 'fflate';

async function ready(page: Page) {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__primePainter));
  await expect(page.locator('.renderer')).toBeVisible();
  await expect(page.locator('.toast.error')).toHaveCount(0);
}

async function newProject(page: Page, name = 'Workflow') {
  await page.keyboard.press('Control+n');
  await expect(page.getByRole('dialog', { name: 'New project' })).toBeVisible();
  await page.locator('#new-name').fill(name);
  await page.locator('#new-model').selectOption('cube');
  await page.locator('#new-resolution').selectOption('256');
  await page.locator('[data-action="create-project"]').click();
  await expect(page.locator('.progress-overlay')).toHaveCount(0);
  await expect(page.locator('#document-name')).toHaveText(name);
}

async function centerPixel(page: Page, channel = 'baseColor') {
  return page.evaluate(channel => {
    const e = window.__primePainter.engine;
    return Array.from(e.getChannels()[channel].getContext('2d')!.getImageData(e.resolution / 2, e.resolution / 2, 1, 1).data);
  }, channel);
}

async function snapshot(page: Page) {
  return page.evaluate(() => {
    const { engine, viewport } = window.__primePainter;
    return {
      maps: engine.textureSets.map(set => Object.fromEntries(Object.entries(engine.getChannels(set.id)).map(([key, canvas]) => [key, canvas.toDataURL()]))),
      uv: viewport.serializeModel().meshes.map(mesh => mesh.geometry.data?.attributes?.uv),
      sets: engine.textureSets.map(set => set.id),
    };
  });
}

async function paintCenter(page: Page, color = '#ff1200') {
  await page.locator('[data-action="add-paint"]').first().click();
  await page.locator('#property-color').fill(color);
  await page.locator('#toolbar-size').fill('35');
  const box = (await page.locator('#uv-canvas').boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

async function downloadProject(page: Page, info: TestInfo) {
  const waiting = page.waitForEvent('download');
  await page.keyboard.press('Control+s');
  const download = await waiting;
  expect(download.suggestedFilename()).toMatch(/\.prime$/);
  const path = info.outputPath('saved.prime');
  await download.saveAs(path);
  await expect(page.locator('.progress-overlay')).toHaveCount(0);
  return { path, text: await readFile(path, 'utf8') };
}

test('workspace loads without runtime errors and captures the reference review image', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await ready(page);
  await expect(page.locator('[data-material]')).toHaveCount(16);
  await expect(page.locator('[data-texture-set]')).toHaveCount(3);
  await mkdir('docs/screenshots', { recursive: true });
  await page.screenshot({ path: 'docs/screenshots/painter-workspace.png' });
  expect(errors).toEqual([]);
});

test('2D brush pixels, undo and redo work through controls and shortcuts', async ({ page }) => {
  await ready(page);
  await newProject(page);
  const before = await centerPixel(page);
  await paintCenter(page);
  await expect.poll(() => centerPixel(page)).toEqual([255, 18, 0, 255]);
  await page.keyboard.press('Control+z');
  await expect.poll(() => centerPixel(page)).toEqual(before);
  await page.keyboard.press('Control+y');
  await expect.poll(() => centerPixel(page)).toEqual([255, 18, 0, 255]);
  await page.locator('[data-action="tool-erase"]').click();
  const box = (await page.locator('#uv-canvas').boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(() => centerPixel(page)).toEqual(before);
});

test('3D camera orbits and surface painting changes the active texture', async ({ page }) => {
  await ready(page);
  await newProject(page);
  await page.locator('[data-action="add-paint"]').first().click();
  await page.locator('#property-color').fill('#00ff40');
  await page.getByRole('combobox', { name: 'Camera', exact: true }).selectOption('Top');
  const renderer = page.locator('.renderer');
  const box = (await renderer.boundingBox())!;
  const before = await page.evaluate(() => window.__primePainter.engine.getChannels().baseColor.toDataURL());
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(() => page.evaluate(() => window.__primePainter.engine.getChannels().baseColor.toDataURL())).not.toBe(before);
  const position = await page.evaluate(() => window.__primePainter.viewport.camera.position.toArray());
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.down('Alt');
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 20, { steps: 10 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await expect.poll(() => page.evaluate(() => window.__primePainter.viewport.camera.position.toArray())).not.toEqual(position);
});

test('material search and doubleclick apply a fill that can be masked', async ({ page }) => {
  await ready(page);
  await newProject(page);
  const initial = await centerPixel(page);
  await page.getByRole('searchbox', { name: 'Search assets' }).fill('Copper');
  await expect(page.locator('[data-material]')).toHaveCount(1);
  await page.locator('[data-material="copper"]').dblclick();
  await expect.poll(() => page.evaluate(() => window.__primePainter.engine.activeLayer.materialId)).toBe('copper');
  const copper = await centerPixel(page);
  expect(copper).not.toEqual(initial);
  await page.locator('[data-action="add-mask"]').click();
  await page.locator('#property-color').fill('#000000');
  const box = (await page.locator('#uv-canvas').boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(() => centerPixel(page)).toEqual(initial);
  await page.keyboard.press('Control+z');
  await expect.poll(() => centerPixel(page)).toEqual(copper);
});

test('saved project reopens with identical texture pixels and UVs; rejected input preserves the project', async ({ page }, info) => {
  await ready(page);
  await newProject(page, 'Roundtrip');
  await paintCenter(page, '#39c4e6');
  const expected = await snapshot(page);
  const saved = await downloadProject(page, info);
  expect(JSON.parse(saved.text).format).toBe('primepainter');
  await page.keyboard.press('Control+z');
  expect(await snapshot(page)).not.toEqual(expected);
  await page.locator('#open-project').setInputFiles(saved.path);
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(page.locator('.progress-overlay')).toHaveCount(0);
  await expect(page.locator('#status-message')).toContainText('Opened Roundtrip');
  expect(await snapshot(page)).toEqual(expected);
  const malformed = JSON.parse(saved.text);
  delete malformed.engine.textureSets[0].layers[0].color;
  await page.locator('#open-project').setInputFiles({ name: 'broken.prime', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(malformed)) });
  await expect(page.locator('.toast.error')).toContainText(/Missing layer properties|Invalid|unsupported/i);
  expect(await snapshot(page)).toEqual(expected);
  await expect(page.locator('#document-name')).toHaveText('Roundtrip');
});

test('texture export writes sized PNGs and real Unreal channel packing', async ({ page }, info) => {
  await ready(page);
  await newProject(page, 'Packed');
  await paintCenter(page, '#2c6ee6');
  const expected = await page.evaluate(() => {
    const e = window.__primePainter.engine, maps = e.getChannels();
    const read = channel => Array.from(maps[channel].getContext('2d')!.getImageData(128, 128, 1, 1).data);
    return { base: read('baseColor'), roughness: read('roughness')[0], metallic: read('metallic')[0], normal: read('normal'), name: e.activeSet.name };
  });
  await page.keyboard.press('Control+Shift+e');
  await expect(page.getByRole('dialog', { name: 'Export textures', exact: true })).toBeVisible();
  await page.locator('#export-template').selectOption('unreal');
  const pending = page.waitForEvent('download');
  await page.locator('[data-action="export-confirm"]').click();
  const download = await pending;
  const path = info.outputPath('textures.zip');
  await download.saveAs(path);
  const files = unzipSync(new Uint8Array(await readFile(path)));
  const manifest = JSON.parse(strFromU8(files['manifest.json']));
  expect(manifest).toMatchObject({ template: 'unreal', resolution: 256, normal: 'DirectX' });
  const pngs = Object.entries(files).filter(([name]) => name.endsWith('.png'));
  expect(pngs).toHaveLength(12);
  for (const [, bytes] of pngs) {
    const buffer = Buffer.from(bytes);
    expect(buffer.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(buffer.readUInt32BE(16)).toBe(256);
    expect(buffer.readUInt32BE(20)).toBe(256);
  }
  const samplePNG = async (bytes: Uint8Array) => page.evaluate(async bytes => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext('2d')!; context.drawImage(bitmap, 0, 0); bitmap.close();
    return Array.from(context.getImageData(128, 128, 1, 1).data);
  }, Array.from(bytes));
  const prefix = `${expected.name}/${expected.name}_`;
  expect(await samplePNG(files[`${prefix}BaseColor.png`])).toEqual(expected.base);
  expect(await samplePNG(files[`${prefix}OcclusionRoughnessMetallic.png`])).toEqual([255, expected.roughness, expected.metallic, 255]);
  const normal = await samplePNG(files[`${prefix}Normal.png`]);
  expect(normal).toEqual([expected.normal[0], 255 - expected.normal[1], expected.normal[2], 255]);
});

test('text editing shortcuts preserve project history and modal focus stays inside the dialog', async ({ page }) => {
  await ready(page);
  await newProject(page);
  await page.locator('[data-action="add-paint"]').first().click();
  const layers = await page.evaluate(() => window.__primePainter.engine.activeSet.layers.length);
  const metallic = page.locator('#property-metallic');
  await metallic.focus();
  const originalRange = (await metallic.elementHandle())!;
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))));
  expect(await originalRange.evaluate(el => el.isConnected)).toBe(true);
  await expect(metallic).toBeFocused();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => page.evaluate(() => window.__primePainter.engine.brush.metallic)).toBe(.01);
  const search = page.getByRole('searchbox', { name: 'Search assets' });
  await search.click();
  await search.pressSequentially('Copper');
  await search.press('Control+z');
  expect(await page.evaluate(() => window.__primePainter.engine.activeSet.layers.length)).toBe(layers);
  await page.keyboard.press('Control+n');
  const dialog = page.getByRole('dialog', { name: 'New project' });
  await expect(dialog).toBeVisible();
  for (let index = 0; index < 12; index++) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('OBJ import creates editable material sets and a rejected mesh preserves them', async ({ page }) => {
  await ready(page);
  const obj = 'o Two panels\nv -1 -1 0\nv 1 -1 0\nv 1 1 0\nv -1 1 0\nvt .05 .05\nvt .45 .05\nvt .45 .45\nvt .05 .45\nusemtl Panel_A\nf 1/1 2/2 3/3\nusemtl Panel_B\nf 1/1 3/3 4/4\n';
  await page.locator('#import-mesh').setInputFiles({ name: 'two-panels.obj', mimeType: 'text/plain', buffer: Buffer.from(obj) });
  await expect(page.locator('#status-message')).toContainText('Imported two-panels.obj');
  await expect(page.locator('[data-texture-set]')).toHaveCount(2);
  expect(await page.evaluate(() => window.__primePainter.engine.textureSets.map(set => set.name))).toEqual(['Panel_A', 'Panel_B']);
  expect(await page.evaluate(() => window.__primePainter.engine.textureSets.every(set => set.layers.some(layer => layer.type === 'paint')))).toBe(true);
  const expected = await snapshot(page);
  await page.locator('#import-mesh').setInputFiles({ name: 'broken.obj', mimeType: 'text/plain', buffer: Buffer.from('o Empty\n') });
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(page.locator('.toast.error')).toContainText('no mesh geometry');
  expect(await snapshot(page)).toEqual(expected);
});

for (const template of ['urp', 'hdrp']) {
  test(`${template.toUpperCase()} export preserves metallic and smoothness in PNG channels`, async ({ page }, info) => {
    await ready(page);
    await newProject(page, template.toUpperCase());
    await page.locator('[data-action="add-paint"]').first().click();
    await page.locator('#property-metallic').focus();
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowRight');
    const box = (await page.locator('#uv-canvas').boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    const expected = await page.evaluate(() => {
      const e = window.__primePainter.engine, maps = e.getChannels();
      return { metallic: maps.metallic.getContext('2d')!.getImageData(128, 128, 1, 1).data[0], roughness: maps.roughness.getContext('2d')!.getImageData(128, 128, 1, 1).data[0], name: e.activeSet.name };
    });
    expect(expected.metallic).toBeGreaterThan(0);
    expect(expected.metallic).toBeLessThan(255);
    await page.keyboard.press('Control+Shift+e');
    await page.locator('#export-template').selectOption(template);
    const pending = page.waitForEvent('download');
    await page.locator('[data-action="export-confirm"]').click();
    const download = await pending;
    const path = info.outputPath(`${template}.zip`);
    await download.saveAs(path);
    const files = unzipSync(new Uint8Array(await readFile(path)));
    const suffix = template === 'hdrp' ? 'MaskMap' : 'MetallicSmoothness';
    const bytes = files[`${expected.name}/${expected.name}_${suffix}.png`];
    expect(bytes).toBeTruthy();
    const pixel = await page.evaluate(async bytes => {
      const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
      const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
      const context = canvas.getContext('2d')!; context.drawImage(bitmap, 0, 0); bitmap.close();
      return Array.from(context.getImageData(128, 128, 1, 1).data);
    }, Array.from(bytes));
    const reference = template === 'hdrp' ? [expected.metallic, 255, 255, 255 - expected.roughness] : [expected.metallic, expected.metallic, expected.metallic, 255 - expected.roughness];
    pixel.forEach((value, index) => expect(Math.abs(value - reference[index])).toBeLessThanOrEqual(1));
  });
}

test('local recovery restores painted pixels after reloading', async ({ page }) => {
  await ready(page);
  await newProject(page, 'Recovery');
  await paintCenter(page, '#83cc27');
  const expected = await snapshot(page);
  await expect(page.locator('#autosave-status')).toHaveText('Recovery copy saved', { timeout: 15000 });
  page.on('dialog', dialog => dialog.accept());
  await page.reload();
  await page.waitForFunction(() => Boolean(window.__primePainter));
  await expect(page.getByRole('dialog', { name: 'Recover local project' })).toBeVisible();
  await page.locator('#restore-project').click();
  await expect(page.locator('.progress-overlay')).toHaveCount(0);
  await expect(page.locator('#document-name')).toHaveText('Recovery');
  expect(await snapshot(page)).toEqual(expected);
  expect(await page.evaluate(() => window.__primePainter.state.dirty)).toBe(true);
});

test('texture sets with identical display names do not overwrite each other in ZIP exports', async ({ page }, info) => {
  await ready(page);
  await newProject(page, 'Duplicate names');
  const project = JSON.parse(await page.evaluate(() => window.__primePainter.getProject()));
  for (const set of project.engine.textureSets) set.name = 'Shared';
  for (const set of project.model.sets) set.name = 'Shared';
  await page.locator('#open-project').setInputFiles({ name: 'same-names.prime', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(project)) });
  await expect(page.locator('#status-message')).toContainText('Opened Duplicate names');
  await page.keyboard.press('Control+Shift+e');
  const pending = page.waitForEvent('download');
  await page.locator('[data-action="export-confirm"]').click();
  const download = await pending;
  const path = info.outputPath('same-names.zip');
  await download.saveAs(path);
  const files = unzipSync(new Uint8Array(await readFile(path)));
  const pngs = Object.keys(files).filter(name => name.endsWith('.png'));
  expect(pngs).toHaveLength(15);
  expect(new Set(pngs.map(name => name.split('/')[0])).size).toBe(3);
});
