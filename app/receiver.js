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
    ws.send(JSON.stringify({ type: 'hello', role: 'receiver' }));
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

if (window.native) {
  window.native.onSenderDiscovered((found) => {
    if (!wsAlive) connect({ ip: found.ip, port: found.port, hostLabel: found.host });
  });
}

manualBtn.onclick = () => {
  const ip = manualIp.value.trim();
  if (ip) connect({ ip, port: 3100 });
};
manualIp.addEventListener('keydown', (e) => { if (e.key === 'Enter') manualBtn.onclick(); });

// 前回つながった相手があれば、ブロードキャストを待たずにすぐ試す
const remembered = loadHost();
if (remembered) {
  manualIp.value = remembered.ip;
  connect(remembered);
} else {
  showOverlay('Mac 側 (LaptopDisplay) を探しています…');
}

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

// ---- ツールバーの自動非表示 ----
// マウスを動かしたときだけ出し、一定時間動かなければツールバーとカーソルを隠す。
// 全画面表示中に画面の端へマウスが乗っただけで出続けるのを防ぐ。

const IDLE_MS = 2000;
let idleTimer = null;

function revealChrome() {
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
  if (e.key === 'f' || e.key === 'F') setFullscreen();
  if (e.key === 'Escape') setFullscreen(false);
  if (e.key === 's' || e.key === 'S') statsBox.classList.toggle('show');
  if (e.key === 'z' || e.key === 'Z') cycleFit();
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
