import { test, expect, _electron as electron } from '@playwright/test';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';

const triangleOBJ = 'o Native triangle\nv -1 -1 0\nv 1 -1 0\nv 0 1 0\nvt .1 .1\nvt .9 .1\nvt .5 .9\nusemtl Native_Surface\nf 1/1 2/2 3/3\n';

function triangleGLB() {
  const binary = Buffer.alloc(104);
  [-1, -1, 0, 1, -1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1, .1, .1, .9, .1, .5, .9].forEach((value, index) => binary.writeFloatLE(value, index * 4));
  [0, 1, 2].forEach((value, index) => binary.writeUInt16LE(value, 96 + index * 2));
  const model = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    materials: [{ name: 'Native_Surface', pbrMetallicRoughness: { baseColorFactor: [.3, .5, .7, 1], roughnessFactor: .6, metallicFactor: .2 } }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
    buffers: [{ byteLength: 102 }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36, target: 34962 }, { buffer: 0, byteOffset: 36, byteLength: 36, target: 34962 }, { buffer: 0, byteOffset: 72, byteLength: 24, target: 34962 }, { buffer: 0, byteOffset: 96, byteLength: 6, target: 34963 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-1, -1, 0], max: [1, 1, 0] }, { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' }, { bufferView: 2, componentType: 5126, count: 3, type: 'VEC2' }, { bufferView: 3, componentType: 5123, count: 3, type: 'SCALAR' }],
  };
  const json = Buffer.from(JSON.stringify(model));
  const paddedJSON = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20); json.copy(paddedJSON);
  const header = Buffer.alloc(20); header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(28 + paddedJSON.length + binary.length, 8); header.writeUInt32LE(paddedJSON.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  const binaryHeader = Buffer.alloc(8); binaryHeader.writeUInt32LE(binary.length, 0); binaryHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, paddedJSON, binaryHeader, binary]);
}

