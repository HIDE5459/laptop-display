// electron-builder の afterPack フック (macOS 用)
//
// Apple Silicon では署名が一切ないアプリは Gatekeeper に
// 「壊れているため開けません」と判定されて起動できない。
// Developer ID 証明書を持たないため、代わりに ad-hoc 署名 (--sign -) を付ける。
// これで「壊れている」エラーは出なくなり、初回のみ
// 右クリック →「開く」で起動できる状態になる。

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function sign(target) {
  execFileSync('codesign', ['--force', '--sign', '-', '--timestamp=none', target], {
    stdio: 'inherit',
  });
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  // Developer ID 証明書がある場合は electron-builder が正式に署名して公証まで行う。
  // ad-hoc 署名を先に付けると干渉するので何もしない。
  if (process.env.CSC_LINK || process.env.CSC_NAME) {
    console.log('Developer ID による署名を行うため ad-hoc 署名はスキップします');
    return;
  }

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );

  // 内側の実行ファイルから先に署名する(入れ子のコードは外側より先に署名が必要)
  const helper = path.join(appPath, 'Contents', 'Resources', 'VirtualDisplay');
  if (fs.existsSync(helper)) {
    fs.chmodSync(helper, 0o755);
    sign(helper);
  }

  // アプリ本体(同梱フレームワーク・ヘルパーを含めて)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
    stdio: 'inherit',
  });
  execFileSync('codesign', ['--verify', '--deep', '--verbose=2', appPath], {
    stdio: 'inherit',
  });

  console.log(`ad-hoc signed: ${appPath}`);
};
