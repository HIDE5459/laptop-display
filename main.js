// LaptopDisplay — Electron メインプロセス
//
// 1 つのアプリで送信側 (Mac) と受信側 (Windows) を兼ねる。
// 起動時の OS で役割を自動判定し、--sender / --receiver フラグで上書きできる。
//   送信側: シグナリングサーバーを内蔵起動し、UDP ビーコンで自分の存在を通知する
//   受信側: UDP ビーコンを待ち受け、送信側を見つけたら自動接続する

const { app, BrowserWindow, ipcMain, desktopCapturer, clipboard, powerSaveBlocker } = require('electron');
const path = require('path');
const os = require('os');
const dgram = require('dgram');
const { spawn } = require('child_process');
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

ipcMain.handle('get-peers', () => peerState);

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

ipcMain.handle('toggle-fullscreen', () => {
  if (win) win.setFullScreen(!win.isFullScreen());
  return win ? win.isFullScreen() : false;
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
    if (role === 'sender') startSenderServices();
    else startReceiverServices();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => app.quit());
}
