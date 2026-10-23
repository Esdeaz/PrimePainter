const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');

const userDataDirectory = app.commandLine.getSwitchValue('user-data-dir');
if (userDataDirectory) app.setPath('userData', path.resolve(userDataDirectory));

let mainWindow;
let dirty = false;
let saving = false;
let opening = false;

const OPEN_TYPES = {
  mesh: { title: 'Импортировать модель', name: '3D model', extensions: ['obj', 'glb', 'gltf'], limit: 100 * 1024 * 1024 },
  project: { title: 'Открыть проект', name: 'PrimePainter project', extensions: ['prime'], limit: 220_000_000 },
  texture: { title: 'Импортировать текстуру', name: 'Image', extensions: ['png', 'jpg', 'jpeg', 'webp'], limit: 32 * 1024 * 1024 },
};
const FILE_TYPES = { obj: 'model/obj', glb: 'model/gltf-binary', gltf: 'model/gltf+json', prime: 'application/json', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

function trusted(event) {
  return mainWindow && !mainWindow.isDestroyed()
    && event.sender === mainWindow.webContents
    && event.senderFrame === mainWindow.webContents.mainFrame;
}

ipcMain.on('window:minimize', event => {
  if (trusted(event)) mainWindow.minimize();
});
ipcMain.on('window:maximize', event => {
  if (trusted(event)) mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.on('window:close', event => {
  if (trusted(event)) mainWindow.close();
});
ipcMain.on('project:dirty', (event, value) => {
  if (trusted(event) && typeof value === 'boolean') dirty = value;
});

ipcMain.handle('file:open', async (event, kind) => {
  if (!trusted(event)) throw new Error('Недоступный источник запроса.');
  if (typeof kind !== 'string' || !Object.hasOwn(OPEN_TYPES, kind)) throw new Error('Недопустимый тип файла.');
  if (opening || saving) return null;
  opening = true;
  const rule = OPEN_TYPES[kind];
  try {
    // shortcut: owner-bound Windows dialogs stay invisible on this Electron build; restore the owner after the native dialog fix.
    const result = await dialog.showOpenDialog({
      title: rule.title,
      defaultPath: app.getPath('documents'),
      filters: [{ name: rule.name, extensions: rule.extensions }],
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length !== 1) return null;
    const filename = result.filePaths[0];
    const extension = path.extname(filename).slice(1).toLowerCase();
    if (!rule.extensions.includes(extension)) throw new Error('Выбран неподдерживаемый формат файла.');
    const status = await fs.stat(filename);
    if (!status.isFile()) throw new Error('Выберите обычный файл.');
    if (status.size > rule.limit) throw new Error('Файл превышает допустимый размер.');
    const data = await fs.readFile(filename);
    if (data.byteLength > rule.limit) throw new Error('Файл превышает допустимый размер.');
    return { name: path.basename(filename), data: new Uint8Array(data), type: FILE_TYPES[extension] };
  } catch (error) {
    if (error instanceof Error && ['Выбран неподдерживаемый формат файла.', 'Выберите обычный файл.', 'Файл превышает допустимый размер.'].includes(error.message)) throw error;
    throw new Error('Не удалось открыть файл. Проверьте доступ к файлу и повторите попытку.');
  } finally {
    opening = false;
  }
});

ipcMain.handle('file:save', async (event, filename, data) => {
  if (!trusted(event)) throw new Error('Недоступный источник запроса.');
  if (typeof filename !== 'string' || !/^[^<>:"/\\|?*\x00-\x1f]{1,180}\.(prime|zip|png|obj)$/i.test(filename)) {
    throw new Error('Недопустимое имя или формат файла.');
  }
  if (!(data instanceof Uint8Array) || data.byteLength > 1024 * 1024 * 1024) {
    throw new Error('Недопустимые данные файла или размер больше 1 ГБ.');
  }
  if (saving || opening) return { saved: false };
  saving = true;
  let temporary;
  try {
    const extension = path.extname(filename).slice(1).toLowerCase();
    const result = await dialog.showSaveDialog({
      title: 'Сохранить файл',
      defaultPath: path.join(app.getPath('documents'), filename),
      filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
      properties: ['showOverwriteConfirmation', 'createDirectory'],
    });
    if (result.canceled || !result.filePath) return { saved: false };
    temporary = path.join(path.dirname(result.filePath), `.${path.basename(result.filePath)}.${randomUUID()}.tmp`);
    const file = await fs.open(temporary, 'wx');
    try {
      await file.writeFile(data);
      await file.sync();
    } finally {
      await file.close();
    }
    await fs.rename(temporary, result.filePath);
    temporary = undefined;
    return { saved: true, path: result.filePath };
  } catch {
    throw new Error('Не удалось сохранить файл. Проверьте доступ и свободное место на диске.');
  } finally {
    if (temporary) await fs.unlink(temporary).catch(() => {});
    saving = false;
  }
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1100,
    minHeight: 700,
    frame: false,
    backgroundColor: '#242424',
    title: 'PrimePainter',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });
  mainWindow.removeMenu();
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('close', event => {
    if (!dirty) return;
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: ['Продолжить работу', 'Закрыть без сохранения'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: 'Есть несохранённые изменения',
      message: 'Закрыть PrimePainter без сохранения проекта?',
      detail: 'Для сохранения вернитесь в проект и нажмите «Сохранить».',
    });
    if (choice !== 1) event.preventDefault();
  });
  mainWindow.on('closed', () => {
    mainWindow = undefined;
    dirty = false;
  });
  const contents = mainWindow.webContents;
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', event => event.preventDefault());
  contents.on('will-redirect', event => event.preventDefault());
  contents.on('will-attach-webview', event => event.preventDefault());
  contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  contents.session.setPermissionCheckHandler(() => false);

  const developmentUrl = !app.isPackaged && process.env.PRIMEPAINTER_DEV_URL;
  if (developmentUrl && !/^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}\/?$/.test(developmentUrl)) {
    throw new Error('PRIMEPAINTER_DEV_URL должен указывать на локальный сервер http://127.0.0.1:PORT.');
  }
  const entry = developmentUrl || pathToFileURL(path.join(__dirname, '..', 'dist', 'index.html')).href;
  mainWindow.loadURL(entry).catch(error => {
    dialog.showErrorBox('PrimePainter', `Не удалось открыть приложение.\n${error.message}`);
    app.quit();
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  app.whenReady().then(createWindow).catch(error => {
    dialog.showErrorBox('PrimePainter', error.message);
    app.quit();
  });
  app.on('window-all-closed', () => app.quit());
}
