// LaptopDisplay — Electron メインプロセス
//
// 1 つのアプリで送信側 (Mac) と受信側 (Windows) を兼ねる。
// 起動時の OS で役割を自動判定し、--sender / --receiver フラグで上書きできる。
//   送信側: シグナリングサーバーを内蔵起動し、UDP ビーコンで自分の存在を通知する
//   受信側: UDP ビーコンを待ち受け、送信側を見つけたら自動接続する

const {
  app,
  BrowserWindow,
  Menu,
  ipcMain,
  desktopCapturer,
  clipboard,
  powerSaveBlocker,
  shell,
  systemPreferences,
} = require('electron');
const path = require('path');
const os = require('os');
const dgram = require('dgram');
const { spawn, execFileSync } = require('child_process');
const { startSignaling, lanAddresses } = require('./lib/signaling');

const SIGNAL_PORT = 3100;
const DISCOVERY_PORT = 3101;
const BEACON_INTERVAL_MS = 2000;

const role = process.argv.includes('--receiver')
  ? 'receiver'
  : process.argv.includes('--sender')
    ? 'sender'
    : process.platform === 'darwin'
      ? 'sender'
      : 'receiver';

let win = null;
let peerState = { sender: false, receiver: false };

function createWindow() {
  win = new BrowserWindow({
    width: role === 'sender' ? 980 : 1100,
    height: role === 'sender' ? 720 : 700,
    minWidth: 720,
    minHeight: 520,
    backgroundColor: '#0f1216',
    autoHideMenuBar: true,
    title: 'LaptopDisplay',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 最小化・非表示時に配信処理が間引かれて遅延が跳ねるのを防ぐ
      backgroundThrottling: false,
    },
  });
  // Windows / Linux ではメニューバーを完全に消す(Alt キーでも出てこないようにする)。
  // macOS はメニューを消すと ⌘Q などの標準ショートカットも失われるため残す。
  if (process.platform !== 'darwin') {
    win.setMenuBarVisibility(false);
    win.setMenu(null);
  }

  win.loadFile(path.join(__dirname, 'app', `${role}.html`));
  win.on('closed', () => (win = null));
}

function startSenderServices() {
  startSignaling({
    port: SIGNAL_PORT,
    publicDir: path.join(__dirname, 'public'),
    onPeerChange: (peers) => {
      peerState = peers;
      if (win) win.webContents.send('peers-changed', peers);
    },
  });

  // 受信側アプリが送信側を自動発見できるよう、LAN にビーコンをブロードキャストする
  const beacon = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  beacon.on('error', () => {});
  beacon.bind(() => {
    try {
      beacon.setBroadcast(true);
    } catch {}
  });
  const payload = () =>
    Buffer.from(JSON.stringify({ app: 'laptop-display', port: SIGNAL_PORT, host: os.hostname() }));
  setInterval(() => {
    beacon.send(payload(), DISCOVERY_PORT, '255.255.255.255', () => {});
  }, BEACON_INTERVAL_MS);
}

function startReceiverServices() {
  const listener = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  listener.on('error', () => {});
  listener.on('message', (buf, rinfo) => {
    try {
      const msg = JSON.parse(buf.toString());
      if (msg.app === 'laptop-display' && win) {
        win.webContents.send('sender-discovered', {
          ip: rinfo.address,
          port: msg.port || SIGNAL_PORT,
          host: msg.host || '',
        });
      }
    } catch {}
  });
  listener.bind(DISCOVERY_PORT);
}

// ---- IPC ----

ipcMain.handle('get-info', () => ({
  role,
  port: SIGNAL_PORT,
  ips: lanAddresses(),
  hostname: os.hostname(),
  platform: process.platform,
}));

ipcMain.handle('get-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 360, height: 220 },
  });
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    kind: s.id.startsWith('screen') ? 'screen' : 'window',
    thumb: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL(),
  }));
});

// 画面収録の権限状態。アプリを更新すると署名が変わるため、
// 以前許可していても無効に戻ることがある(その場合ここが 'denied' になる)。
ipcMain.handle('get-screen-permission', () => {
  if (process.platform !== 'darwin') return 'granted';
  try {
    return systemPreferences.getMediaAccessStatus('screen');
  } catch {
    return 'unknown';
  }
});

ipcMain.handle('open-screen-settings', () => {
  if (process.platform !== 'darwin') return;
  return shell.openExternal(
    'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
  );
});

ipcMain.handle('relaunch', () => {
  app.relaunch();
  app.exit(0);
});

ipcMain.handle('get-peers', () => peerState);

// ---- 受信側の画面情報 ----
// Windows が対応している解像度を列挙して、送信側が仮想ディスプレイの
// 解像度として選べるようにする。ハードウェア固有で変わらないのでキャッシュする。
let cachedModes = null;

