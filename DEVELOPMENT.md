# 仕様書・開発記録

最終更新: 2026-08-11

## 1. プロジェクト概要

**LaptopDisplay** は、MacBook の画面を Windows ノート PC に低遅延ストリーミングし、
Windows ノートをセカンドモニタとして使うためのデスクトップアプリ。
さらに Windows 側のキーボード・マウスで Mac を操作できる(簡易 KVM)。

- 想定環境: MacBook Air (M4, 送信側) / MacBook Pro 2016 Boot Camp Windows 10 (受信側)
- 配布形式: Mac 用 `.dmg` (Apple Silicon) / Windows 用 `.exe` (x64, NSIS ワンクリックインストーラ)
- 配布先: GitHub Release の `latest` タグ(CI が push ごとに差し替え)

## 2. 背景・経緯

「持ち歩いている 2 台のノート PC の片方をディスプレイにできないか」という相談から開始。

1. ノート PC の HDMI / USB-C ポートは映像出力専用のため、ケーブル直結での画面入力は不可能と整理
2. 既製品 (Duet Display / Deskreen / Luna Display) を検討したのち、WebRTC ベースの自作を決定
3. まずブラウザだけで動く最小構成 (`public/` + `server.js`) を実装
4. UI を作り込み dmg / exe で配布するため Electron アプリ化
5. 遅延低減チューニング → 仮想ディスプレイ内蔵 (BetterDisplay 不要化) → おまかせ起動
6. 実運用で出た課題を順に解消
   - 全画面にしてもタスクバーやメニューバーが残る → 最前面固定 + メニュー無効化
   - 上下が切れる / 黒帯が出る → 受信側の対応解像度を提示、表示の合わせ方を切替可能に
   - 3 画面でカーソルを見失う → ホットキー / Option タップでカーソルを移動
   - Windows のキーボードで誤って打つ → 入力を Mac へ転送 (KVM)
   - Windows 側が放置扱いでスリープする → 表示中はスリープ抑止
   - 常に起動していてほしい → トレイ常駐 + ログイン時の自動起動

## 3. アーキテクチャ

### 3.1 全体構成

1 つの Electron アプリが起動 OS で役割を自動判定する(`--sender` / `--receiver` で上書き可)。

- **送信側 (Mac)**: シグナリングサーバー内蔵起動 (TCP 3100) + UDP ビーコン送信 (3101, 2 秒間隔)
- **受信側 (Windows)**: UDP ビーコンを待ち受けて送信側を自動発見 → WebSocket でシグナリング接続 → WebRTC P2P で映像受信

映像は Chromium の WebRTC でハードウェアエンコードされ、2 台間を P2P で流れる。
サーバーはオファー / アンサー / ICE の中継と、入力イベントの受け取りを行う。

### 3.1.1 役割の決定

優先順位は `--sender` / `--receiver` フラグ → 保存された設定
(`<userData>/role.json`) → OS 既定 (macOS = sender / それ以外 = receiver)。
UI から切り替えるとファイルに書いて `app.relaunch()` する。

Mac 固有機能(仮想ディスプレイ・カーソル移動・Option タップ・入力の再現)は
`process.platform === 'darwin'` のときだけ UI を表示するため、
ホストが Windows の場合はミラーリング配信のみになる。

### 3.2 接続シーケンス

1. 受信側が `hello` (role=receiver, 自分の画面情報を添付) → サーバーが送信側に `receiver-ready` を通知
2. 送信側が `RTCPeerConnection` を作成し `offer` を送信
3. 受信側が `answer` を返し、ICE 候補を相互交換して P2P 確立
4. 送信側が後から配信を開始した場合は `sender-ready` → `receiver-ready` の再ハンドシェイクで再開
5. 切断時は受信側が 2 秒間隔で再接続。前回の相手は保存してあり起動時に即試行する

### 3.3 シグナリングのメッセージ

