// 受信側 (Windows) のキーボード・マウス操作を Mac 側で再現するヘルパー。
//
// 標準入力から 1 行 1 コマンドを読み、CGEvent を合成して投げる。
// 他アプリへイベントを送るためアクセシビリティの許可が必要。
//
// ビルド (macOS 上):
//   clang -O2 -framework ApplicationServices tools/mac/input-inject.m -o build/InputInject
//
// コマンド:
//   m <x> <y>                   マウス移動 (グローバル座標)
//   d <button> <x> <y>          ボタン押下   button: 0=左 1=中 2=右
//   u <button> <x> <y>          ボタン離す
//   s <dy> <dx>                 スクロール (行単位)
//   k <keycode> <1|0> <flags>   キー押下/離す (flags は CGEventFlags)
//   q                           終了

#include <ApplicationServices/ApplicationServices.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>

static CGPoint gPos = {0, 0};
static bool gLeftDown = false;
static bool gRightDown = false;
static bool gMiddleDown = false;

static void post(CGEventRef event) {
  if (!event) return;
  CGEventPost(kCGHIDEventTap, event);
  CFRelease(event);
}

// ボタンを押している間の移動はドラッグとして送る必要がある
static void postMove(void) {
  CGEventType type = kCGEventMouseMoved;
  CGMouseButton button = kCGMouseButtonLeft;
  if (gLeftDown) {
    type = kCGEventLeftMouseDragged;
  } else if (gRightDown) {
    type = kCGEventRightMouseDragged;
    button = kCGMouseButtonRight;
  } else if (gMiddleDown) {
    type = kCGEventOtherMouseDragged;
    button = kCGMouseButtonCenter;
  }
  post(CGEventCreateMouseEvent(NULL, type, gPos, button));
}

static void postButton(int button, bool down) {
  CGEventType type;
  CGMouseButton cgButton;
  switch (button) {
    case 1:
      type = down ? kCGEventOtherMouseDown : kCGEventOtherMouseUp;
      cgButton = kCGMouseButtonCenter;
      gMiddleDown = down;
      break;
    case 2:
      type = down ? kCGEventRightMouseDown : kCGEventRightMouseUp;
      cgButton = kCGMouseButtonRight;
      gRightDown = down;
      break;
    default:
      type = down ? kCGEventLeftMouseDown : kCGEventLeftMouseUp;
      cgButton = kCGMouseButtonLeft;
      gLeftDown = down;
      break;
  }
  post(CGEventCreateMouseEvent(NULL, type, gPos, cgButton));
}

int main(void) {
  char line[256];
  setvbuf(stdout, NULL, _IONBF, 0);

  while (fgets(line, sizeof(line), stdin)) {
    char cmd = line[0];

    if (cmd == 'q') break;

    if (cmd == 'm') {
      double x, y;
      if (sscanf(line + 1, "%lf %lf", &x, &y) == 2) {
        gPos = CGPointMake(x, y);
        postMove();
      }
    } else if (cmd == 'd' || cmd == 'u') {
      int button;
      double x, y;
      if (sscanf(line + 1, "%d %lf %lf", &button, &x, &y) == 3) {
        gPos = CGPointMake(x, y);
        postButton(button, cmd == 'd');
      }
    } else if (cmd == 's') {
      double dy, dx;
      if (sscanf(line + 1, "%lf %lf", &dy, &dx) == 2) {
        post(CGEventCreateScrollWheelEvent(NULL, kCGScrollEventUnitLine, 2, (int32_t)dy,
                                           (int32_t)dx));
      }
    } else if (cmd == 'k') {
      int keycode, down;
      unsigned long long flags;
      if (sscanf(line + 1, "%d %d %llu", &keycode, &down, &flags) == 3) {
        CGEventRef event = CGEventCreateKeyboardEvent(NULL, (CGKeyCode)keycode, down != 0);
        if (event) {
          CGEventSetFlags(event, (CGEventFlags)flags);
          post(event);
        }
      }
    }
  }
  return 0;
}
