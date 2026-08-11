// 受信側 UI — 送信側の自動発見・WebRTC 受信・統計表示

const video = document.getElementById('screen');
const overlay = document.getElementById('overlay');
const overlayMsg = document.getElementById('overlayMsg');
const manualIp = document.getElementById('manualIp');
const manualBtn = document.getElementById('manualBtn');
const srcName = document.getElementById('srcName');
const fsBtn = document.getElementById('fsBtn');
const statsBtn = document.getElementById('statsBtn');
const statsBox = document.getElementById('stats');

let ws = null;
let pc = null;
let currentHost = null; // { ip, port }
let wsAlive = false;
let statsTimer = null;
let lastBytes = 0;
let lastTs = 0;

function showOverlay(msg) {
  overlay.classList.remove('hidden');
  overlayMsg.textContent = msg;
}

function connect(host) {
  currentHost = host;
  if (ws) { ws.onclose = null; ws.close(); }
  showOverlay(`${host.hostLabel || host.ip} に接続しています…`);

  ws = new WebSocket(`ws://${host.ip}:${host.port}`);
  ws.onopen = () => {
    wsAlive = true;
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
    showOverlay('接続が切れました。再接続しています…');
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

// ---- 全画面・統計 ----

async function toggleFullscreen() {
  if (window.native) await window.native.toggleFullscreen();
  else if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen();
}
fsBtn.onclick = toggleFullscreen;
document.addEventListener('dblclick', toggleFullscreen);
document.addEventListener('keydown', (e) => {
  if (e.key === 'f' || e.key === 'F') toggleFullscreen();
  if (e.key === 's' || e.key === 'S') statsBox.classList.toggle('show');
});
statsBtn.onclick = () => statsBox.classList.toggle('show');

function startStats() {
  clearInterval(statsTimer);
  lastBytes = 0;
  lastTs = 0;
  statsTimer = setInterval(async () => {
    if (!pc) return;
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
