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

### 署名・公証の設定 (Apple Developer Program 加入者向け)

Mac で次を実行すると、証明書の確認から GitHub シークレットの登録、
ビルドの開始までまとめて行えます(証明書の .p12 書き出しだけは
秘密鍵をキーチェーンの外に出す操作なので、キーチェーンアクセスでの手作業が必要)。

```bash
bash scripts/setup-signing.sh
```

手動で登録する場合は、以下の 5 つを GitHub の
**Settings → Secrets and variables → Actions** に登録します。
未登録の場合は未署名ビルドになります(下記の手動対処が必要)。

| シークレット名 | 中身 |
|---|---|
| `MAC_CSC_LINK` | Developer ID Application 証明書 (.p12) を base64 化した文字列 |
| `MAC_CSC_KEY_PASSWORD` | .p12 に付けたパスワード |
| `APPLE_ID` | Apple ID のメールアドレス |
| `APPLE_APP_SPECIFIC_PASSWORD` | appleid.apple.com で発行する「App 用パスワード」 |
| `APPLE_TEAM_ID` | Team ID (10 文字。developer.apple.com の Membership で確認) |

証明書の書き出し手順:

1. Xcode → Settings → Accounts → Manage Certificates で
   **Developer ID Application** を作成(なければ `+` から)
2. キーチェーンアクセスで該当証明書を右クリック →「書き出す」→ .p12 形式で保存
3. `base64 -i Certificates.p12 | pbcopy` で base64 にしてコピー

### Mac: インストールスクリプトを使うのが簡単

Apple Developer Program に登録していないため、このアプリは**公証 (notarization) を
受けていません**。そのため dmg をダウンロードしたまま開くと、macOS が
「マルウェアが含まれている可能性がある」としてブロックします(実際にマルウェアが
入っているわけではなく、公証の照会先に情報がないためこの表示になります)。

取得・インストール・隔離属性の解除・起動をまとめて行うスクリプトを用意してあります。

```bash
curl -fsSL https://raw.githubusercontent.com/HIDE5459/laptop-display/main/scripts/install-mac.sh | bash
```

更新するときも同じコマンドで最新版に入れ替わります。

### 手動で入れる場合

dmg から Applications にコピーしたあと、ターミナルで隔離属性を外します。

```bash
xattr -dr com.apple.quarantine /Applications/LaptopDisplay.app
open /Applications/LaptopDisplay.app
```

**この操作はダウンロードし直すたびに必要です**(新しく落としたアプリには
再び隔離属性が付くため)。

macOS の警告文と原因の対応:

| 警告 | 原因 | 対処 |
|---|---|---|
| マルウェアが含まれている可能性がある | 公証がない + 隔離属性 | 上記の `xattr -dr` |
| 壊れているため開けません | 署名がない (arm64) | ビルド時に ad-hoc 署名済み。出る場合は `codesign --force --deep --sign - <app>` |
| 開発元を確認できません | 公証なし | システム設定 → プライバシーとセキュリティ →「このまま開く」 |

**Windows**: SmartScreen の警告で「詳細情報」→「実行」。

## 使い方

1. **Mac** で LaptopDisplay を起動(自動で送信側モードになります)
   - 初回は macOS の「画面収録」権限を求められるので許可して再起動
   - **アプリを更新したあとに画面一覧が空になる場合**は、署名が変わって以前の許可が
     無効になっています。アプリ内の案内から設定を開いて許可し直すか、次を実行:

     ```bash
     tccutil reset ScreenCapture com.hide5459.laptop-display
     open -a LaptopDisplay
     ```
2. **Windows** で LaptopDisplay を起動(自動で受信側モードになります)
   - 同じネットワーク内なら**自動で Mac を発見して接続**します。
     見つからない場合は Mac の IP を手動入力
3. Mac 側で配信する画面をクリックして「配信を開始」

受信側の操作: ダブルクリックまたは `F` で全画面、`Esc` で全画面解除、
`S` で統計(解像度 / fps / ビットレート / 遅延)表示。

映像が届くと自動で全画面になり、次のように「ただのディスプレイ」として振る舞います。

- メニューバーは表示しない(Windows では完全に無効化)
- 全画面中は最前面に固定するため、Windows のタスクバーも隠れる
- マウスを 2 秒動かさないと、ツールバーとマウスカーソルも消える

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

1. 解像度を選んで「仮想ディスプレイを作成」
   - 受信側アプリが接続していると、**受信側 (Windows) の画面に合う解像度**が
     一覧の先頭にグループで並ぶので、そこから選ぶ
   - 縦横比がパネルと一致するものだけなので、受信側で黒帯が出ない
     (16:10 の画面に 1920×1080 を送ると上下に帯が出る、といった失敗を防げる)
   - 表記は macOS のディスプレイ設定と同じ考え方。Retina パネル (2560×1600) なら:

     | 解像度 | 表示 | 意味 |
     |---|---|---|
     | 2560 × 1600 | 等倍 | 作業領域は最大だが文字がかなり小さい。負荷も高い |
     | 1920 × 1200 | 広い | 文字は小さめ |
     | 1680 × 1050 | スペースを拡大 ★推奨 | 作業領域が広く、文字も許容範囲 |
     | 1440 × 900 | 標準 | 文字が読みやすい |
     | 1280 × 800 | 大きく表示 | 文字が大きい |
2. macOS に「2 枚目のモニタ」が追加され、画面一覧に **LaptopDisplay** が現れる
3. それを選んで配信開始 → ウィンドウをドラッグして移せる拡張ディスプレイになる

### カーソルを見失わないように

画面が増えるとカーソルの位置が分かりにくくなるため、送信側アプリに
**カーソルを各ディスプレイの中央へ飛ばすホットキー**を用意しています。

- `Control+Alt+Tab` — 押すたびに次のディスプレイの中央へ移動(キーは変更可能)
- `Control+Alt+1` / `2` / `3` — 画面を直接指定して移動
- 移動先で一瞬リングが表示されるので、どこに飛んだかすぐ分かります

macOS の公開 API (`CGWarpMouseCursorPosition`) を使うため追加の権限は不要です。
あわせて **システム設定 → アクセシビリティ → ディスプレイ → ポインタ** で
ポインタの色とサイズを変えておくと、配信された画面でも見つけやすくなります。

### 画面の配置を変える

仮想ディスプレイは通常の外部モニタと同じ扱いなので、macOS の設定で配置できます。

1. 仮想ディスプレイを作成した状態で、アプリの**「配置を変更」**ボタン
   (または システム設定 → ディスプレイ)を開く
2. **「配置…」**ボタンを押す(複数ディスプレイがあるときだけ表示される)
3. **LaptopDisplay の青い四角をドラッグ**して左・右・上・下に置く

四角の上の白い帯をドラッグすると、メインディスプレイの切り替えもできます。

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
