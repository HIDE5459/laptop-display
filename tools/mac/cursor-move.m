// カーソルを指定座標へ移動する小さなヘルパー。
//
// 画面が増えるとカーソルを見失いやすいため、ホットキーで
// 各ディスプレイの中央へ飛ばせるようにするために使う。
// CGWarpMouseCursorPosition は公開 API で、追加の権限も不要。
//
// ビルド (macOS 上):
//   clang -O2 -framework CoreGraphics tools/mac/cursor-move.m -o build/CursorMove
//
// 実行: ./CursorMove <x> <y>   (グローバル座標。左上原点)

#include <CoreGraphics/CoreGraphics.h>
#include <stdio.h>
#include <stdlib.h>

int main(int argc, char **argv) {
  if (argc < 3) {
    fprintf(stderr, "usage: CursorMove <x> <y>\n");
    return 2;
  }

  CGPoint point = CGPointMake(atof(argv[1]), atof(argv[2]));
  CGError err = CGWarpMouseCursorPosition(point);
  if (err != kCGErrorSuccess) {
    fprintf(stderr, "CGWarpMouseCursorPosition failed: %d\n", err);
    return 1;
  }

  // ワープ直後はマウスの物理的な移動とカーソル位置の対応が
  // 一時的に外れることがあるため、明示的に結び直す。
  CGAssociateMouseAndMouseCursorPosition(true);
  return 0;
}
