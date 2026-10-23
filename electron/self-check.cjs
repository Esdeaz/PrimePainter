const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

// Exercise the desktop boundary without opening dialogs or touching user files.
const handlers = new Map();
const listeners = new Map();
const app = new EventEmitter();
app.requestSingleInstanceLock = () => true;
app.whenReady = () => Promise.resolve();
app.quit = () => { throw new Error('Unexpected app quit'); };
app.getPath = () => os.tmpdir();
app.commandLine = { getSwitchValue: () => '' };
app.setPath = () => {};
app.isPackaged = false;
let window;

class TestWindow extends EventEmitter {
  constructor(options) {
    super();
    window = this;
    this.options = options;
    this.webContents = new EventEmitter();
    this.webContents.mainFrame = {};
    this.webContents.session = {
      setPermissionRequestHandler: handler => { this.permission = handler; },
      setPermissionCheckHandler: handler => { this.permissionCheck = handler; },
    };
    this.webContents.setWindowOpenHandler = handler => { this.openWindow = handler; };
  }
  removeMenu() {}
  isDestroyed() { return false; }
  show() {}
  loadURL(url) { this.url = url; return Promise.resolve(); }
  minimize() { this.minimized = true; }
  maximize() { this.maximized = true; }
  unmaximize() { this.maximized = false; }
  isMaximized() { return this.maximized; }
  close() { this.emit('close', { preventDefault: () => { this.preventedClose = true; } }); }
}

let closeChoice = 0;
let saveResult;
let openResult;
let openOptions;
const electron = {
  app,
  BrowserWindow: TestWindow,
  ipcMain: {
    on: (name, handler) => listeners.set(name, handler),
    handle: (name, handler) => handlers.set(name, handler),
  },
  dialog: {
    showOpenDialog: async (...args) => { openOptions = args.at(-1); return openResult; },
    showSaveDialog: async () => saveResult,
    showMessageBoxSync: () => closeChoice,
    showErrorBox: (...args) => { throw new Error(args.join(' ')); },
  },
};
const originalLoad = Module._load;
const previousDevUrl = process.env.PRIMEPAINTER_DEV_URL;
delete process.env.PRIMEPAINTER_DEV_URL;
Module._load = function (name, ...args) {
  return name === 'electron' ? electron : originalLoad.call(this, name, ...args);
};