| type | 方向 | 用途 |
|---|---|---|
| `hello` | 双方 → サーバー | 役割の申告。受信側は `display` (実解像度と対応解像度) を添付 |
| `receiver-ready` / `sender-ready` | サーバー → 相手 | 相手が現れたことの通知(オファー作成の契機) |
| `offer` / `answer` / `ice` | 送信側 ⇄ 受信側 | WebRTC のネゴシエーション(サーバーは中継のみ) |
| `peer-left` | サーバー → 相手 | 切断通知 |
| `input` | 受信側 → サーバー | キーボード・マウス操作。**相手へ転送せず Mac 側で処理する** |

### 3.4 ファイル構成

| パス | 役割 |
|---|---|
| `main.js` | Electron メイン。役割判定 / サーバー起動 / UDP 発見 / 画面キャプチャ / 各ヘルパー管理 / 入力再現 / トレイ / 権限まわり |
| `preload.js` | contextBridge で UI に公開する API |
| `lib/signaling.js` | シグナリングサーバー本体(アプリとブラウザ版で共用) |
| `lib/keymap.js` | `KeyboardEvent.code` → macOS 仮想キーコードの対応表と修飾キーの入れ替え |
| `app/` | アプリ UI (sender.html/js, receiver.html/js, style.css) |
| `public/` | ブラウザ版 UI(アプリなしでも使える簡易版) |
| `server.js` | ブラウザ版の起動スクリプト (`npm run serve`) |
| `tools/mac/virtual-display.m` | 仮想ディスプレイ作成 (CGVirtualDisplay) |
| `tools/mac/cursor-move.m` | カーソル移動 (CGWarpMouseCursorPosition) |
| `tools/mac/modifier-tap.m` | Option 単独タップの検出 (CGEventTap) |
| `tools/mac/input-inject.m` | 受信側の入力を CGEvent として再現 |
| `tools/after-pack.js` | 未署名ビルド時に ad-hoc 署名を付ける electron-builder フック |
| `tools/make-icon.js` | アイコン生成(依存ライブラリなし) |
| `scripts/install-mac.sh` | 取得・インストール・隔離属性解除・起動を一括で行う |
| `scripts/setup-signing.sh` | 署名・公証用の GitHub シークレット登録を補助する |

### 3.5 同梱するネイティブヘルパー

すべて `extraResources` として `.app/Contents/Resources/` に入れ、
Electron から `spawn` / `execFileSync` で呼ぶ。未署名ビルドでは `afterPack` で
本体より先に ad-hoc 署名する(入れ子のコードは外側より先に署名が必要)。

| ヘルパー | API | 権限 | 常駐 |
|---|---|---|---|
| `VirtualDisplay` | CGVirtualDisplay(**非公開 API**) | 不要 | 表示している間 |
| `CursorMove` | CGWarpMouseCursorPosition | 不要 | 都度起動 |
| `ModifierTap` | CGEventTap (ListenOnly) | アクセシビリティ | 有効な間 |
| `InputInject` | CGEventCreate\* + CGEventPost | アクセシビリティ | 有効な間 |

## 4. 機能

### 4.1 送信側 UI (Mac)

- 配信対象の画面・ウィンドウをサムネイル付きグリッドから選択(5 秒ごと自動更新)
- 画質モード切替(配信中も変更可)
  - 文字くっきり: `detail` / `maintain-resolution` / 15Mbps
  - バランス: `detail` / `balanced` / 25Mbps
  - 動き滑らか: `motion` / `maintain-framerate` / 35Mbps
- 仮想ディスプレイの作成・削除、配置設定を開くボタン
- カーソル移動のホットキー、Option タップ設定
- Windows からの入力受付、Ctrl↔Command 入れ替え
- おまかせ起動(前回構成の自動再現)、ログイン時の自動起動
- 画面収録の権限が失効したときの検出と復旧ボタン

### 4.2 受信側 UI (Windows)

