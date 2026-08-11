// 受信側 UI — 送信側の自動発見・WebRTC 受信・統計表示

const stage = document.getElementById('stage');
const toolbar = document.getElementById('toolbar');
const video = document.getElementById('screen');
const overlay = document.getElementById('overlay');
const overlayMsg = document.getElementById('overlayMsg');
const manualIp = document.getElementById('manualIp');
const manualBtn = document.getElementById('manualBtn');
const srcName = document.getElementById('srcName');
const fsBtn = document.getElementById('fsBtn');
const fitBtn = document.getElementById('fitBtn');
const statsBtn = document.getElementById('statsBtn');
const statsBox = document.getElementById('stats');

// 一度つながった相手を覚えておき、次回起動時に自動で接続し直す。
// Tailscale や VPN 経由では UDP ブロードキャストが通らず自動発見が働かないため、
// 手動入力を毎回やらずに済むようにする。
const HOST_KEY = 'laptopdisplay.lasthost';

let ws = null;
let pc = null;
let currentHost = null; // { ip, port }
let wsAlive = false;
let statsTimer = null;
let lastBytes = 0;
let lastTs = 0;
let autoFullscreenDone = false;
let displayInfo = null; // { native, logical, scaleFactor, modes }

function showOverlay(msg) {
  overlay.classList.remove('hidden');
  overlayMsg.textContent = msg;
}

function saveHost(host) {
  try {
    localStorage.setItem(HOST_KEY, JSON.stringify({ ip: host.ip, port: host.port }));
  } catch {}
}

function loadHost() {
  try {
    const saved = JSON.parse(localStorage.getItem(HOST_KEY));
    if (saved && saved.ip) return { ip: saved.ip, port: saved.port || 3100 };
  } catch {}
  return null;
}

function connect(host) {
  currentHost = host;
  if (ws) { ws.onclose = null; ws.close(); }
  showOverlay(`${host.hostLabel || host.ip} に接続しています…`);

  let everOpened = false;
  ws = new WebSocket(`ws://${host.ip}:${host.port}`);
  ws.onopen = () => {
    wsAlive = true;
    everOpened = true;
    saveHost(host);
    // 自分の画面情報(実解像度と対応解像度の一覧)を送る。送信側が
    // 「この画面に合う解像度」の仮想ディスプレイを作れるようにするため。
    ws.send(JSON.stringify({
      type: 'hello',
      role: 'receiver',
      display: displayInfo,
      screen: {
        w: Math.round(window.screen.width * (window.devicePixelRatio || 1)),
        h: Math.round(window.screen.height * (window.devicePixelRatio || 1)),
      },
    }));
    showOverlay('Mac 側の配信開始を待っています…');
  };
  ws.onmessage = async (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'offer') {
      if (pc) pc.close();
      pc = new RTCPeerConnection();
      pc.onicecandidate = (e) => {
        if (e.candidate) ws.send(JSON.stringify({ type: 'ice', candidate: e.candidate }));
      };
      pc.ontrack = (e) => {
        // 受信バッファを最小化して表示遅延を削る (LAN 前提なので溜めない)
        try {
          e.receiver.jitterBufferTarget = 0;
          e.receiver.playoutDelayHint = 0;
        } catch {}
        video.srcObject = e.streams[0];
        overlay.classList.add('hidden');
        srcName.textContent = host.hostLabel ? `${host.hostLabel} から受信中` : `${host.ip} から受信中`;
        startStats();
        // この PC では誰も操作しないため、放置と判断されて画面が消えるのを防ぐ
        if (window.native) window.native.setStreaming(true);
        // ディスプレイとして使うのが目的なので、映像が届いたら全画面にする。
        // ユーザーが Esc で戻した場合は以降勝手に全画面にしない。
        if (!autoFullscreenDone) {
          autoFullscreenDone = true;
          setFullscreen(true);
        }
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
          showOverlay('接続が切れました。再接続を待っています…');
          if (window.native) window.native.setStreaming(false);
        }
      };
      await pc.setRemoteDescription(m.description);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      ws.send(JSON.stringify({ type: 'answer', description: pc.localDescription }));
    } else if (m.type === 'ice' && pc) {
      await pc.addIceCandidate(m.candidate).catch(() => {});
    } else if (m.type === 'sender-ready') {
      // 送信側が後から配信を始めた場合、こちらの存在を伝えてオファーを促す
      ws.send(JSON.stringify({ type: 'receiver-ready' }));
    } else if (m.type === 'peer-left') {
      showOverlay('Mac 側の配信終了を検知しました。再開を待っています…');
      if (window.native) window.native.setStreaming(false);
    }
  };
  ws.onclose = () => {
    wsAlive = false;
    showOverlay(
      everOpened
        ? '接続が切れました。再接続しています…'
        : `${host.ip} に届きません。IP を確認してください(再試行中)`
    );
    setTimeout(() => { if (currentHost && !wsAlive) connect(currentHost); }, 2000);
  };
}

