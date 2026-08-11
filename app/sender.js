// 送信側 UI — 画面選択・WebRTC 配信・画質制御

const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const statusSub = document.getElementById('statusSub');
const sourceGrid = document.getElementById('sourceGrid');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const castSub = document.getElementById('castSub');
const urlRow = document.getElementById('urlRow');
const qualitySeg = document.getElementById('qualitySeg');
const autoChk = document.getElementById('autoChk');

// おまかせ起動: 前回配信時の構成を保存し、次回起動時に自動で再現する
const PREF_KEY = 'laptopdisplay.autocast';

// 画質プリセット: エンコーダへのヒットと上限ビットレート
const QUALITY = {
  text: { hint: 'detail', degrade: 'maintain-resolution', maxBitrate: 15_000_000 },
  balanced: { hint: 'detail', degrade: 'balanced', maxBitrate: 25_000_000 },
  motion: { hint: 'motion', degrade: 'maintain-framerate', maxBitrate: 35_000_000 },
};

let info = null;
let ws = null;
let pc = null;
let stream = null;
let selectedId = null;
let selectedName = null;
let quality = 'text';
let streaming = false;
let receiverConnected = false;
let refreshTimer = null;

function setStatus(state, text, sub = '') {
  statusDot.className = `dot ${state}`;
  statusText.textContent = text;
  statusSub.textContent = sub;
}

function updateStatus() {
  if (!streaming) {
    setStatus('wait', '待機中', receiverConnected ? '受信側は接続済みです。配信を開始してください' : '受信側の起動を待っています');
  } else if (receiverConnected) {
    setStatus('ok', '配信中', '受信側に映像を送信しています');
  } else {
    setStatus('wait', '配信準備完了', '受信側の接続を待っています…');
  }
}

// ---- 画面一覧 ----

async function refreshSources() {
  const sources = await window.native.getSources();
  sourceGrid.innerHTML = '';
  for (const s of sources) {
    const tile = document.createElement('button');
    tile.className = 'tile' + (s.id === selectedId ? ' selected' : '');
    tile.innerHTML = s.thumb
      ? `<img src="${s.thumb}" alt="">`
      : `<div class="placeholder">プレビューなし</div>`;
    const label = document.createElement('div');
    label.className = 'label';
    const kind = document.createElement('span');
    kind.className = 'kind';
    kind.textContent = s.kind === 'screen' ? '画面' : 'ウィンドウ';
    label.appendChild(kind);
    label.appendChild(document.createTextNode(s.name));
    tile.appendChild(label);
    tile.onclick = () => {
      selectedId = s.id;
      selectedName = s.name;
      startBtn.disabled = false;
      castSub.textContent = streaming ? '選択を変えるには一度停止してください' : '「配信を開始」を押してください';
      refreshSources();
    };
    sourceGrid.appendChild(tile);
  }
}

// ---- シグナリング ----

function connectSignaling() {
  ws = new WebSocket(`ws://localhost:${info.port}`);
  ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', role: 'sender' }));
  ws.onmessage = async (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'receiver-ready' && stream) await startPeer();
    else if (msg.type === 'answer' && pc) await pc.setRemoteDescription(msg.description);
    else if (msg.type === 'ice' && pc) await pc.addIceCandidate(msg.candidate).catch(() => {});
  };
  ws.onclose = () => setTimeout(connectSignaling, 1500);
}

async function startPeer() {
  if (pc) pc.close();
  pc = new RTCPeerConnection();
  for (const track of stream.getTracks()) pc.addTrack(track, stream);
  preferH264();
  applyQuality();
  pc.onicecandidate = (e) => {
    if (e.candidate) ws.send(JSON.stringify({ type: 'ice', candidate: e.candidate }));
  };
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  ws.send(JSON.stringify({ type: 'offer', description: pc.localDescription }));
}

// H.264 を最優先にする。Mac/Windows ともハードウェア処理できるため
// エンコード/デコード遅延と CPU 負荷が下がる
function preferH264() {
  try {
    const codecs = RTCRtpSender.getCapabilities('video').codecs;
    const h264 = codecs.filter((c) => /h264/i.test(c.mimeType));
    if (!h264.length) return;
    const rest = codecs.filter((c) => !/h264/i.test(c.mimeType));
    for (const t of pc.getTransceivers()) {
      if (t.sender?.track?.kind === 'video' && t.setCodecPreferences) {
        t.setCodecPreferences([...h264, ...rest]);
      }
    }
  } catch {}
}

