# LaptopDisplay

Mac の画面を Windows ノートに WebRTC で低遅延ストリーミングし、
Windows ノートをサブディスプレイとして使うためのデスクトップアプリです。

映像は 2 台間を P2P(ハードウェアエンコード)で送るため、
同じ Wi-Fi / LAN 内なら遅延はおおむね 50〜150ms 程度です。

- **Mac 用 (送信側)**: `.dmg` — 画面選択(サムネイル付き)・仮想ディスプレイ作成・画質モード切替
- **Windows 用 (受信側)**: `.exe` — 送信側を自動発見して自動接続・全画面表示・統計オーバーレイ
- アプリを使わず**ブラウザだけ**でも動きます(後述)

## ダウンロード

[**Releases**](../../releases/tag/latest) から最新ビルドを取得できます。

- `LaptopDisplay-1.0.0-arm64.dmg` — Mac (Apple Silicon) 用
- `LaptopDisplay.Setup.1.0.0.exe` — Windows 10/11 (x64) 用

### 未署名アプリの初回起動

Apple Developer 証明書による署名・公証をしていないため、初回のみ警告が出ます。
(ビルド時に ad-hoc 署名は付けています)

- **Mac**: アプリを右クリック →「開く」→「開く」
- **Windows**: SmartScreen の警告で「詳細情報」→「実行」

**「"LaptopDisplay" は壊れているため開けません」と出る場合**

ダウンロード時に付く隔離属性が原因です。アプリが壊れているわけではありません。
Applications に入れた後、ターミナルで次を実行してください。

```bash
xattr -cr /Applications/LaptopDisplay.app
codesign --force --deep --sign - /Applications/LaptopDisplay.app
```

以降は普通に起動できます(初回のみ右クリック →「開く」が必要な場合があります)。

## 使い方

1. **Mac** で LaptopDisplay を起動(自動で送信側モードになります)
   - 初回は macOS の「画面収録」権限を求められるので許可して再起動
2. **Windows** で LaptopDisplay を起動(自動で受信側モードになります)
   - 同じネットワーク内なら**自動で Mac を発見して接続**します。
     見つからない場合は Mac の IP を手動入力
3. Mac 側で配信する画面をクリックして「配信を開始」

受信側の操作: ダブルクリックまたは `F` で全画面、`S` で統計(解像度 / fps / ビットレート / 遅延)表示。

### おまかせ起動(2 回目以降は起動するだけ)

Mac 側で配信を開始する際に**「おまかせ起動」**にチェックを入れると、
そのときの構成(選んだ画面・仮想ディスプレイの有無と解像度・画質モード)が保存され、
次回からは **Mac と Windows でアプリを起動するだけで自動的に配信・接続まで完了**します。
やめたいときはチェックを外すだけです。

### 画質モード

| モード | 用途 |
|---|---|
| 文字くっきり | 文書・コード・ブラウザ(解像度優先) |
| バランス | 汎用 |
| 動き滑らか | 動画・スクロールの多い作業(フレームレート優先) |

## 「拡張ディスプレイ」として使うには

そのまま画面全体を共有するとミラーリング(複製)になります。
Mac のデスクトップを広げる「拡張ディスプレイ」にするには、送信側アプリの
**「仮想ディスプレイ」カードで「仮想ディスプレイを作成」**を押してください
(外部アプリ不要・アプリ単独で完結します)。

1. 解像度を選んで「仮想ディスプレイを作成」(Windows ノートに合わせる。通常 1920×1080)
2. macOS に「2 枚目のモニタ」が追加され、画面一覧に **LaptopDisplay** が現れる
3. それを選んで配信開始 → ウィンドウをドラッグして移せる拡張ディスプレイになる

画面の配置(左右どちらに置くか)は macOS のシステム設定 → ディスプレイで
通常の外部モニタと同様に調整できます。

仕組み: 同梱の `VirtualDisplay` ヘルパー (`tools/mac/virtual-display.m`) が
CoreGraphics の CGVirtualDisplay(BetterDisplay 等と同じ仕組み)で仮想モニタを
作成します。非公開 API のため、macOS のメジャーアップデートで動かなくなる
可能性はあります。その場合は [BetterDisplay](https://github.com/waydabber/BetterDisplay)
で仮想ディスプレイを作る従来の方法がそのまま代替になります。

## ブラウザだけで使う(アプリ不要版)

```bash
npm install
npm run serve
```

- Mac: `http://localhost:3100/sender.html` を開いて配信開始
- Windows: 表示された `http://<MacのIP>:3100/receiver.html` をブラウザで開く

## 自分でビルドする

dmg は macOS 上、exe は Windows 上でしかビルドできません。

```bash
npm install
npm run dist:mac   # Mac 上で実行 → dist/LaptopDisplay-*.dmg
npm run dist:win   # Windows 上で実行 → dist/LaptopDisplay-*.exe
```

GitHub Actions (`.github/workflows/build.yml`) は main への push・`v*` タグ・手動実行で
両方を自動ビルドし、`latest` タグの Release に添付します。

## 低遅延チューニング(アプリが自動で行うもの)

- 受信バッファの最小化 (`jitterBufferTarget = 0`) — LAN 前提で映像を溜めずに即表示
- H.264 コーデック優先 — Mac/Windows ともハードウェア処理でエンコード/デコードが速い
- バックグラウンド抑制の無効化と省電力スリープの抑止 — 最小化中も配信が間引かれない

## 遅延を減らすコツ

- 両方を 5GHz の Wi-Fi に接続する(可能なら有線 LAN が最良)
- Mac と Windows を同じルーターの近くで使う
- 仮想ディスプレイは 1920×1080 にする(Retina 解像度より処理量が大幅に減る)
- **USB-C → 有線 LAN アダプター×2 + LAN ケーブルで 2 台を直結**すると
  Wi-Fi を介さず最も安定します(IP は手動設定: Mac `192.168.100.1`、
  Windows `192.168.100.2`、マスク `255.255.255.0`)
- 補足: Thunderbolt ケーブル直結ネットワーク (Thunderbolt Bridge) は
  Boot Camp 上の Windows では動作しないため、Boot Camp 構成では
  上記の LAN アダプター直結を推奨します

## 制限事項

- 1 対 1 専用(送信 1・受信 1)。3〜4 台対応は将来の拡張案(`DEVELOPMENT.md` 参照)
- 音声は転送しません(画面のみ)
- Windows 側からのマウス・キーボード操作はできません(表示専用)
- 接続は LAN 内前提です。インターネット越しの利用は想定していません

## 構成

```
├── main.js              # Electron メイン (役割自動判定・UDP 自動発見・画面キャプチャ)
├── preload.js
├── lib/signaling.js     # シグナリングサーバー (アプリ・ブラウザ版で共用)
├── server.js            # ブラウザ版の起動スクリプト
├── app/                 # アプリ UI (送信・受信)
├── public/              # ブラウザ版 UI
├── tools/make-icon.js   # アイコン生成 (依存ライブラリなし)
├── tools/mac/virtual-display.m  # 仮想ディスプレイヘルパー (CGVirtualDisplay)
└── build/icon.png
```

設計の詳細・開発の経緯は [DEVELOPMENT.md](DEVELOPMENT.md) にまとめてあります。
