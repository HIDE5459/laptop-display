// ブラウザの KeyboardEvent.code から macOS の仮想キーコードへの対応表。
// 受信側 (Windows) のキー入力を Mac で再現するために使う。

const KEY_CODES = {
  KeyA: 0, KeyS: 1, KeyD: 2, KeyF: 3, KeyH: 4, KeyG: 5, KeyZ: 6, KeyX: 7,
  KeyC: 8, KeyV: 9, KeyB: 11, KeyQ: 12, KeyW: 13, KeyE: 14, KeyR: 15,
  KeyY: 16, KeyT: 17, KeyO: 31, KeyU: 32, KeyI: 34, KeyP: 35, KeyL: 37,
  KeyJ: 38, KeyK: 40, KeyN: 45, KeyM: 46,

  Digit1: 18, Digit2: 19, Digit3: 20, Digit4: 21, Digit6: 22, Digit5: 23,
  Digit9: 25, Digit7: 26, Digit8: 28, Digit0: 29,

  Equal: 24, Minus: 27, BracketRight: 30, BracketLeft: 33, Quote: 39,
  Semicolon: 41, Backslash: 42, Comma: 43, Slash: 44, Period: 47,
  Backquote: 50,

  Enter: 36, Tab: 48, Space: 49, Backspace: 51, Escape: 53, Delete: 117,
  CapsLock: 57,

  // 修飾キー(単独で押された場合も送る)
  MetaLeft: 55, MetaRight: 54, ShiftLeft: 56, ShiftRight: 60,
  AltLeft: 58, AltRight: 61, ControlLeft: 59, ControlRight: 62,

  ArrowLeft: 123, ArrowRight: 124, ArrowDown: 125, ArrowUp: 126,
  Home: 115, End: 119, PageUp: 116, PageDown: 121, Insert: 114,

  F1: 122, F2: 120, F3: 99, F4: 118, F5: 96, F6: 97, F7: 98, F8: 100,
  F9: 101, F10: 109, F11: 103, F12: 111,

  Numpad0: 82, Numpad1: 83, Numpad2: 84, Numpad3: 85, Numpad4: 86,
  Numpad5: 87, Numpad6: 88, Numpad7: 89, Numpad8: 91, Numpad9: 92,
  NumpadDecimal: 65, NumpadMultiply: 67, NumpadAdd: 69, NumpadDivide: 75,
  NumpadEnter: 76, NumpadSubtract: 78, NumpadEqual: 81,

  // 日本語キーボード
  IntlYen: 93, IntlBackslash: 10, IntlRo: 94, Convert: 104, NonConvert: 102,
  KanaMode: 104, Lang1: 104, Lang2: 102,
};

// CGEventFlags
const FLAG_SHIFT = 0x00020000;
const FLAG_CONTROL = 0x00040000;
const FLAG_ALTERNATE = 0x00080000;
const FLAG_COMMAND = 0x00100000;

// Windows のキーボードから Mac を操作するときの入れ替え。
// Ctrl+C などをそのまま使えるように Ctrl を Command として扱うのが既定。
function remapModifiers(mods, swapCtrlCommand) {
  if (!swapCtrlCommand) return mods;
  return {
    shift: mods.shift,
    alt: mods.alt,
    ctrl: mods.meta, // Windows キー → Control
    meta: mods.ctrl, // Ctrl → Command
  };
}

function flagsFrom(mods) {
  let flags = 0;
  if (mods.shift) flags |= FLAG_SHIFT;
  if (mods.ctrl) flags |= FLAG_CONTROL;
  if (mods.alt) flags |= FLAG_ALTERNATE;
  if (mods.meta) flags |= FLAG_COMMAND;
  return flags;
}

// 修飾キー自体の code も入れ替える(Ctrl キーを押したら Command を押したことにする)
const SWAPPED_CODES = {
  ControlLeft: 'MetaLeft',
  ControlRight: 'MetaRight',
  MetaLeft: 'ControlLeft',
  MetaRight: 'ControlRight',
};

function keycodeFor(code, swapCtrlCommand) {
  const effective = swapCtrlCommand && SWAPPED_CODES[code] ? SWAPPED_CODES[code] : code;
  const keycode = KEY_CODES[effective];
  return typeof keycode === 'number' ? keycode : null;
}

module.exports = { KEY_CODES, keycodeFor, flagsFrom, remapModifiers };