function applyQuality() {
  const q = QUALITY[quality];
  if (stream) stream.getVideoTracks()[0].contentHint = q.hint;
  if (!pc) return;
  for (const sender of pc.getSenders()) {
    if (!sender.track || sender.track.kind !== 'video') continue;
    const params = sender.getParameters();
    params.degradationPreference = q.degrade;
    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
    params.encodings[0].maxBitrate = q.maxBitrate;
    sender.setParameters(params).catch(() => {});
  }
}

// ---- 配信開始 / 停止 ----

function savePrefs() {
  localStorage.setItem(PREF_KEY, JSON.stringify({
    sourceName: selectedName,
    quality,
    vd: vdActive,
    vdRes: vdRes.value,
  }));
}

async function startCast() {
  if (!selectedId) return;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: selectedId,
          maxFrameRate: 60,
        },
      },
    });
  } catch (err) {
    castSub.textContent = `画面を取得できませんでした: ${err.message}`;
    return;
  }
  streaming = true;
  window.native.setStreaming(true);
  applyQuality();
  stream.getVideoTracks()[0].onended = stopCast;
  startBtn.style.display = 'none';
  stopBtn.style.display = '';
  castSub.textContent = '';
  clearInterval(refreshTimer);
  if (autoChk.checked) savePrefs();
  if (receiverConnected) ws.send(JSON.stringify({ type: 'sender-ready' }));
  updateStatus();
}
startBtn.onclick = startCast;

autoChk.addEventListener('change', () => {
  if (!autoChk.checked) localStorage.removeItem(PREF_KEY);
  else if (streaming) savePrefs();
});

function stopCast() {
  streaming = false;
  window.native.setStreaming(false);
  if (pc) { pc.close(); pc = null; }
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  startBtn.style.display = '';
  stopBtn.style.display = 'none';
  castSub.textContent = '画面を選択すると開始できます';
  refreshTimer = setInterval(refreshSources, 5000);
  updateStatus();
}
stopBtn.onclick = stopCast;

// ---- 仮想ディスプレイ (macOS のみ) ----

const vdCard = document.getElementById('vdCard');
const vdBtn = document.getElementById('vdBtn');
const vdRes = document.getElementById('vdRes');
const vdSub = document.getElementById('vdSub');
let vdActive = false;

function setVdUi(active, note = '') {
  vdActive = active;
  vdBtn.textContent = active ? '仮想ディスプレイを削除' : '仮想ディスプレイを作成';
  vdRes.disabled = active;
  vdSub.textContent = note || (active ? '作成済み — 一覧から「LaptopDisplay」を選んでください' : '');
}

// 受信側(Windows)の画面が対応している解像度を一覧の先頭にグループとして並べる。
// 縦横比がパネルと一致したものだけが届くので、選べば黒帯が出ない。
let autoResChosen = false;

function updateAutoResOption(display) {
  const oldGroup = vdRes.querySelector('optgroup[data-auto]');
  if (oldGroup) oldGroup.remove();
  if (!display || !display.native || !display.native.w) return;

  const native = display.native;
  const modes = (display.modes && display.modes.length ? display.modes : [native])
    .filter((m) => m.w > 0 && m.h > 0);

  // 負荷と精細さのバランスが良いもの(1920 幅以下で最大)を推奨にする
  const recommended = modes.find((m) => m.w <= 1920) || modes[modes.length - 1];

  const group = document.createElement('optgroup');
  group.dataset.auto = '1';
  group.label = '受信側 (Windows) の画面が対応する解像度';

  for (const m of modes) {
    const opt = document.createElement('option');
    opt.value = `${m.w}x${m.h}`;
    let note = '';
    if (m.w === native.w && m.h === native.h) {
      note = ' — 最適(等倍・最も精細)';
    } else if (recommended && m.w === recommended.w && m.h === recommended.h) {
      note = ' — 推奨(負荷が軽い)';
    }
    opt.textContent = `${m.w} × ${m.h}${note}`;
    group.appendChild(opt);
  }

  vdRes.prepend(group);

  // ユーザーが自分で選び直していなければ推奨を既定にする
  if (!autoResChosen && !vdActive && recommended) {
    vdRes.value = `${recommended.w}x${recommended.h}`;
  }
}

vdRes.addEventListener('change', () => {
  autoResChosen = true;
});