function windowsSupportedModes() {
  if (process.platform !== 'win32') return [];
  if (cachedModes) return cachedModes;
  try {
    const ps =
      'Get-CimInstance -ClassName CIM_VideoControllerResolution | ' +
      'ForEach-Object { "$($_.HorizontalResolution)x$($_.VerticalResolution)" } | ' +
      'Sort-Object -Unique';
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      timeout: 8000,
      encoding: 'utf8',
      windowsHide: true,
    });
    cachedModes = out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^\d+x\d+$/.test(line))
      .map((line) => {
        const [w, h] = line.split('x').map(Number);
        return { w, h };
      });
  } catch {
    cachedModes = [];
  }
  return cachedModes;
}

ipcMain.handle('get-display-info', () => {
  const { screen } = require('electron');
  const display = screen.getPrimaryDisplay();
  const scaleFactor = display.scaleFactor || 1;
  const native = {
    w: Math.round(display.size.width * scaleFactor),
    h: Math.round(display.size.height * scaleFactor),
  };
  const aspect = native.w / native.h;

  // 実際に対応している解像度のうち、パネルと同じ縦横比のものだけを使う
  // (比率が違うものを選ぶと黒帯や引き伸ばしになるため)
  let modes = windowsSupportedModes().filter(
    (m) => m.w <= native.w && m.w >= 1024 && Math.abs(m.w / m.h - aspect) < 0.02
  );

  // 列挙できなかった場合は、パネルの比率から一般的な段階を組み立てる
  if (!modes.length) {
    modes = [2560, 1920, 1680, 1440, 1280]
      .filter((w) => w <= native.w)
      .map((w) => ({ w, h: Math.round(w / aspect / 2) * 2 }));
  }

  if (!modes.some((m) => m.w === native.w && m.h === native.h)) modes.push(native);

  const seen = new Set();
  modes = modes
    .sort((a, b) => b.w - a.w)
    .filter((m) => {
      const key = `${m.w}x${m.h}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  return { native, logical: { w: display.size.width, h: display.size.height }, scaleFactor, modes };
});

ipcMain.handle('copy-text', (_e, text) => clipboard.writeText(String(text)));

// 仮想ディスプレイ (macOS のみ)。同梱の VirtualDisplay ヘルパーを起動すると
// macOS に「2 枚目のモニタ」が現れ、ヘルパーを終了すると消える
let vdProc = null;

ipcMain.handle('virtual-display', (_e, { on, width = 1920, height = 1080 }) => {
  if (process.platform !== 'darwin') {
    return Promise.resolve({ ok: false, error: 'macOS でのみ使えます' });
  }
  if (!on) {
    if (vdProc) { vdProc.kill(); vdProc = null; }
    return Promise.resolve({ ok: true, active: false });
  }
  if (vdProc) return Promise.resolve({ ok: true, active: true });

  const bin = app.isPackaged
    ? path.join(process.resourcesPath, 'VirtualDisplay')
    : path.join(__dirname, 'build', 'VirtualDisplay');

  return new Promise((resolve) => {
    const child = spawn(bin, [String(width), String(height), '60'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let settled = false;
    const done = (result) => {
      if (!settled) { settled = true; resolve(result); }
    };
    child.stdout.on('data', (buf) => {
      if (buf.toString().includes('created')) {
        vdProc = child;
        done({ ok: true, active: true });
      }
    });
    child.on('error', (err) => done({ ok: false, error: err.message }));
    child.on('exit', (code) => {
      if (vdProc === child) {
        vdProc = null;
        if (win) win.webContents.send('virtual-display-changed', false);
      }
      done({ ok: false, error: `ヘルパーが終了しました (code ${code})` });
    });
    setTimeout(() => done({ ok: false, error: 'タイムアウトしました' }), 5000);
  });
});

app.on('will-quit', () => {
  if (vdProc) vdProc.kill();
});

// 配信中はスリープ・省電力によるスローダウンを抑止する
let blockerId = null;
ipcMain.handle('set-streaming', (_e, on) => {
  if (on && blockerId === null) {
    blockerId = powerSaveBlocker.start('prevent-app-suspension');
  } else if (!on && blockerId !== null) {
    powerSaveBlocker.stop(blockerId);
    blockerId = null;
  }
});

// desired を渡すとその状態にする。省略時はトグル。
ipcMain.handle('toggle-fullscreen', (_e, desired) => {
  if (!win) return false;
  const next = typeof desired === 'boolean' ? desired : !win.isFullScreen();
  win.setFullScreen(next);
  // Windows では全画面にしてもタスクバーが前面に残ることがあるため、
  // 全画面中は最前面に固定してタスクバーを覆う(解除時は元に戻す)。
  win.setAlwaysOnTop(next, 'screen-saver');
  if (next) win.focus();
  return win.isFullScreen();
});

// ---- ライフサイクル ----

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
    if (role === 'sender') startSenderServices();
    else startReceiverServices();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => app.quit());
}