- UDP 自動発見 + 前回接続先の記憶による自動接続(IP 手動入力もあり)
- 映像が届いたら自動で全画面。`F` / ダブルクリックで切替、`Esc` で解除
- 全画面中は最前面固定でタスクバーを覆う。メニューバーは無効化
- マウス 2 秒操作なしでツールバーとカーソルを隠す
- `Z` で表示の合わせ方切替(合わせる / 画面いっぱい / 引き伸ばす)
- `S` で統計(映像の解像度・表示領域・fps・ビットレート・RTT)
- `F9` で入力転送のオン / オフ
- ウィンドウを閉じてもトレイに常駐。ログイン時の自動起動も設定可能
- 表示中はスリープ・画面消灯を抑止 (`prevent-display-sleep`)

### 4.3 仮想ディスプレイ

- `CGVirtualDisplay`(BetterDisplay と同じ仕組みの非公開 API)で 1 枚作成
- ヘルパープロセスが生きている間だけ存在し、アプリ終了で自動消滅
- 毎回同じ productID / serialNum で作るため、macOS 側の配置設定が維持される
- **解像度の提示**: 受信側が `CIM_VideoControllerResolution` で列挙した対応解像度を
  `hello` で申告 → パネルと同じ縦横比のものだけを送信側の一覧に並べる。
  列挙に失敗した場合はパネル比から一般的な段階を生成
- ラベルは実解像度に対する倍率から macOS と同じ呼び方を割り当てる
  (等倍 / 広い / スペースを拡大 / 標準 / 大きく表示)。既定は倍率 1.5 付近

### 4.4 カーソルの移動

- `Control+Alt+Tab`(変更可)で次のディスプレイの中央へ巡回
- `Control+Alt+1/2/3` で直接指定。並び順は**本体を先頭**に固定し、残りは左から右
- 移動先で一瞬リング(透明・最前面・クリック透過のウィンドウ)を表示
- **Option タップ**: `CGEventTap` で単独タップを検出し、1 回 = 本体 / 2 回 = 2 枚目 / 3 回 = 3 枚目。
  誤爆を避けるため既定は右 Option のみ。Option + 他キーやクリックがあった場合は無効。
  連続タップの判定に約 0.35 秒待つ

### 4.5 入力転送 (簡易 KVM)

- 受信側で `F9` を押すとキーボード・マウス操作を `input` メッセージとして送る
- マウスは**映像内の相対座標**を送り、送信側が配信中の画面の範囲へ写す
  (`object-fit` の余白も計算に含める)。絶対座標対応なのでカーソルがずれない
- キーは `KeyboardEvent.code` を送り、Mac 側で仮想キーコードへ変換
- 既定で **Ctrl → Command / Windows キー → Control** に入れ替え、`Ctrl+C` などをそのまま使える
- マウス移動は 125Hz に間引く
- 安全策
  - 送信側の受付は**起動時は必ずオフ**(前回状態を復元しない)
  - `Control+Alt+I` で強制解除(カーソルを奪われてマウス操作できない状態からの脱出用)
  - 転送中は受信側のローカルショートカットを無効化し `F9` だけ有効

### 4.6 低遅延チューニング

| 手法 | 効果 |
|---|---|
| 受信側 `jitterBufferTarget = 0` / `playoutDelayHint = 0` | 受信バッファを溜めない(効果最大) |
| H.264 コーデック優先 (`setCodecPreferences`) | 両機ともハードウェア処理 |
| `backgroundThrottling: false` + `powerSaveBlocker` | 最小化中・省電力時の間引きを防止 |

期待遅延: 良好な 5GHz Wi-Fi で 40〜80ms、目安 50〜150ms。
内訳の概算: キャプチャ 約16ms(60fps の 1 フレーム) + エンコード 5〜15ms +
ネットワーク 1〜10ms + デコード・描画 20〜60ms。支配的なのは受信側のバッファと描画。

## 5. macOS の権限

未署名ビルドは**ビルドごとに署名が変わる**ため、署名に紐付く権限が更新のたびに失効する。

