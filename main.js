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
  globalShortcut,
  screen,
  Tray,
  nativeImage,
} = require('electron');
const path = require('path');
const os = require('os');
const dgram = require('dgram');
const { spawn, execFileSync } = require('child_process');
const { startSignaling, lanAddresses } = require('./lib/signaling');
const { keycodeFor, flagsFrom, remapModifiers } = require('./lib/keymap');

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
let tray = null;
let isQuitting = false;
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

  // 受信側は常駐させたいので、ウィンドウを閉じても終了せずトレイに残す
  win.on('close', (event) => {
    if (role === 'receiver' && !isQuitting) {
      event.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => (win = null));
}

function showWindow() {
  if (!win) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// 受信側 (Windows) を常駐させるためのトレイアイコン
function createTray() {
  if (tray || role !== 'receiver') return;

  let image = nativeImage.createFromPath(helperPath('icon.png'));
  if (!image.isEmpty()) image = image.resize({ width: 16, height: 16 });

  tray = new Tray(image);
  tray.setToolTip('LaptopDisplay');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'ウィンドウを表示', click: showWindow },
      { type: 'separator' },
      {
        label: '終了',
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ])
  );
  tray.on('double-click', showWindow);
}

function startSenderServices() {
  startSignaling({
    port: SIGNAL_PORT,
    publicDir: path.join(__dirname, 'public'),
    onPeerChange: (peers) => {
      peerState = peers;
      if (win) win.webContents.send('peers-changed', peers);
    },
    onInput: handleRemoteInput,
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
    displayId: s.display_id || null,
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

// ---- カーソルを各ディスプレイの中央へ飛ばす ----
// 画面が 3 枚になるとカーソルを見失いやすいので、ホットキーで移動できるようにする。
// 移動先では一瞬リングを描いて位置を分かりやすくする。

const RING_SIZE = 180;
const RING_HTML = `<!DOCTYPE html><meta charset="utf-8">
<style>
  html, body { margin: 0; background: transparent; overflow: hidden; }
  #ring {
    position: absolute; inset: 6px; border-radius: 50%;
    border: 6px solid rgba(79, 140, 255, 0.95);
    box-shadow: 0 0 20px rgba(79, 140, 255, 0.85);
    opacity: 0;
  }
  #ring.go { animation: pulse 0.6s ease-out forwards; }
  @keyframes pulse {
    0%   { transform: scale(0.25); opacity: 0; }
    25%  { opacity: 1; }
    100% { transform: scale(1); opacity: 0; }
  }
</style>
<div id="ring"></div>
<script>
  function restart() {
    const el = document.getElementById('ring');
    el.classList.remove('go');
    void el.offsetWidth; // アニメーションを巻き戻すために再計算させる
    el.classList.add('go');
  }
  restart();
</script>`;

let ringWin = null;
let ringTimer = null;
let cursorHotkeys = [];

function helperPath(name) {
  return app.isPackaged
    ? path.join(process.resourcesPath, name)
    : path.join(__dirname, 'build', name);
}

function warpCursor(x, y) {
  if (process.platform !== 'darwin') return;
  try {
    execFileSync(helperPath('CursorMove'), [String(Math.round(x)), String(Math.round(y))], {
      timeout: 2000,
    });
  } catch (err) {
    console.error('カーソルを移動できませんでした:', err.message);
  }
}

function showRing(x, y) {
  if (!ringWin) {
    ringWin = new BrowserWindow({
      width: RING_SIZE,
      height: RING_SIZE,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      webPreferences: { backgroundThrottling: false },
    });
    ringWin.setIgnoreMouseEvents(true);
    ringWin.setAlwaysOnTop(true, 'screen-saver');
    ringWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(RING_HTML));
    ringWin.on('closed', () => (ringWin = null));
  }

  ringWin.setBounds({
    x: Math.round(x - RING_SIZE / 2),
    y: Math.round(y - RING_SIZE / 2),
    width: RING_SIZE,
    height: RING_SIZE,
  });
  ringWin.showInactive();
  ringWin.webContents.executeJavaScript('restart()').catch(() => {});

  clearTimeout(ringTimer);
  ringTimer = setTimeout(() => {
    if (ringWin && !ringWin.isDestroyed()) ringWin.hide();
  }, 700);
}

// 本体 (メイン) を先頭にし、残りは左から右の順に並べる。
// 「1 回タップ = メイン」を安定させるため、番号指定はこの順序を使う。
function orderedDisplays() {
  const primary = screen.getPrimaryDisplay();
  const rest = screen
    .getAllDisplays()
    .filter((d) => d.id !== primary.id)
    .sort((a, b) => a.bounds.x - b.bounds.x);
  return [primary, ...rest];
}

// target: 'next' で次のディスプレイ、数値でその番号のディスプレイ (0 始まり)
function cursorToDisplay(target) {
  const displays = orderedDisplays();
  if (displays.length < 2) return;

  let dest;
  if (target === 'next') {
    const current = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const index = displays.findIndex((d) => d.id === current.id);
    dest = displays[(index + 1) % displays.length];
  } else {
    dest = displays[target];
  }
  if (!dest) return;

  const x = dest.bounds.x + dest.bounds.width / 2;
  const y = dest.bounds.y + dest.bounds.height / 2;
  warpCursor(x, y);
  showRing(x, y);
}

// config: { enabled, cycle: 'Control+Alt+Tab', direct: ['Control+Alt+1', ...] }
function registerCursorHotkeys(config) {
  for (const accelerator of cursorHotkeys) {
    try {
      globalShortcut.unregister(accelerator);
    } catch {}
  }
  cursorHotkeys = [];

  const failed = [];
  const tryRegister = (accelerator, handler) => {
    if (!accelerator) return;
    try {
      if (globalShortcut.register(accelerator, handler)) cursorHotkeys.push(accelerator);
      else failed.push(accelerator);
    } catch {
      failed.push(accelerator);
    }
  };

  // 入力転送でカーソルを奪われるとマウスで解除できなくなるため、
  // 脱出用のキーはカーソル移動の設定に関わらず必ず登録する。
  tryRegister('Control+Alt+I', () => {
    inputConfig.enabled = false;
    stopInputInject();
    if (win) {
      win.webContents.send('input-control', { enabled: false, forced: true });
      showWindow();
    }
  });

  if (!config || !config.enabled) {
    return { ok: true, registered: cursorHotkeys, failed };
  }

  tryRegister(config.cycle, () => cursorToDisplay('next'));
  (config.direct || []).forEach((accelerator, i) => {
    tryRegister(accelerator, () => cursorToDisplay(i));
  });

  return { ok: failed.length === 0, registered: cursorHotkeys, failed };
}

// ---- 受信側 (Windows) のキーボード・マウスで Mac を操作する ----
// 受信側から送られてきた入力を CGEvent として再現する。
// 他アプリへイベントを送るためアクセシビリティの許可が必要。

let injectProc = null;
let inputConfig = { enabled: false, swapCtrlCommand: true, displayBounds: null };

function stopInputInject() {
  if (injectProc) {
    try {
      injectProc.stdin.write('q\n');
    } catch {}
    injectProc.kill();
    injectProc = null;
  }
}

function startInputInject() {
  if (injectProc || process.platform !== 'darwin') return;
  const child = spawn(helperPath('InputInject'), { stdio: ['pipe', 'ignore', 'pipe'] });
  child.on('error', (err) => {
    console.error('入力の再現を開始できませんでした:', err.message);
    injectProc = null;
  });
  child.on('exit', () => {
    if (injectProc === child) injectProc = null;
  });
  injectProc = child;
}

function sendInject(line) {
  if (!injectProc) return;
  try {
    injectProc.stdin.write(line + '\n');
  } catch {}
}

// 配信中の画面 (仮想ディスプレイ) の範囲。正規化座標をここに写す。
function inputTargetBounds() {
  if (inputConfig.displayBounds) return inputConfig.displayBounds;
  return screen.getPrimaryDisplay().bounds;
}

function toGlobalPoint(nx, ny) {
  const b = inputTargetBounds();
  const clamp = (v) => Math.max(0, Math.min(1, v));
  return {
    x: b.x + clamp(nx) * b.width,
    y: b.y + clamp(ny) * b.height,
  };
}

function handleRemoteInput(msg) {
  if (!inputConfig.enabled || !injectProc) return;

  if (msg.kind === 'move') {
    const p = toGlobalPoint(msg.x, msg.y);
    sendInject(`m ${p.x.toFixed(1)} ${p.y.toFixed(1)}`);
  } else if (msg.kind === 'button') {
    const p = toGlobalPoint(msg.x, msg.y);
    sendInject(`${msg.down ? 'd' : 'u'} ${msg.button | 0} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`);
  } else if (msg.kind === 'wheel') {
    sendInject(`s ${Math.round(msg.dy || 0)} ${Math.round(msg.dx || 0)}`);
  } else if (msg.kind === 'key') {
    const mods = remapModifiers(msg.mods || {}, inputConfig.swapCtrlCommand);
    const keycode = keycodeFor(msg.code, inputConfig.swapCtrlCommand);
    if (keycode === null) return;
    sendInject(`k ${keycode} ${msg.down ? 1 : 0} ${flagsFrom(mods)}`);
  }
}

ipcMain.handle('set-input-control', (_e, config) => {
  const enabled = !!(config && config.enabled);

  if (enabled && process.platform === 'darwin') {
    if (!systemPreferences.isTrustedAccessibilityClient(true)) {
      inputConfig.enabled = false;
      stopInputInject();
      return { enabled: false, error: 'permission' };
    }
  }

  inputConfig = {
    enabled,
    swapCtrlCommand: config && config.swapCtrlCommand !== false,
    displayBounds: (config && config.displayBounds) || null,
  };

  if (enabled) startInputInject();
  else stopInputInject();

  // 受信側に「入力を送ってよいか」を伝える
  const receiver = peerState.receiver;
  if (win) win.webContents.send('input-control', { enabled, receiver });
  return { enabled, error: null };
});

// 配信対象の画面から座標変換用の範囲を求める
ipcMain.handle('resolve-display-bounds', (_e, displayId) => {
  if (!displayId) return null;
  const display = screen.getAllDisplays().find((d) => String(d.id) === String(displayId));
  return display ? display.bounds : null;
});

app.on('will-quit', stopInputInject);

// ---- Option キーのタップでディスプレイを切り替える ----
// 1 回タップ = メイン (本体)、2 回 = 2 枚目、3 回 = 3 枚目。
// 修飾キー単独の押下は globalShortcut では取れないため、
// CGEventTap を使うヘルパーを常駐させて回数を受け取る。

let tapProc = null;
let tapStatus = { running: false, error: null };

function stopModifierTap() {
  if (tapProc) {
    tapProc.kill();
    tapProc = null;
  }
  tapStatus = { running: false, error: null };
}

function startModifierTap({ side = 'right', windowSec = 0.35 } = {}) {
  stopModifierTap();
  if (process.platform !== 'darwin') {
    tapStatus = { running: false, error: 'macOS でのみ使えます' };
    return tapStatus;
  }

  const child = spawn(helperPath('ModifierTap'), [side, String(windowSec)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const text = line.trim();
      if (text === 'ready') {
        tapStatus = { running: true, error: null };
        if (win) win.webContents.send('tap-status', tapStatus);
      } else if (text === 'error:permission') {
        tapStatus = { running: false, error: 'permission' };
        if (win) win.webContents.send('tap-status', tapStatus);
      } else if (text.startsWith('tap:')) {
        const count = parseInt(text.slice(4), 10);
        if (count >= 1) cursorToDisplay(count - 1);
      }
    }
  });

  child.on('error', (err) => {
    tapStatus = { running: false, error: err.message };
    if (win) win.webContents.send('tap-status', tapStatus);
  });
  child.on('exit', () => {
    if (tapProc === child) {
      tapProc = null;
      if (tapStatus.error === null) tapStatus = { running: false, error: 'exited' };
      if (win) win.webContents.send('tap-status', tapStatus);
    }
  });

  tapProc = child;
  return tapStatus;
}

ipcMain.handle('set-modifier-tap', (_e, config) => {
  if (!config || !config.enabled) {
    stopModifierTap();
    return { running: false, error: null };
  }
  return startModifierTap(config);
});

ipcMain.handle('get-tap-status', () => tapStatus);

// アクセシビリティ(入力監視)の許可状態。prompt=true で許可ダイアログを出す。
ipcMain.handle('check-accessibility', (_e, prompt) => {
  if (process.platform !== 'darwin') return true;
  try {
    return systemPreferences.isTrustedAccessibilityClient(!!prompt);
  } catch {
    return false;
  }
});

ipcMain.handle('open-accessibility-settings', () => {
  if (process.platform !== 'darwin') return;
  return shell.openExternal(
    'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
  );
});

app.on('will-quit', stopModifierTap);

ipcMain.handle('set-cursor-hotkeys', (_e, config) => registerCursorHotkeys(config));
ipcMain.handle('cursor-to-next-display', () => cursorToDisplay('next'));
ipcMain.handle('count-displays', () => screen.getAllDisplays().length);

app.on('will-quit', () => globalShortcut.unregisterAll());

// 仮想ディスプレイの配置 (左右上下) は macOS のディスプレイ設定で変更する
ipcMain.handle('open-display-settings', () => {
  if (process.platform !== 'darwin') return;
  return shell.openExternal('x-apple.systempreferences:com.apple.preference.displays');
});

ipcMain.handle('relaunch', () => {
  app.relaunch();
  app.exit(0);
});

ipcMain.handle('get-peers', () => peerState);

// OS のログイン時に自動起動する設定
ipcMain.handle('get-auto-launch', () => {
  try {
    return app.getLoginItemSettings().openAtLogin;
  } catch {
    return false;
  }
});

ipcMain.handle('set-auto-launch', (_e, enabled) => {
  try {
    app.setLoginItemSettings({ openAtLogin: !!enabled });
    return app.getLoginItemSettings().openAtLogin;
  } catch {
    return false;
  }
});

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

// 受信側は Mac 側で操作しているため入力が無く、放置と判断されて
// 画面が消えたりスリープに入ってしまう。表示中はそれを抑止する。
// 送信側は配信処理が省電力で間引かれるのを防ぐ。
let blockerId = null;
ipcMain.handle('set-streaming', (_e, on) => {
  if (on && blockerId === null) {
    blockerId = powerSaveBlocker.start(
      role === 'receiver' ? 'prevent-display-sleep' : 'prevent-app-suspension'
    );
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
  app.on('second-instance', showWindow);

  app.whenReady().then(() => {
    if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
    if (role === 'sender') startSenderServices();
    else startReceiverServices();
    createWindow();
    createTray();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  // 受信側はトレイに常駐させるため、ウィンドウが無くなっても終了しない
  app.on('window-all-closed', () => {
    if (role !== 'receiver' || isQuitting) app.quit();
  });

  app.on('before-quit', () => (isQuitting = true));
}
