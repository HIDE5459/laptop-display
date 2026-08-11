#!/bin/bash
# 署名 + 公証をCIで行うためのシークレットを登録する (Mac 上で実行)。
#
# 秘密鍵はキーチェーンの外に出せないため、.p12 の書き出しだけは
# キーチェーンアクセスでの操作が必要。それ以外は自動で行う。
#
#   bash scripts/setup-signing.sh

set -euo pipefail

REPO="HIDE5459/laptop-display"

echo "=== LaptopDisplay 署名セットアップ ==="
echo

# ---- 1. 証明書の確認 ----

IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null \
  | grep 'Developer ID Application' | head -1 | sed 's/.*"\(.*\)".*/\1/' || true)"

if [ -z "$IDENTITY" ]; then
  cat <<'MSG'
Developer ID Application 証明書が見つかりませんでした。先に作成してください。

  Xcode → Settings → Accounts → Apple ID を選択 → Manage Certificates
  → 左下の「+」→ Developer ID Application

作成後、もう一度このスクリプトを実行してください。
MSG
  exit 1
fi

echo "見つかった証明書:"
echo "  $IDENTITY"

# 証明書名の末尾 (XXXXXXXXXX) が Team ID
TEAM_ID="$(echo "$IDENTITY" | sed -n 's/.*(\([A-Z0-9][A-Z0-9]*\))$/\1/p')"
if [ -n "$TEAM_ID" ]; then
  echo "  Team ID: $TEAM_ID (証明書から自動取得)"
else
  read -r -p "Team ID (10文字) を入力: " TEAM_ID
fi
echo

# ---- 2. .p12 の書き出し (ここだけ手作業) ----

cat <<MSG
--- 手順 1/2: 証明書の書き出し ---
キーチェーンアクセスを開き、次の証明書を右クリック →「書き出す」→
ファイル形式「個人情報交換 (.p12)」で保存してください。

  $IDENTITY

保存時に設定するパスワードは、このあと入力します。
MSG
echo
read -r -p "キーチェーンアクセスを開きますか? [Y/n]: " OPEN_KC
if [ "${OPEN_KC:-Y}" != "n" ]; then
  open -a "Keychain Access" 2>/dev/null || open -a "キーチェーンアクセス" 2>/dev/null || true
fi

echo
read -r -p "書き出した .p12 のパス (Finder からドラッグでも可): " P12_PATH
P12_PATH="${P12_PATH//\'/}"           # ドラッグ時に付く引用符を除去
P12_PATH="$(echo "$P12_PATH" | xargs)" # 前後の空白を除去

if [ ! -f "$P12_PATH" ]; then
  echo "ファイルが見つかりません: $P12_PATH"
  exit 1
fi

read -r -s -p ".p12 に設定したパスワード: " P12_PASSWORD
echo

# パスワードが正しいか、中身が読めるかを確認しておく
if ! openssl pkcs12 -in "$P12_PATH" -passin "pass:$P12_PASSWORD" -nokeys -legacy >/dev/null 2>&1 \
  && ! openssl pkcs12 -in "$P12_PATH" -passin "pass:$P12_PASSWORD" -nokeys >/dev/null 2>&1; then
  echo "パスワードが違うか、.p12 を読み取れませんでした。"
  exit 1
fi
echo "  .p12 を確認しました"
echo

# ---- 3. Apple ID と App 用パスワード ----

cat <<'MSG'
--- 手順 2/2: 公証用の認証情報 ---
App 用パスワードは通常の Apple ID のパスワードとは別物です。
未発行なら https://appleid.apple.com → サインインとセキュリティ →
アプリ用パスワード で発行してください (xxxx-xxxx-xxxx-xxxx 形式)。
MSG
echo
read -r -p "Apple ID (メールアドレス): " APPLE_ID
read -r -s -p "App 用パスワード: " APP_PASSWORD
echo
echo

# ---- 4. GitHub へ登録 ----

CSC_LINK="$(base64 -i "$P12_PATH" | tr -d '\n')"

if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  echo "gh CLI でシークレットを登録します ($REPO)"
  printf '%s' "$CSC_LINK"      | gh secret set MAC_CSC_LINK --repo "$REPO"
  printf '%s' "$P12_PASSWORD"  | gh secret set MAC_CSC_KEY_PASSWORD --repo "$REPO"
  printf '%s' "$APPLE_ID"      | gh secret set APPLE_ID --repo "$REPO"
  printf '%s' "$APP_PASSWORD"  | gh secret set APPLE_APP_SPECIFIC_PASSWORD --repo "$REPO"
  printf '%s' "$TEAM_ID"       | gh secret set APPLE_TEAM_ID --repo "$REPO"
  echo
  echo "登録しました。ビルドを開始します。"
  gh workflow run build.yml --repo "$REPO" 2>/dev/null \
    && echo "  → https://github.com/$REPO/actions で進行状況を確認できます" \
    || echo "  → Actions タブから Run workflow を実行してください"
else
  OUT="$HOME/Desktop/laptop-display-secrets.txt"
  umask 077
  {
    echo "GitHub の Settings → Secrets and variables → Actions に登録してください"
    echo "(登録後このファイルは削除してください)"
    echo
    echo "MAC_CSC_KEY_PASSWORD=$P12_PASSWORD"
    echo "APPLE_ID=$APPLE_ID"
    echo "APPLE_APP_SPECIFIC_PASSWORD=$APP_PASSWORD"
    echo "APPLE_TEAM_ID=$TEAM_ID"
    echo
    echo "MAC_CSC_LINK="
    echo "$CSC_LINK"
  } > "$OUT"
  chmod 600 "$OUT"
  echo "gh CLI が使えないため、登録内容を次のファイルに書き出しました:"
  echo "  $OUT"
  echo
  echo "https://github.com/$REPO/settings/secrets/actions で登録し、"
  echo "終わったらこのファイルを削除してください:"
  echo "  rm \"$OUT\""
fi