test('production Electron uses native open dialogs for OBJ and GLB, cancellation preserves state, painting and saving work', async ({}, info) => {
  test.setTimeout(90000);
  const directory = info.outputPath('native');
  const profile = path.join(directory, 'profile');
  await mkdir(profile, { recursive: true });
  const obj = path.join(directory, 'Native chooser.obj'), glb = path.join(directory, 'Native chooser.glb');
  await writeFile(obj, triangleOBJ); await writeFile(glb, triangleGLB());
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.PRIMEPAINTER_DEV_URL;
  const executable = process.env.PRIMEPAINTER_E2E_EXECUTABLE;
  const application = await electron.launch({
    ...(executable ? { executablePath: path.resolve(executable) } : {}),
    args: executable ? [`--user-data-dir=${profile}`] : [process.cwd(), `--user-data-dir=${profile}`],
    env: environment,
  });
  try {
    expect(path.resolve(await application.evaluate(({ app }) => app.getPath('userData')))).toBe(path.resolve(profile));
    if (executable) expect(await application.evaluate(({ app }) => app.isPackaged)).toBe(true);
    const page = await application.firstWindow();
    const errors: string[] = [], consoleMessages: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => consoleMessages.push(`${message.type()}: ${message.text()}`));
    await page.waitForFunction(() => Boolean(window.__primePainter && window.primeDesktop));
    expect(page.url()).toMatch(/^file:/);
    await expect(page.locator('.renderer')).toBeVisible();
    let browserChoosers = 0;
    page.on('filechooser', () => { browserChoosers++; });
    await application.evaluate(({ dialog }) => {
      dialog.__testOpenCalls = [];
      dialog.__testOpenPath = null;
      dialog.showOpenDialog = async (...args) => {
        const options = args.at(-1);
        dialog.__testOpenCalls.push(options);
        return dialog.__testOpenPath ? { canceled: false, filePaths: [dialog.__testOpenPath] } : { canceled: true, filePaths: [] };
      };
    });
    const beforeCancel = await page.evaluate(() => ({ name: window.__primePainter.state.name, sets: window.__primePainter.engine.textureSets.map(set => set.id), dirty: window.__primePainter.state.dirty }));
    await page.keyboard.press('Control+i');
    await expect.poll(() => application.evaluate(({ dialog }) => dialog.__testOpenCalls.length)).toBe(1);
    await expect(page.locator('.progress-overlay')).toHaveCount(0);
    expect(await page.evaluate(() => ({ name: window.__primePainter.state.name, sets: window.__primePainter.engine.textureSets.map(set => set.id), dirty: window.__primePainter.state.dirty }))).toEqual(beforeCancel);
    await application.evaluate(({ dialog }, file) => { dialog.__testOpenPath = file; }, path.join(directory, 'missing.obj'));
    await page.keyboard.press('Control+i');
    await expect(page.locator('.toast.error')).toContainText('Не удалось открыть файл');
    await expect(page.locator('.progress-overlay')).toHaveCount(0);
    expect(await page.evaluate(() => ({ name: window.__primePainter.state.name, sets: window.__primePainter.engine.textureSets.map(set => set.id), dirty: window.__primePainter.state.dirty }))).toEqual(beforeCancel);
    await page.locator('.toast.error .toast-dismiss').click();
    await application.evaluate(({ dialog }, file) => { dialog.__testOpenPath = file; }, obj);

    await page.locator('[data-menu="File"]').click();
    await page.getByRole('menuitem', { name: /Import mesh/ }).click();
    await expect(page.locator('#status-message')).toContainText('Imported Native chooser.obj', { timeout: 15000 });
    await expect(page.locator('[data-texture-set]')).toHaveCount(1);
    expect(await page.evaluate(() => window.__primePainter.engine.activeSet.name)).toBe('Native_Surface');
    expect(await application.evaluate(({ dialog }) => dialog.__testOpenCalls[1].filters[0].extensions)).toEqual(['obj', 'glb', 'gltf']);

    await application.evaluate(({ dialog }, file) => { dialog.__testOpenPath = file; }, glb);
    await page.keyboard.press('Control+i');
    await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
    await expect(page.locator('#status-message')).toContainText('Imported Native chooser.glb', { timeout: 15000 });
    await expect(page.locator('[data-texture-set]')).toHaveCount(1);
    const before = await page.evaluate(() => window.__primePainter.engine.getChannels().baseColor.toDataURL());
    await page.locator('#property-color').fill('#28cc80');
    const canvas = (await page.locator('#uv-canvas').boundingBox())!;
    await page.mouse.click(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
    await expect.poll(() => page.evaluate(() => window.__primePainter.engine.getChannels().baseColor.toDataURL())).not.toBe(before);

    await application.evaluate(({ dialog }, targets) => {
      dialog.showSaveDialog = async (...args) => ({ canceled: false, filePath: args.at(-1).filters[0].extensions[0] === 'zip' ? targets.zip : targets.prime });
    }, { prime: path.join(directory, 'Native chooser.prime'), zip: path.join(directory, 'Native chooser_textures.zip') });
    await page.keyboard.press('Control+s');
    const project = path.join(directory, 'Native chooser.prime');
    await expect.poll(async () => { try { return JSON.parse(await readFile(project, 'utf8')).format; } catch { return ''; } }).toBe('primepainter');
    await expect(page.locator('.progress-overlay')).toHaveCount(0);
    await page.keyboard.press('Control+Shift+e');
    await page.locator('[data-action="export-confirm"]').click();
    const exported = path.join(directory, 'Native chooser_textures.zip');
    await expect.poll(async () => { try { return (await readFile(exported)).subarray(0, 2).toString(); } catch { return ''; } }).toBe('PK');
    await expect(page.locator('.progress-overlay')).toHaveCount(0);
    expect(browserChoosers).toBe(0);
    expect(errors).toEqual([]);
    await writeFile(path.join(directory, 'console.txt'), consoleMessages.join('\n'));
  } finally {
    await application.evaluate(({ app }) => { app.exit(0); }).catch(() => {});
    await application.close().catch(() => {});
  }
});
