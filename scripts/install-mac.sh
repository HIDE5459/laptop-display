#!/bin/bash
# LaptopDisplay を Mac に入れる / 最新版に更新する。
#
# 公証 (notarization) を受けていないため、ダウンロードしたままでは
# macOS が「マルウェアが含まれている可能性がある」としてブロックする。
# このスクリプトは取得・インストール・隔離属性の解除・起動までまとめて行う。
#
# 使い方:
#   bash scripts/install-mac.sh
# リポジトリを持っていない場合は次の 1 行でも実行できる:
#   curl -fsSL https://raw.githubusercontent.com/HIDE5459/laptop-display/main/scripts/install-mac.sh | bash

set -euo pipefail

# CPU に合わせて Apple Silicon 版 / Intel 版を選ぶ
if [ "$(uname -m)" = "x86_64" ]; then
  DMG_NAME="LaptopDisplay-1.0.0-x64.dmg"
else
  DMG_NAME="LaptopDisplay-1.0.0-arm64.dmg"
fi
URL="https://github.com/HIDE5459/laptop-display/releases/download/latest/$DMG_NAME"
DMG="$(mktemp -d)/LaptopDisplay.dmg"
APP="/Applications/LaptopDisplay.app"

# Electron 33 は macOS 11 (Big Sur) 以降が必要
MACOS_MAJOR="$(sw_vers -productVersion | cut -d. -f1)"
if [ "$MACOS_MAJOR" -lt 11 ] 2>/dev/null; then
  echo "この Mac の macOS $(sw_vers -productVersion) では動作しません (macOS 11 以降が必要)。"
  echo "ブラウザ版 (npm run serve) をお試しください。"
  exit 1
fi

echo "==> 最新の dmg をダウンロード中 ($DMG_NAME)"
curl -fL --progress-bar -o "$DMG" "$URL"

echo "==> 起動中のアプリがあれば終了"
osascript -e 'quit app "LaptopDisplay"' 2>/dev/null || true
sleep 1

echo "==> マウント"
VOLUME="$(hdiutil attach -nobrowse "$DMG" | grep -o '/Volumes/.*' | tail -1)"
trap 'hdiutil detach "$VOLUME" >/dev/null 2>&1 || true' EXIT

echo "==> $APP へインストール"
rm -rf "$APP"
cp -R "$VOLUME/LaptopDisplay.app" /Applications/

echo "==> 隔離属性を解除 (公証なしアプリのブロックを回避)"
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
# 署名が失われている場合に備えて ad-hoc 署名を付け直す
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true

echo "==> 起動"
open "$APP"

echo
echo "完了しました。"
echo "初回は「画面収録」と「ローカルネットワーク」の許可を求められます。"
echo "許可したら ⌘Q で終了して、もう一度起動してください。"