vdBtn.onclick = async () => {
  vdBtn.disabled = true;
  if (!vdActive) {
    const [w, h] = vdRes.value.split('x').map(Number);
    vdSub.textContent = '作成しています…';
    const res = await window.native.virtualDisplay({ on: true, width: w, height: h });
    if (res.ok) {
      setVdUi(true);
      setTimeout(refreshSources, 800);
    } else {
      setVdUi(false, `作成できませんでした: ${res.error}`);
    }
  } else {
    await window.native.virtualDisplay({ on: false });
    setVdUi(false);
    setTimeout(refreshSources, 800);
  }
  vdBtn.disabled = false;
};

// ---- 画質切り替え ----

qualitySeg.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-q]');
  if (!btn) return;
  quality = btn.dataset.q;
  for (const b of qualitySeg.querySelectorAll('button')) b.classList.toggle('active', b === btn);
  applyQuality();
  if (autoChk.checked && streaming) savePrefs();
});

function setQualityUi(q) {
  quality = q;
  for (const b of qualitySeg.querySelectorAll('button')) {
    b.classList.toggle('active', b.dataset.q === q);
  }
}

// ---- おまかせ起動 ----

async function tryAutoStart() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(PREF_KEY));
  } catch {}
  if (!saved || !saved.sourceName) return;

  autoChk.checked = true;
  castSub.textContent = '前回の構成で自動配信を準備しています…';
  if (saved.quality && QUALITY[saved.quality]) setQualityUi(saved.quality);

  // 前回仮想ディスプレイを使っていたなら先に再作成する
  if (saved.vd && info.platform === 'darwin') {
    const savedRes = /^\d+x\d+$/.test(saved.vdRes || '') ? saved.vdRes : '1920x1080';
    const [w, h] = savedRes.split('x').map(Number);
    // 保存された解像度が一覧になければ項目として足してから選ぶ
    if (![...vdRes.options].some((o) => o.value === savedRes)) {
      const opt = document.createElement('option');
      opt.value = savedRes;
      opt.textContent = `${w} × ${h}`;
      (vdRes.querySelector('#vdPresetGroup') || vdRes).prepend(opt);
    }
    vdRes.value = savedRes;
    autoResChosen = true; // 記憶した設定を自動項目で上書きしない
    const res = await window.native.virtualDisplay({ on: true, width: w, height: h });
    if (res.ok) setVdUi(true);
  }

  // 前回と同じ名前の画面が現れるまで少し待って探す (仮想ディスプレイの出現待ち)
  for (let attempt = 0; attempt < 10; attempt++) {
    const sources = await window.native.getSources();
    const found =
      sources.find((s) => s.name === saved.sourceName) ||
      (saved.vd ? sources.find((s) => s.name.includes('LaptopDisplay')) : null);
    if (found) {
      selectedId = found.id;
      selectedName = found.name;
      startBtn.disabled = false;
      await refreshSources();
      await startCast();
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  castSub.textContent = `前回の画面「${saved.sourceName}」が見つかりませんでした。手動で選択してください`;
}

// ---- 初期化 ----

(async () => {
  info = await window.native.getInfo();

  if (info.platform === 'darwin') {
    vdCard.style.display = '';
    window.native.onVirtualDisplayChanged((active) => {
      if (!active && vdActive) setVdUi(false, '仮想ディスプレイが終了しました');
    });
  }

  for (const ip of info.ips) {
    const code = document.createElement('code');
    code.textContent = `http://${ip}:${info.port}/receiver.html`;
    urlRow.appendChild(code);
  }
  const copyBtn = document.createElement('button');
  copyBtn.className = 'btn';
  copyBtn.textContent = 'コピー';
  copyBtn.onclick = async () => {
    await window.native.copyText(`http://${info.ips[0]}:${info.port}/receiver.html`);
    copyBtn.textContent = 'コピーしました';
    setTimeout(() => (copyBtn.textContent = 'コピー'), 1500);
  };
  if (info.ips.length) urlRow.appendChild(copyBtn);

  window.native.onPeersChanged((peers) => {
    receiverConnected = peers.receiver;
    updateAutoResOption(peers.receiverScreen);
    updateStatus();
  });
  const peers = await window.native.getPeers();
  receiverConnected = peers.receiver;
  updateAutoResOption(peers.receiverScreen);

  connectSignaling();
  await refreshSources();
  refreshTimer = setInterval(refreshSources, 5000);
  updateStatus();
  await tryAutoStart();
})();
