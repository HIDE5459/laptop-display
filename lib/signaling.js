// WebRTC シグナリングサーバー本体。
// CLI (server.js) と Electron アプリ (main.js) の両方から使う。
// 映像はブラウザ/アプリ同士が P2P で直接やり取りするため、ここは
// 接続の仲介(オファー/アンサー/ICE の中継)と静的ファイル配信のみを行う。

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

// onPeerChange(peers) は sender/receiver の接続状態が変わるたびに呼ばれる。
// onInput(msg) は受信側から送られてくる入力イベントを受け取る
// (送信側の画面へ転送するのではなく、こちらで処理する)。
function startSignaling({ port, publicDir, onPeerChange, onInput }) {
  const server = http.createServer((req, res) => {
    let urlPath = req.url.split('?')[0];
    if (urlPath === '/') urlPath = '/receiver.html';
    const filePath = path.join(publicDir, path.normalize(urlPath));
    if (!filePath.startsWith(publicDir)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        return res.end('Not Found');
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
      res.end(data);
    });
  });

  // role ごとに 1 接続だけ保持し、届いたメッセージを反対側の role へ転送する
  const peers = { sender: null, receiver: null };
  // 受信側が申告してきた画面サイズ(送信側の仮想ディスプレイ解像度の決定に使う)
  let receiverScreen = null;
  const notify = () => {
    if (onPeerChange) {
      onPeerChange({ sender: !!peers.sender, receiver: !!peers.receiver, receiverScreen });
    }
  };

  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => {
    let role = null;

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      if (msg.type === 'hello' && (msg.role === 'sender' || msg.role === 'receiver')) {
        role = msg.role;
        if (peers[role] && peers[role] !== ws) peers[role].close();
        peers[role] = ws;
        if (role === 'receiver') {
          if (msg.display && msg.display.native && msg.display.native.w > 0) {
            receiverScreen = msg.display;
          } else if (msg.screen && msg.screen.w > 0 && msg.screen.h > 0) {
            // 画面情報を取れないブラウザ版などからの接続
            receiverScreen = { native: { w: msg.screen.w, h: msg.screen.h }, modes: [] };
          }
        }
        notify();
        // 受信側が現れたことを送信側へ知らせ、オファー作成のきっかけにする
        if (role === 'receiver' && peers.sender) {
          peers.sender.send(JSON.stringify({ type: 'receiver-ready' }));
        }
        return;
      }

      // 入力イベントは相手に転送せず、Mac 側で再現する
      if (msg.type === 'input' && role === 'receiver') {
        if (onInput) onInput(msg);
        return;
      }

      const other = role === 'sender' ? peers.receiver : peers.sender;
      if (other && other.readyState === other.OPEN) other.send(JSON.stringify(msg));
    });

    ws.on('close', () => {
      if (role && peers[role] === ws) {
        peers[role] = null;
        if (role === 'receiver') receiverScreen = null;
        notify();
        const other = role === 'sender' ? peers.receiver : peers.sender;
        if (other && other.readyState === other.OPEN) {
          other.send(JSON.stringify({ type: 'peer-left' }));
        }
      }
    });
  });

  server.listen(port);
  return { server, lanAddresses };
}

module.exports = { startSignaling, lanAddresses };