async function check() {
  let directory;
  try {
    require('./main.cjs');
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(window.options.frame, false);
    assert.equal(window.options.webPreferences.contextIsolation, true);
    assert.equal(window.options.webPreferences.nodeIntegration, false);
    assert.equal(window.options.webPreferences.sandbox, true);
    assert.match(window.url, /^file:/);
    assert.deepEqual(window.openWindow(), { action: 'deny' });
    assert.equal(window.permissionCheck(), false);
    let permission;
    window.permission(null, 'camera', value => { permission = value; });
    assert.equal(permission, false);
    for (const name of ['will-navigate', 'will-redirect', 'will-attach-webview']) {
      let denied = false;
      window.webContents.emit(name, { preventDefault: () => { denied = true; } });
      assert.equal(denied, true, name);
    }

    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
    const save = handlers.get('file:save');
    const open = handlers.get('file:open');
    await assert.rejects(open({}, 'mesh'));
    await assert.rejects(open({ ...event, senderFrame: {} }, 'mesh'));
    await assert.rejects(open(event, '../arbitrary-path'));
    await assert.rejects(open(event, '__proto__'));
    await assert.rejects(save({}, 'valid.png', new Uint8Array([1])));
    await assert.rejects(save({ ...event, senderFrame: {} }, 'valid.png', new Uint8Array([1])));
    await assert.rejects(save(event, '../escape.png', new Uint8Array([1])));
    await assert.rejects(save(event, 'no.exe', new Uint8Array([1])));
    await assert.rejects(save(event, 'valid.png', 'not bytes'));

    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'prime-shell-check-'));
    const model = path.join(directory, 'fixture.obj');
    await fs.writeFile(model, 'v 0 0 0\n');
    openResult = { canceled: false, filePaths: [model] };
    const opened = await open(event, 'mesh');
    assert.equal(opened.name, 'fixture.obj');
    assert.equal(opened.type, 'model/obj');
    assert.ok(opened.data instanceof Uint8Array);
    assert.equal(Buffer.from(opened.data).toString(), 'v 0 0 0\n');
    assert.deepEqual(openOptions.filters[0].extensions, ['obj', 'glb', 'gltf']);
    assert.deepEqual(openOptions.properties, ['openFile']);
    await assert.rejects(open(event, 'project'), /неподдерживаемый формат/);
    openResult = { canceled: true, filePaths: [] };
    assert.equal(await open(event, 'mesh'), null);
    const normalOpenDialog = electron.dialog.showOpenDialog;
    let releaseDialog;
    electron.dialog.showOpenDialog = () => new Promise(resolve => { releaseDialog = resolve; });
    const pendingOpen = open(event, 'mesh');
    assert.equal(await open(event, 'mesh'), null);
    assert.deepEqual(await save(event, 'project.prime', new Uint8Array([1])), { saved: false });
    releaseDialog({ canceled: true, filePaths: [] });
    assert.equal(await pendingOpen, null);
    electron.dialog.showOpenDialog = normalOpenDialog;
    const originalStat = fs.stat;
    try {
      fs.stat = async () => ({ isFile: () => true, size: 100 * 1024 * 1024 + 1 });
      openResult = { canceled: false, filePaths: [model] };
      await assert.rejects(open(event, 'mesh'), /допустимый размер/);
    } finally { fs.stat = originalStat; }
    await fs.unlink(model);
    const target = path.join(directory, 'project.prime');
    saveResult = { canceled: false, filePath: target };
    assert.deepEqual(await save(event, 'project.prime', new Uint8Array([10, 20, 30])), { saved: true, path: target });
    assert.deepEqual([...await fs.readFile(target)], [10, 20, 30]);
    await save(event, 'project.prime', new Uint8Array([40]));
    assert.deepEqual([...await fs.readFile(target)], [40]);
    assert.deepEqual(await fs.readdir(directory), ['project.prime']);
    saveResult = { canceled: true };
    assert.deepEqual(await save(event, 'project.prime', new Uint8Array([99])), { saved: false });
    assert.deepEqual([...await fs.readFile(target)], [40]);

    const blocked = path.join(directory, 'blocked.prime');
    await fs.mkdir(blocked);
    saveResult = { canceled: false, filePath: blocked };
    await assert.rejects(save(event, 'project.prime', new Uint8Array([99])), /Не удалось сохранить/);
    assert.deepEqual((await fs.readdir(directory)).sort(), ['blocked.prime', 'project.prime']);

    listeners.get('project:dirty')(event, true);
    window.close();
    assert.equal(window.preventedClose, true);
    closeChoice = 1;
    window.preventedClose = false;
    window.close();
    assert.equal(window.preventedClose, false);
    closeChoice = 0;
    listeners.get('project:dirty')({}, false);
    window.close();
    assert.equal(window.preventedClose, true);
    listeners.get('project:dirty')(event, false);
    window.preventedClose = false;
    window.close();
    assert.equal(window.preventedClose, false);
    listeners.get('window:minimize')(event);
    assert.equal(window.minimized, true);
    listeners.get('window:maximize')(event);
    assert.equal(window.maximized, true);
    listeners.get('window:maximize')(event);
    assert.equal(window.maximized, false);

    let bridge;
    const sent = [];
    electron.contextBridge = { exposeInMainWorld: (name, api) => { bridge = { name, api }; } };
    electron.ipcRenderer = { send: (...args) => sent.push(args), invoke: (...args) => Promise.resolve(args) };
    require('./preload.cjs');
    assert.equal(bridge.name, 'primeDesktop');
    assert.deepEqual(Object.keys(bridge.api).sort(), ['close', 'maximize', 'minimize', 'openFile', 'saveFile', 'setDirty']);
    bridge.api.setDirty(true);
    bridge.api.close();
    assert.deepEqual(sent, [['project:dirty', true], ['window:close']]);
    assert.deepEqual(await bridge.api.saveFile('test.png', new Uint8Array([1])), ['file:save', 'test.png', new Uint8Array([1])]);
    assert.deepEqual(await bridge.api.openFile('mesh'), ['file:open', 'mesh']);
    console.log('Desktop checks passed: isolation, permissions, trusted open filters/bytes/size/cancel/dialog gate, atomic save, failure cleanup, dirty close, window controls, preload API.');
  } finally {
    Module._load = originalLoad;
    if (previousDevUrl === undefined) delete process.env.PRIMEPAINTER_DEV_URL;
    else process.env.PRIMEPAINTER_DEV_URL = previousDevUrl;
    if (directory) {
      assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
      assert.ok(path.basename(directory).startsWith('prime-shell-check-'));
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
}

check().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
