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
const permWarn = document.getElementById('permWarn');
const permWarnText = document.getElementById('permWarnText');
const permOpenBtn = document.getElementById('permOpenBtn');
const permRelaunchBtn = document.getElementById('permRelaunchBtn');
const permResetBtn = document.getElementById('permResetBtn');

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
let selectedDisplayId = null;
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

// 画面収録の権限が無いと一覧が空になったりサムネイルが真っ黒になる。
// アプリを更新すると署名が変わって権限が無効に戻るため、原因と直し方を明示する。
async function checkScreenPermission(sources) {
  if (info.platform !== 'darwin') return;
  const status = await window.native.getScreenPermission();
  const noSources = !sources.some((s) => s.kind === 'screen');
  const noThumbs = sources.length > 0 && sources.every((s) => !s.thumb);

  if (status === 'granted' && !noSources && !noThumbs) {
    permWarn.style.display = 'none';
    return;
  }

  permWarn.style.display = '';
  permWarnText.textContent =
    status === 'granted'
      ? 'システム上は許可済みですが画面を取得できていません。アプリを更新すると署名が変わり、以前の許可が無効になることがあります。設定で LaptopDisplay を一度削除(−)してから、下の「再起動」を押して許可し直してください。'
      : '「画面収録」で LaptopDisplay を許可してください。許可のあとアプリを再起動しないと反映されません。';
}

permOpenBtn.onclick = () => window.native.openScreenSettings();
permRelaunchBtn.onclick = () => window.native.relaunch();

// 更新後に失効した許可を消してから再起動する。再起動後の初回起動で
// 権限のダイアログが出るので、そこで許可すれば復帰できる。
permResetBtn.onclick = async () => {
  permResetBtn.disabled = true;
  permWarnText.textContent = '権限をリセットして再起動します…';
  const res = await window.native.resetScreenPermission();
  if (!res.ok) {
    permResetBtn.disabled = false;
    permWarnText.textContent = `リセットできませんでした: ${res.error}`;
  }
};

async function refreshSources() {
  const sources = await window.native.getSources();
  await checkScreenPermission(sources);
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
      selectedDisplayId = s.displayId || null;
      startBtn.disabled = false;
      // 配信対象が変わると座標の対応付けも変わるので入力設定を作り直す
      if (inputEnabled.checked) applyInputControl();
      castSub.textContent = streaming ? '選択を変えるには一度停止してください' : '「配信を開始」を押してください';
      refreshSources();
    };
    sourceGrid.appendChild(tile);
  }

  if (!sources.length) {
    const empty = document.createElement('div');
    empty.className = 'status-sub';
    empty.textContent =
      '配信できる画面が見つかりませんでした。上の案内にしたがって画面収録を許可してください。';
    sourceGrid.appendChild(empty);
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
const vdArrangeBtn = document.getElementById('vdArrangeBtn');
let vdActive = false;

vdArrangeBtn.onclick = () => window.native.openDisplaySettings();

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

  // 解像度の意味づけは、パネルの実解像度に対する倍率で決まる。
  // Retina パネルを等倍(倍率 1.0)で使うと文字が小さすぎて実用にならないため、
  // macOS のディスプレイ設定と同じ考え方(標準 / スペースを拡大)で表示する。
  const label = (m) => {
    const scale = native.w / m.w;
    if (scale < 1.15) return '等倍 — 文字がかなり小さい・負荷高';
    if (scale < 1.45) return '広い — 文字は小さめ';
    if (scale < 1.65) return 'スペースを拡大 — 作業領域が広い';
    if (scale < 1.95) return '標準 — 文字が読みやすい';
    return '大きく表示 — 文字が大きい';
  };

  // 「スペースを拡大」相当(倍率 1.5 に最も近いもの)を既定にする
  const recommended = modes.reduce((best, m) =>
    Math.abs(native.w / m.w - 1.5) < Math.abs(native.w / best.w - 1.5) ? m : best
  );

  const group = document.createElement('optgroup');
  group.dataset.auto = '1';
  group.label = '受信側 (Windows) の画面に合う解像度';

  for (const m of modes) {
    const opt = document.createElement('option');
    opt.value = `${m.w}x${m.h}`;
    const suffix = m === recommended ? ' ★推奨' : '';
    opt.textContent = `${m.w} × ${m.h} (${label(m)})${suffix}`;
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

// ---- カーソル移動のホットキー ----

const CURSOR_KEY = 'laptopdisplay.cursorhotkey';
const cursorCard = document.getElementById('cursorCard');
const curEnabled = document.getElementById('curEnabled');
const curCycleKey = document.getElementById('curCycleKey');
const curSaveBtn = document.getElementById('curSaveBtn');
const curTestBtn = document.getElementById('curTestBtn');
const curSub = document.getElementById('curSub');

async function applyCursorHotkeys(showResult = true) {
  const config = {
    enabled: curEnabled.checked,
    cycle: curCycleKey.value.trim(),
    direct: ['Control+Alt+1', 'Control+Alt+2', 'Control+Alt+3'],
  };
  try {
    localStorage.setItem(CURSOR_KEY, JSON.stringify({ enabled: config.enabled, cycle: config.cycle }));
  } catch {}

  const res = await window.native.setCursorHotkeys(config);
  if (!showResult) return;

  if (!config.enabled) {
    curSub.textContent = 'ホットキーは無効です';
  } else if (res.failed && res.failed.length) {
    curSub.textContent =
      `登録できなかったキー: ${res.failed.join(', ')} — 他のアプリと競合している可能性があります`;
  } else {
    const displays = await window.native.countDisplays();
    curSub.textContent =
      `${curCycleKey.value.trim()} で移動できます(現在のディスプレイ数: ${displays})` +
      (displays < 2 ? ' — 画面が 1 枚のときは動きません' : '');
  }
}

curSaveBtn.onclick = () => applyCursorHotkeys();
curEnabled.onchange = () => applyCursorHotkeys();
curCycleKey.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') applyCursorHotkeys();
});
curTestBtn.onclick = () => window.native.cursorToNextDisplay();

