// Option キーの「単独タップ」を検出して回数を報告するヘルパー。
//
// 修飾キー単独の押下は通常のホットキーでは捕まえられないため、
// CGEventTap でキーイベントを監視する(読み取り専用。入力は改変しない)。
// アクセシビリティ(入力監視)の許可が必要。
//
// ビルド (macOS 上):
//   clang -O2 -framework ApplicationServices tools/mac/modifier-tap.m -o build/ModifierTap
//
// 実行: ./ModifierTap [right|left|both] [判定待ち秒数]
//   標準出力に "ready" / "tap:<回数>" / "error:permission" を出す。
//
// 単独タップと見なす条件:
//   - Option を押してから離すまでに他のキー入力やクリックが無い
//   - 押してから離すまでが 0.5 秒以内(押しっぱなしは無視する)

#include <ApplicationServices/ApplicationServices.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const int64_t KEY_LEFT_OPTION = 58;
static const int64_t KEY_RIGHT_OPTION = 61;
static const double MAX_HOLD_SEC = 0.5;

static int gSide = 2; // 0=both, 1=left, 2=right
static double gWindowSec = 0.35;
static bool gOptionDown = false;
static double gDownTime = 0;
static bool gOtherInput = false;
static int gTapCount = 0;
static CFRunLoopTimerRef gTimer = NULL;
static CFMachPortRef gTap = NULL;

static void clearTimer(void) {
  if (gTimer) {
    CFRunLoopTimerInvalidate(gTimer);
    CFRelease(gTimer);
    gTimer = NULL;
  }
}

static void emitTaps(CFRunLoopTimerRef timer, void *info) {
  (void)timer;
  (void)info;
  if (gTapCount > 0) {
    printf("tap:%d\n", gTapCount);
    fflush(stdout);
  }
  gTapCount = 0;
  clearTimer();
}

// 最後のタップから gWindowSec 経ってから回数を報告する
static void scheduleEmit(void) {
  clearTimer();
  gTimer = CFRunLoopTimerCreate(kCFAllocatorDefault, CFAbsoluteTimeGetCurrent() + gWindowSec, 0, 0,
                                0, emitTaps, NULL);
  CFRunLoopAddTimer(CFRunLoopGetCurrent(), gTimer, kCFRunLoopCommonModes);
}

static bool wantedSide(int64_t keycode) {
  if (gSide == 0) return keycode == KEY_LEFT_OPTION || keycode == KEY_RIGHT_OPTION;
  if (gSide == 1) return keycode == KEY_LEFT_OPTION;
  return keycode == KEY_RIGHT_OPTION;
}

static CGEventRef onEvent(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void *refcon) {
  (void)proxy;
  (void)refcon;

  // タイムアウトなどで無効化されたら復帰させる
  if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) {
    if (gTap) CGEventTapEnable(gTap, true);
    return event;
  }

  if (type == kCGEventFlagsChanged) {
    int64_t keycode = CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode);
    bool isOptionKey = (keycode == KEY_LEFT_OPTION || keycode == KEY_RIGHT_OPTION);

    if (isOptionKey) {
      bool down = (CGEventGetFlags(event) & kCGEventFlagMaskAlternate) != 0;
      if (down) {
        gOptionDown = true;
        gDownTime = CFAbsoluteTimeGetCurrent();
        gOtherInput = false;
      } else {
        double held = CFAbsoluteTimeGetCurrent() - gDownTime;
        if (gOptionDown && !gOtherInput && held < MAX_HOLD_SEC && wantedSide(keycode)) {
          gTapCount++;
          scheduleEmit();
        }
        gOptionDown = false;
      }
    } else if (gOptionDown) {
      // 他の修飾キーと組み合わせて使われた
      gOtherInput = true;
    }
  } else if (gOptionDown) {
    // Option を押している間のキー入力・クリック・スクロール
    gOtherInput = true;
  }

  return event;
}

int main(int argc, char **argv) {
  if (argc > 1) {
    if (strcmp(argv[1], "left") == 0) gSide = 1;
    else if (strcmp(argv[1], "both") == 0) gSide = 0;
    else gSide = 2;
  }
  if (argc > 2) {
    double w = atof(argv[2]);
    if (w >= 0.15 && w <= 1.0) gWindowSec = w;
  }

  CGEventMask mask = CGEventMaskBit(kCGEventFlagsChanged) | CGEventMaskBit(kCGEventKeyDown) |
                     CGEventMaskBit(kCGEventLeftMouseDown) | CGEventMaskBit(kCGEventRightMouseDown) |
                     CGEventMaskBit(kCGEventOtherMouseDown) | CGEventMaskBit(kCGEventScrollWheel);

  gTap = CGEventTapCreate(kCGSessionEventTap, kCGHeadInsertEventTap, kCGEventTapOptionListenOnly,
                          mask, onEvent, NULL);
  if (!gTap) {
    printf("error:permission\n");
    fflush(stdout);
    return 1;
  }

  CFRunLoopSourceRef source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, gTap, 0);
  CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopCommonModes);
  CGEventTapEnable(gTap, true);

  printf("ready\n");
  fflush(stdout);

  CFRunLoopRun();
  return 0;
}