// ---- 自動発見(Electron のみ)/ 手動接続 ----

manualBtn.onclick = () => {
  const ip = manualIp.value.trim();
  if (ip) connect({ ip, port: 3100 });
};
manualIp.addEventListener('keydown', (e) => { if (e.key === 'Enter') manualBtn.onclick(); });

// 画面情報を先に取得してから接続を始める(hello に含めて送るため)
(async () => {
  if (window.native) {
    try {
      displayInfo = await window.native.getDisplayInfo();
    } catch {}

    // ログイン時の自動起動 (常駐)
    const row = document.getElementById('autoLaunchRow');
    const chk = document.getElementById('autoLaunchChk');
    row.style.display = 'flex';
    chk.checked = await window.native.getAutoLaunch();
    chk.onchange = async () => {
      chk.checked = await window.native.setAutoLaunch(chk.checked);
    };
    window.native.onSenderDiscovered((found) => {
      if (!wsAlive) connect({ ip: found.ip, port: found.port, hostLabel: found.host });
    });
  }

  // 前回つながった相手があれば、ブロードキャストを待たずにすぐ試す
  const remembered = loadHost();
  if (remembered) {
    manualIp.value = remembered.ip;
    connect(remembered);
  } else {
    showOverlay('Mac 側 (LaptopDisplay) を探しています…');
  }
})();

// ---- 表示の合わせ方 ----
// Mac 側と Windows 側で画面の縦横比が違うと、そのままでは上下(または左右)に
// 黒帯が出る。用途に応じて切り替えられるようにする。
const FIT_KEY = 'laptopdisplay.fit';
const FIT_MODES = [
  { key: 'contain', label: '合わせる', cls: '' },
  { key: 'cover', label: '画面いっぱい', cls: 'fit-cover' },
  { key: 'fill', label: '引き伸ばす', cls: 'fit-fill' },
];
let fitIndex = 0;

function applyFit() {
  const mode = FIT_MODES[fitIndex];
  video.classList.remove('fit-cover', 'fit-fill');
  if (mode.cls) video.classList.add(mode.cls);
  fitBtn.textContent = `表示: ${mode.label} (Z)`;
  try {
    localStorage.setItem(FIT_KEY, mode.key);
  } catch {}
}

function cycleFit() {
  fitIndex = (fitIndex + 1) % FIT_MODES.length;
  applyFit();
}

const savedFit = (() => {
  try {
    return localStorage.getItem(FIT_KEY);
  } catch {
    return null;
  }
})();
if (savedFit) {
  const i = FIT_MODES.findIndex((m) => m.key === savedFit);
  if (i >= 0) fitIndex = i;
}
applyFit();
fitBtn.onclick = cycleFit;

// ---- Mac を操作する (キーボード・マウスの転送) ----
// この PC で打ったキーやマウス操作を Mac 側に送る。F9 でオン/オフ。
// Mac 側でも「操作を受け付ける」をオンにしておく必要がある。

let inputSending = false;
let lastMoveSentAt = 0;

function sendInput(payload) {
  if (!inputSending || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'input', ...payload }));
}

// 映像は object-fit で余白が付くため、映像内の相対位置を求める
function normalizedPoint(event) {
  const rect = video.getBoundingClientRect();
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh || !rect.width || !rect.height) return null;

  const mode = FIT_MODES[fitIndex].key;
  let drawW = rect.width;
  let drawH = rect.height;
  if (mode === 'contain') {
    const scale = Math.min(rect.width / vw, rect.height / vh);
    drawW = vw * scale;
    drawH = vh * scale;
  } else if (mode === 'cover') {
    const scale = Math.max(rect.width / vw, rect.height / vh);
    drawW = vw * scale;
    drawH = vh * scale;
  }
  const offsetX = (rect.width - drawW) / 2;
  const offsetY = (rect.height - drawH) / 2;

  const x = (event.clientX - rect.left - offsetX) / drawW;
  const y = (event.clientY - rect.top - offsetY) / drawH;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y };
}

function setInputSending(on) {
  inputSending = on;
  stage.style.cursor = on ? 'none' : '';
  showToast(on
    ? 'Mac を操作するモード:オン(F9 で解除)'
    : 'Mac を操作するモード:オフ');
}

function showToast(text) {
  const previous = srcName.textContent;
  srcName.textContent = text;
  toolbar.classList.add('show');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    toolbar.classList.remove('show');
    srcName.textContent = previous;
  }, 2500);
}

document.addEventListener('mousemove', (e) => {
  if (!inputSending) return;
  const now = performance.now();
  if (now - lastMoveSentAt < 8) return; // 最大 125Hz に間引く
  lastMoveSentAt = now;
  const p = normalizedPoint(e);
  if (p) sendInput({ kind: 'move', x: p.x, y: p.y });
});

