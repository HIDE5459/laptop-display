# 仕様書・開発記録

## 1. プロジェクト概要

**LaptopDisplay** は、MacBook の画面を Windows ノート PC に低遅延ストリーミングし、
Windows ノートを「表示専用のセカンドモニタ」として使うためのデスクトップアプリ。

- 想定環境: MacBook Air (M4, 送信側) / MacBook Pro 2016 Boot Camp Windows 10 (受信側)
- 配布形式: Mac 用 `.dmg` (Apple Silicon) / Windows 用 `.exe` (x64, NSIS ワンクリックインストーラ)

## 2. 背景・経緯

「持ち歩いている 2 台のノート PC の片方をディスプレイにできないか」という相談から開始。

1. ノート PC の HDMI / USB-C ポートは映像出力専用のため、ケーブル直結での画面入力は不可能と整理
2. 既製品 (Duet Display / Deskreen / Luna Display) を検討したのち、WebRTC ベースの自作を決定
3. まずブラウザだけで動く最小構成 (`public/` + `server.js`) を実装
4. UI を作り込み dmg / exe で配布するため Electron アプリ化
5. 遅延低減チューニング、BetterDisplay 不要の仮想ディスプレイ内蔵、おまかせ起動を順次追加

## 3. アーキテクチャ

### 3.1 全体構成

1 つの Electron アプリが起動 OS で役割を自動判定する(`--sender` / `--receiver` で上書き可)。

- **送信側 (Mac)**: シグナリングサーバー内蔵起動 (port 3100) + UDP ビーコン送信 (port 3101, 2 秒間隔)
- **受信側 (Windows)**: UDP ビーコンを待ち受けて送信側を自動発見 → WebSocket でシグナリング接続 → WebRTC P2P で映像受信

映像は Chromium の WebRTC でハードウェアエンコードされ、2 台間を P2P で流れる。
サーバーはオファー / アンサー / ICE の中継のみを行う。

### 3.2 接続シーケンス

1. 受信側が `hello` (role=receiver) → サーバーが送信側に `receiver-ready` を通知
2. 送信側が `RTCPeerConnection` を作成し `offer` を送信
3. 受信側が `answer` を返し、ICE 候補を相互交換して P2P 確立
4. 送信側が後から配信を開始した場合は `sender-ready` → `receiver-ready` の再ハンドシェイクで再開

### 3.3 ファイル構成

| パス | 役割 |
|---|---|
| `main.js` | Electron メイン。役割判定 / サーバー起動 / UDP 発見 / 画面キャプチャ / 仮想ディスプレイ管理 / 省電力抑止 |
| `preload.js` | contextBridge で UI に公開する API |
| `lib/signaling.js` | シグナリングサーバー本体(アプリとブラウザ版で共用) |
| `app/` | アプリ UI (sender.html/js, receiver.html/js, style.css) |
| `public/` | ブラウザ版 UI(アプリなしでも使える簡易版) |
| `server.js` | ブラウザ版の起動スクリプト (`npm run serve`) |
| `tools/make-icon.js` | アイコン生成(外部ライブラリなしで PNG を直接エンコード) |
| `tools/mac/virtual-display.m` | macOS 仮想ディスプレイヘルパー (Objective-C) |

## 4. 主な機能

### 4.1 送信側 UI (Mac)

- 配信対象の画面・ウィンドウをサムネイル付きグリッドから選択(5 秒ごと自動更新)
- 画質モード切替(配信中も変更可)
  - 文字くっきり: `detail` / `maintain-resolution` / 15Mbps
  - バランス: `detail` / `balanced` / 25Mbps
  - 動き滑らか: `motion` / `maintain-framerate` / 35Mbps
- 接続状態のライブ表示、ブラウザ受信用 URL のコピー
- 仮想ディスプレイ作成(4.3)、おまかせ起動(4.4)

### 4.2 受信側 UI (Windows)

- UDP 自動発見による全自動接続(IP 手動入力もフォールバックで用意)
- ダブルクリック / `F` キーで全画面、`S` キーで統計オーバーレイ(解像度・fps・ビットレート・RTT)
- 切断時の自動再接続

