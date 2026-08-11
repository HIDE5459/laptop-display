// アプリアイコン (build/icon.png, 1024x1024) を外部ライブラリなしで生成する。
// デザイン: グラデーションの角丸スクエアに、重なった 2 枚のディスプレイ。
// 実行: npm run icon

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 1024;
const SS = 2; // 2x2 スーパーサンプリングでエッジを滑らかに

// ---- 図形ヘルパー ----

function inRoundedRect(x, y, rx, ry, rw, rh, radius) {
  if (x < rx || x > rx + rw || y < ry || y > ry + rh) return false;
  const cx = Math.max(rx + radius, Math.min(x, rx + rw - radius));
  const cy = Math.max(ry + radius, Math.min(y, ry + rh - radius));
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

// ---- ピクセル合成 ----

function colorAt(x, y) {
  // 背景: 透明 → 角丸スクエアに対角グラデーション (#4f8cff → #7c5cff)
  let r = 0, g = 0, b = 0, a = 0;

  if (inRoundedRect(x, y, 40, 40, SIZE - 80, SIZE - 80, 190)) {
    const t = (x + y) / (2 * SIZE);
    r = 0x4f + (0x7c - 0x4f) * t;
    g = 0x8c + (0x5c - 0x8c) * t;
    b = 0xff;
    a = 1;
  } else {
    return [0, 0, 0, 0];
  }

  const over = (cr, cg, cb, ca) => {
    r = cr * ca + r * (1 - ca);
    g = cg * ca + g * (1 - ca);
    b = cb * ca + b * (1 - ca);
  };

  // 奥のディスプレイ (半透明の白)
  if (inRoundedRect(x, y, 175, 255, 520, 355, 36)) over(255, 255, 255, 0.35);

  // 手前のディスプレイ (白フチ + ダークな画面)
  const fx = 330, fy = 415, fw = 525, fh = 355, border = 30;
  if (inRoundedRect(x, y, fx, fy, fw, fh, 36)) {
    if (inRoundedRect(x, y, fx + border, fy + border, fw - border * 2, fh - border * 2, 18)) {
      over(0x14, 0x18, 0x1e, 1); // 画面部分
    } else {
      over(255, 255, 255, 1); // フチ
    }
  }

  return [r, g, b, a * 255];
}

// ---- PNG エンコード ----

const crcTable = [];
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
let offset = 0;
for (let y = 0; y < SIZE; y++) {
  raw[offset++] = 0; // フィルタ: None
  for (let x = 0; x < SIZE; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const [cr, cg, cb, ca] = colorAt(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
        r += cr; g += cg; b += cb; a += ca;
      }
    }
    const n = SS * SS;
    raw[offset++] = Math.round(r / n);
    raw[offset++] = Math.round(g / n);
    raw[offset++] = Math.round(b / n);
    raw[offset++] = Math.round(a / n);
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;  // ビット深度
ihdr[9] = 6;  // カラータイプ: RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = path.join(__dirname, '..', 'build', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log(`${out} (${(png.length / 1024).toFixed(1)} KB) を生成しました`);