| 権限 | 用途 | 失効時の症状 | 復旧 |
|---|---|---|---|
| 画面収録 | 画面のキャプチャ | 画面一覧が空 / サムネイルが黒 | アプリの「権限をリセットして再起動」(`tccutil reset ScreenCapture`) |
| アクセシビリティ | Option タップ検出、入力の再現 | 機能が開始できない | 設定で許可し直してアプリを再起動 |

Developer ID で署名すれば署名が固定され、この失効は起きなくなる
(`scripts/setup-signing.sh` と CI のシークレット対応は実装済み。未設定なら未署名でビルド)。

## 6. ビルド / CI

- `.github/workflows/build.yml` が main への push・`v*` タグ・手動実行で自動ビルド
  - macos-latest: ネイティブヘルパー 4 つを clang でコンパイル → electron-builder で dmg (arm64)
  - windows-latest: electron-builder で NSIS exe (x64)
  - シークレットが揃っていれば Hardened Runtime + 公証、無ければ未署名 (ad-hoc 署名のみ)
  - 成果物は Artifacts と `latest` タグの Release の両方へ
- 注意: 未登録のシークレットは**空文字として env に入る**。空の `CSC_LINK` を
  electron-builder に渡すと証明書のパスとして解決され `<projectDir> not a file` で失敗するため、
  `MAC_` 接頭辞で受け取り署名する場合にだけ移す

## 7. 制限事項

- 1 対 1 専用(送信 1・受信 1)
- 音声は転送しない(画面のみ)
- 入力転送は配信対象が**画面**のときだけ有効(ウィンドウ単体では座標が対応しない)
- Alt+Tab など Windows 自身が処理するキーは転送できない
- LAN 内前提。Tailscale 経由でも動くが UDP ブロードキャストが通らないため IP の手動入力が必要
  (一度つながれば記憶して自動再接続)。経路が DERP 中継だと帯域・遅延が厳しい
- Thunderbolt Bridge は Boot Camp Windows では動作しない
  → 有線化するなら USB-C LAN アダプター×2 で直結
- `CGVirtualDisplay` は非公開 API のため、macOS のメジャーアップデートで
  動かなくなる可能性がある(その場合は BetterDisplay 併用が代替)

## 8. 今後の拡張案(未実装)

- **1 対 N 対応(3〜4 台)**: シグナリングの複数受信管理 + 受信側ごとの `RTCPeerConnection`
  + 画面割り当て UI。M4 のエンコード能力的には 1080p×3〜4 本まで現実的。
  ボトルネックは Wi-Fi 帯域(1 本 15〜35Mbps)のため有線推奨
- 音声転送、クリップボード共有
- HiDPI (Retina) の仮想ディスプレイ(綺麗になるが転送量は 4 倍)
- Tauri 移行によるアプリサイズ削減(現状は Chromium 同梱で dmg 約 98MB / exe 約 82MB)

## 9. 検証状況

**検証済み(このリポジトリでの自動テスト・静的検証)**

- シグナリングの中継、受信側の画面情報の伝播と切断時のクリア
- 解像度の列挙・絞り込み・ラベル付け(16:9 / 5:4 など比率違いの除外を含む)
- カーソル巡回とタップ回数 → ディスプレイ番号の対応(本体優先の並び)
- キーマップと修飾キー入れ替え(`Ctrl+C` → `⌘C`、未知のキーは無視)
- 入力の座標変換(範囲外のクランプ)
- 送信側 UI をヘッドレス Chromium で読み込み、画面一覧の描画・クリック選択・
  権限警告の出し分けを確認(JS エラーなし)
- CI での dmg / exe ビルド成功

**未検証(実機が必要)**

- ネイティブヘルパー 4 つの実動作(仮想ディスプレイ作成、カーソル移動、
  Option タップ検出、入力の再現)
- WebRTC の実測遅延と映像品質
- トレイ常駐・ログイン時自動起動の挙動
- 署名 + 公証パス(シークレット未登録のため未実行)

開発環境が Linux コンテナのため、macOS / Windows 実機での確認はユーザーの実行に委ねている。