document.addEventListener('mousedown', (e) => {
  if (!inputSending) return;
  const p = normalizedPoint(e);
  if (!p) return;
  e.preventDefault();
  sendInput({ kind: 'button', button: e.button, down: true, x: p.x, y: p.y });
});

document.addEventListener('mouseup', (e) => {
  if (!inputSending) return;
  const p = normalizedPoint(e);
  if (!p) return;
  e.preventDefault();
  sendInput({ kind: 'button', button: e.button, down: false, x: p.x, y: p.y });
});

document.addEventListener('contextmenu', (e) => {
  if (inputSending) e.preventDefault();
});

document.addEventListener(
  'wheel',
  (e) => {
    if (!inputSending) return;
    e.preventDefault();
    sendInput({
      kind: 'wheel',
      dy: -Math.sign(e.deltaY) * Math.min(10, Math.ceil(Math.abs(e.deltaY) / 40)),
      dx: -Math.sign(e.deltaX) * Math.min(10, Math.ceil(Math.abs(e.deltaX) / 40)),
    });
  },
  { passive: false }
);

function forwardKey(e, down) {
  // F9 は転送せず、モードの切り替えに使う
  if (e.code === 'F9') {
    if (down) setInputSending(!inputSending);
    e.preventDefault();
    return true;
  }
  if (!inputSending) return false;
  e.preventDefault();
  sendInput({
    kind: 'key',
    code: e.code,
    down,
    mods: { shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey },
  });
  return true;
}

// ---- ツールバーの自動非表示 ----
// マウスを動かしたときだけ出し、一定時間動かなければツールバーとカーソルを隠す。
// 全画面表示中に画面の端へマウスが乗っただけで出続けるのを防ぐ。

const IDLE_MS = 2000;
let idleTimer = null;

function revealChrome() {
  // Mac を操作している間はマウスを動かすたびに出ると邪魔なので出さない
  if (inputSending) return;
  toolbar.classList.add('show');
  stage.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    toolbar.classList.remove('show');
    stage.classList.add('idle');
  }, IDLE_MS);
}

document.addEventListener('mousemove', revealChrome);
stage.classList.add('idle');

// ---- 全画面・統計 ----

async function setFullscreen(desired) {
  if (window.native) return window.native.toggleFullscreen(desired);
  if (desired === false) return document.exitFullscreen();
  if (desired === true) return document.documentElement.requestFullscreen();
  if (document.fullscreenElement) return document.exitFullscreen();
  return document.documentElement.requestFullscreen();
}
fsBtn.onclick = () => setFullscreen();
document.addEventListener('dblclick', () => setFullscreen());
document.addEventListener('keydown', (e) => {
  // IP 入力中のキー入力はショートカットとして扱わない
  if (e.target instanceof HTMLInputElement) return;
  // 転送モード中は F9 以外すべて Mac 側へ送る
  if (forwardKey(e, true)) return;
  if (e.key === 'f' || e.key === 'F') setFullscreen();
  if (e.key === 'Escape') setFullscreen(false);
  if (e.key === 's' || e.key === 'S') statsBox.classList.toggle('show');
  if (e.key === 'z' || e.key === 'Z') cycleFit();
});

document.addEventListener('keyup', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  forwardKey(e, false);
});
statsBtn.onclick = () => statsBox.classList.toggle('show');

function startStats() {
  clearInterval(statsTimer);
  lastBytes = 0;
  lastTs = 0;
  statsTimer = setInterval(async () => {
    if (!pc) return;
    document.getElementById('stView').textContent =
      `${window.innerWidth}×${window.innerHeight}`;
    const report = await pc.getStats();
    for (const stat of report.values()) {
      if (stat.type === 'inbound-rtp' && stat.kind === 'video') {
        document.getElementById('stRes').textContent =
          stat.frameWidth ? `${stat.frameWidth}×${stat.frameHeight}` : '—';
        document.getElementById('stFps').textContent =
          stat.framesPerSecond ? `${stat.framesPerSecond} fps` : '—';
        if (lastTs && stat.bytesReceived > lastBytes) {
          const mbps = ((stat.bytesReceived - lastBytes) * 8) / ((stat.timestamp - lastTs) / 1000) / 1e6;
          document.getElementById('stBr').textContent = `${mbps.toFixed(1)} Mbps`;
        }
        lastBytes = stat.bytesReceived;
        lastTs = stat.timestamp;
      }
      if (stat.type === 'candidate-pair' && stat.state === 'succeeded' && stat.currentRoundTripTime != null) {
        document.getElementById('stRtt').textContent = `${Math.round(stat.currentRoundTripTime * 1000)} ms`;
      }
    }
  }, 1000);
}