### 4.3 仮想ディスプレイ内蔵(拡張モード)

- CoreGraphics の **CGVirtualDisplay**(非公開 API。BetterDisplay と同じ仕組み)を使う
  小さなヘルパーバイナリを同梱し、Electron から spawn / kill して制御する
- UI から解像度 (1920×1080 / 2560×1440 / 1680×1050) を選んでワンクリック作成
- ヘルパープロセスが生きている間だけ macOS に「2 枚目のモニタ」が存在し、アプリ終了で自動消滅
- これを配信対象に選ぶと、ミラーリングではなく本物の拡張ディスプレイになる
- リスク: 非公開 API のため将来の macOS 更新で動かなくなる可能性あり。
  その場合は BetterDisplay 併用が代替になる

### 4.4 おまかせ起動

- 配信開始時にチェックを入れると構成(画面名・仮想ディスプレイ有無と解像度・画質)を localStorage に保存
- 次回起動時: 仮想ディスプレイ再作成 → 同名画面の出現を最大 5 秒待って自動選択 → 自動配信開始
- 結果、2 回目以降は「両方のアプリを起動するだけ」で接続まで全自動

### 4.5 低遅延チューニング(自動適用)

| 手法 | 効果 |
|---|---|
| 受信側 `jitterBufferTarget = 0` / `playoutDelayHint = 0` | 受信バッファを溜めない(効果最大) |
| H.264 コーデック優先 (`setCodecPreferences`) | 両機ともハードウェア処理でエンコード / デコードが速い |
| `backgroundThrottling: false` + `powerSaveBlocker` | 最小化中・省電力時の処理間引きを防止 |

期待遅延: 良好な 5GHz Wi-Fi で 40〜80ms、目安 50〜150ms。

遅延の内訳(概算): キャプチャ 約16ms(60fps の 1 フレーム) + エンコード 5〜15ms +
ネットワーク 1〜10ms + デコード・描画 20〜60ms。
支配的なのはネットワークではなく受信側のバッファリングと描画。

## 5. ビルド / CI

- `.github/workflows/build.yml` が main への push・`v*` タグ・手動実行で自動ビルド
  - macos-latest: VirtualDisplay ヘルパーを clang でコンパイル → electron-builder で dmg (arm64)
  - windows-latest: electron-builder で NSIS exe (x64)
  - 未署名ビルド (`CSC_IDENTITY_AUTO_DISCOVERY=false`)
  - 成果物は Artifacts と `latest` タグの Release の両方に配置

## 6. 制限事項

- 1 対 1 専用(送信 1・受信 1)。受信側が複数接続すると先客が切断される
- 音声は転送しない(画面のみ)
- 受信側からのマウス・キーボード操作は不可(表示専用)
- LAN 内前提。インターネット越しは想定外
- Thunderbolt Bridge は Boot Camp Windows では動作しない
  → 有線化するなら USB-C LAN アダプター×2 で直結(Mac `192.168.100.1` / Win `192.168.100.2`)

## 7. 今後の拡張案(未実装)

- **1 対 N 対応(3〜4 台)**
  - シグナリングの複数受信管理(受信側に ID を振り 1:N で管理)
  - 受信側ごとの `RTCPeerConnection` と映像ソースの割り当て UI
  - M4 のエンコード能力的には 1080p×3〜4 本まで現実的。
    ボトルネックは Wi-Fi 帯域(1 本 15〜35Mbps)のため有線推奨
- 音声転送、受信側からの入力操作(リモート KVM 化)
- Tauri 移行によるアプリサイズ削減(現状は Chromium 同梱のため dmg 約 98MB / exe 約 81MB)

## 8. 検証状況

- 検証済み: シグナリング中継の一連の流れ(自動テスト)、全 JS の構文、
  アイコン生成、静的ファイル配信、CI での dmg / exe ビルド成功
- 未検証(実機が必要): WebRTC の実測遅延と映像品質、UDP 自動発見、
  CGVirtualDisplay ヘルパーの動作、dmg / exe の実機インストール