// ---- Windows 側からの操作を受け付ける ----

const INPUT_KEY = 'laptopdisplay.inputcontrol';
const inputCard = document.getElementById('inputCard');
const inputEnabled = document.getElementById('inputEnabled');
const inputSwap = document.getElementById('inputSwap');
const inputPermBtn = document.getElementById('inputPermBtn');
const inputSub = document.getElementById('inputSub');

async function applyInputControl() {
  // 配信対象が画面でない場合は座標を対応付けられない
  let displayBounds = null;
  if (selectedDisplayId) {
    displayBounds = await window.native.resolveDisplayBounds(selectedDisplayId);
  }

  const config = {
    enabled: inputEnabled.checked,
    swapCtrlCommand: inputSwap.checked,
    displayBounds,
  };
  try {
    localStorage.setItem(
      INPUT_KEY,
      JSON.stringify({ enabled: config.enabled, swapCtrlCommand: config.swapCtrlCommand })
    );
  } catch {}

  const res = await window.native.setInputControl(config);
  inputEnabled.checked = res.enabled;
  inputPermBtn.style.display = res.error === 'permission' ? '' : 'none';

  if (res.error === 'permission') {
    inputSub.textContent =
      'アクセシビリティの許可がありません。許可したあとアプリを再起動して、もう一度オンにしてください。';
  } else if (!res.enabled) {
    inputSub.textContent = 'Windows 側からの操作は受け付けません';
  } else if (!displayBounds) {
    inputSub.textContent =
      '受け付け中ですが、配信対象が画面ではないため座標を対応付けられません。画面(仮想ディスプレイなど)を選んでください。';
  } else {
    inputSub.textContent =
      `受け付け中(${displayBounds.width}×${displayBounds.height} の範囲に対応付け)。` +
      'Windows 側の画面上でタイプ・クリックできます。';
  }
}

inputEnabled.onchange = applyInputControl;
inputSwap.onchange = () => {
  if (inputEnabled.checked) applyInputControl();
};
inputPermBtn.onclick = () => window.native.openAccessibilitySettings();

