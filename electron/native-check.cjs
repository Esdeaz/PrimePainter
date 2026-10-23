const { _electron: electron, expect } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

(async () => {
  const temporaryRoot = await fs.realpath(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(temporaryRoot, 'primepainter-native-'));
  const profile = path.join(directory, 'profile');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.PRIMEPAINTER_DEV_URL;
  let application;
  try {
    await fs.mkdir(profile, { recursive: true });
    application = await electron.launch({ args: [path.resolve(__dirname, '..'), `--user-data-dir=${profile}`], env });
    assert.equal(path.resolve(await application.evaluate(({ app }) => app.getPath('userData'))), path.resolve(profile));
    const page = await application.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(() => window.__primePainter && window.primeDesktop);
    assert.match(page.url(), /^file:/);
    await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
    assert.equal(await page.locator('.window-controls').isVisible(), true);
    const target = path.join(directory, 'Native save.prime');
    await application.evaluate(({ dialog }, filename) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: filename }); }, target);
    const project = await page.evaluate(() => window.__primePainter.getProject());
    const result = await page.evaluate(async text => window.primeDesktop.saveFile('Native save.prime', new TextEncoder().encode(text)), project);
    assert.equal(result.saved, true);
    assert.equal(await fs.readFile(target, 'utf8'), project);
    await page.evaluate(() => window.primeDesktop.setDirty(false));
    await application.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true }); });
    assert.equal(await page.evaluate(async () => (await window.primeDesktop.saveFile('Cancel.prime', new Uint8Array([1]))).saved), false);
    const screenshots = path.resolve(__dirname, '..', 'test-results', 'native-check');
    await fs.mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: path.join(screenshots, 'workspace.png') });
    assert.deepEqual(errors, []);
    console.log('Native Electron check passed: production file load, isolated profile/preload, actual .prime save bytes, cancellation, no renderer errors.');
  } finally {
    if (application) {
      await application.evaluate(({ app }) => app.exit(0)).catch(() => {});
      await application.close().catch(() => {});
    }
    const cleanupTarget = await fs.realpath(directory);
    assert.ok(path.isAbsolute(cleanupTarget));
    assert.equal(path.relative(temporaryRoot, cleanupTarget), path.basename(directory));
    assert.match(path.basename(cleanupTarget), /^primepainter-native-[^\\/]+$/);
    await fs.rm(cleanupTarget, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
