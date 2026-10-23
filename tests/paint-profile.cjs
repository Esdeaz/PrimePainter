const { _electron: electron } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function measure(page) {
  await page.waitForFunction(() => Boolean(window.__primePainter));
  const bounds = await page.locator('#uv-canvas').boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  const result = await page.evaluate(async () => {
    const { engine, viewport } = window.__primePainter;
    const samples = { uv: [], upload: [], render: [], frame: [] };
    const originals = {};
    for (const [method, group] of [['drawUV', 'uv'], ['setTextureSet', 'upload']]) {
      originals[method] = viewport[method];
      viewport[method] = function (...args) {
        const started = performance.now(), result = originals[method].apply(this, args);
        samples[group].push(performance.now() - started);
        return result;
      };
    }
    const render = viewport.renderer.render;
    viewport.renderer.render = function (...args) {
      const started = performance.now();
      render.apply(this, args);
      samples.render.push(performance.now() - started);
    };
    try {
      let previous = performance.now();
      await new Promise(resolve => {
        let frame = 0;
        function step(now) {
          samples.frame.push(now - previous); previous = now;
          engine.paint(.4 + .15 * Math.sin(frame * .17), .45 + .06 * Math.cos(frame * .13));
          if (++frame < 32) requestAnimationFrame(step);
          else resolve();
        }
        requestAnimationFrame(step);
      });
      const gl = viewport.renderer.getContext(), debug = gl.getExtension('WEBGL_debug_renderer_info');
      const statistics = values => {
        const steady = values.slice(5).sort((a, b) => a - b);
        return { count: values.length, mean: Number((steady.reduce((sum, value) => sum + value, 0) / steady.length).toFixed(2)), p95: Number(steady[Math.floor(steady.length * .95)].toFixed(2)) };
      };
      return { resolution: engine.resolution, gpu: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), ...Object.fromEntries(Object.entries(samples).map(([group, values]) => [group, statistics(values)])) };
    } finally {
      for (const method of Object.keys(originals)) viewport[method] = originals[method];
      viewport.renderer.render = render;
    }
  });
  await page.mouse.up();
  assert.equal(result.frame.count, 32);
  for (const group of ['frame', 'uv', 'upload', 'render']) assert(Number.isFinite(result[group].mean) && result[group].mean >= 0);
  return result;
}

(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'primepainter-paint-profile-'));
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.PRIMEPAINTER_DEV_URL;
  const application = await electron.launch({ args: [path.resolve(__dirname, '..'), `--user-data-dir=${directory}`], env: environment });
  try {
    assert.equal(path.resolve(await application.evaluate(({ app }) => app.getPath('userData'))), path.resolve(directory));
    const page = await application.firstWindow();
    console.log(JSON.stringify(await measure(page), null, 2));
  } finally {
    await application.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await application.close().catch(() => {});
    assert.equal(path.dirname(directory), os.tmpdir());
    await fs.rm(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