async function initInputControl() {
  // 入力受付はカーソルを奪う可能性があるため、起動時は必ずオフから始める。
  // (前回オンのまま復元すると、Mac 側を操作できない状態で起動しかねない)
  inputEnabled.checked = false;
  try {
    const saved = JSON.parse(localStorage.getItem(INPUT_KEY));
    if (saved && typeof saved.swapCtrlCommand === 'boolean') {
      inputSwap.checked = saved.swapCtrlCommand;
    }
  } catch {}
  await applyInputControl();
}

// 脱出用ホットキー (Control+Alt+I) で強制解除されたときに UI を合わせる
window.native.onInputControl((state) => {
  inputEnabled.checked = !!state.enabled;
  if (state.forced) {
    inputSub.textContent =
      'Control+Alt+I で強制的に解除しました。Windows 側からの操作は受け付けません。';
  }
});

// ---- Option キーのタップで切り替え ----

const TAP_KEY = 'laptopdisplay.modifiertap';
const tapEnabled = document.getElementById('tapEnabled');
const tapSide = document.getElementById('tapSide');
const tapPermBtn = document.getElementById('tapPermBtn');
const tapSub = document.getElementById('tapSub');

function describeTapStatus(status) {
  if (!tapEnabled.checked) {
    tapPermBtn.style.display = 'none';
    return 'Option タップは無効です';
  }
  if (status.running) {
    tapPermBtn.style.display = 'none';
    const side = tapSide.options[tapSide.selectedIndex].textContent;
    return `${side} のタップで移動できます(1 回 = 本体、2 回 = 2 枚目、3 回 = 3 枚目)`;
  }
  if (status.error === 'permission') {
    tapPermBtn.style.display = '';
    return 'アクセシビリティの許可がありません。許可したあと、この設定をもう一度オンにしてください。';
  }
  tapPermBtn.style.display = '';
  return `キー監視を開始できませんでした${status.error ? ` (${status.error})` : ''}`;
}

async function applyModifierTap() {
  const config = { enabled: tapEnabled.checked, side: tapSide.value, windowSec: 0.35 };
  try {
    localStorage.setItem(TAP_KEY, JSON.stringify(config));
  } catch {}

  if (config.enabled) {
    // 許可が無い場合はここでダイアログを出す
    const trusted = await window.native.checkAccessibility(true);
    if (!trusted) {
      tapSub.textContent =
        'アクセシビリティの許可が必要です。設定で LaptopDisplay を許可し、アプリを再起動してからもう一度オンにしてください。';
      tapPermBtn.style.display = '';
      return;
    }
  }

  const status = await window.native.setModifierTap(config);
  tapSub.textContent = describeTapStatus(status);
}

tapEnabled.onchange = applyModifierTap;
tapSide.onchange = () => {
  if (tapEnabled.checked) applyModifierTap();
};
tapPermBtn.onclick = () => window.native.openAccessibilitySettings();

window.native.onTapStatus((status) => {
  tapSub.textContent = describeTapStatus(status);
});

async function initModifierTap() {
  try {
    const saved = JSON.parse(localStorage.getItem(TAP_KEY));
    if (saved) {
      tapEnabled.checked = !!saved.enabled;
      if (saved.side) tapSide.value = saved.side;
    }
  } catch {}

  if (!tapEnabled.checked) {
    tapSub.textContent = describeTapStatus({ running: false, error: null });
    return;
  }
  const status = await window.native.setModifierTap({
    enabled: true,
    side: tapSide.value,
    windowSec: 0.35,
  });
  tapSub.textContent = describeTapStatus(status);
}

async function initCursorHotkeys() {
  try {
    const saved = JSON.parse(localStorage.getItem(CURSOR_KEY));
    if (saved) {
      if (typeof saved.enabled === 'boolean') curEnabled.checked = saved.enabled;
      if (saved.cycle) curCycleKey.value = saved.cycle;
    }
  } catch {}
  await applyCursorHotkeys();
}

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
      selectedDisplayId = found.displayId || null;
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
    cursorCard.style.display = '';
    await initCursorHotkeys();
    await initModifierTap();
    inputCard.style.display = '';
    await initInputControl();
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

  const loginChk = document.getElementById('loginChk');
  loginChk.checked = await window.native.getAutoLaunch();
  loginChk.onchange = async () => {
    loginChk.checked = await window.native.setAutoLaunch(loginChk.checked);
  };

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
