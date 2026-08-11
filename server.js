// laptop-display: ブラウザのみで使う場合の起動スクリプト(アプリ版は main.js)。
//
// 使い方 (Mac 側):
//   npm install
//   node server.js
//   → 表示された URL を Mac と Windows のブラウザでそれぞれ開く

const path = require('path');
const { startSignaling, lanAddresses } = require('./lib/signaling');

const PORT = process.env.PORT || 3100;

startSignaling({ port: PORT, publicDir: path.join(__dirname, 'public') });

console.log('laptop-display を起動しました\n');
console.log(`  Mac (この PC) で開く   : http://localhost:${PORT}/sender.html`);
for (const addr of lanAddresses()) {
  console.log(`  Windows 側で開く       : http://${addr}:${PORT}/receiver.html`);
}
console.log('\n両方のページを開くと自動で接続されます。Ctrl+C で終了。');
