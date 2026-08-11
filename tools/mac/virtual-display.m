// macOS 仮想ディスプレイ作成ヘルパー
//
// CoreGraphics の CGVirtualDisplay(BetterDisplay 等が使っているのと同じ仕組み)で
// 仮想ディスプレイを 1 枚作成する。このプロセスが生きている間だけディスプレイが
// 存在し、終了すると自動的に消える。Electron 側から spawn / kill して使う。
//
// ビルド (macOS 上):
//   clang -O2 -fobjc-arc -framework Foundation -framework CoreGraphics \
//     tools/mac/virtual-display.m -o build/VirtualDisplay
//
// 実行: ./VirtualDisplay [幅 高さ リフレッシュレート]  (既定: 1920 1080 60)

#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>

// ---- 非公開 API の宣言 ----

@interface CGVirtualDisplaySettings : NSObject
@property(nonatomic) uint32_t hiDPI;
@property(nonatomic, strong) NSArray *modes;
@end

@interface CGVirtualDisplayDescriptor : NSObject
@property(nonatomic, strong) NSString *name;
@property(nonatomic) uint32_t maxPixelsWide;
@property(nonatomic) uint32_t maxPixelsHigh;
@property(nonatomic) CGSize sizeInMillimeters;
@property(nonatomic) uint32_t productID;
@property(nonatomic) uint32_t vendorID;
@property(nonatomic) uint32_t serialNum;
@property(nonatomic, strong) dispatch_queue_t queue;
@property(nonatomic, copy) void (^terminationHandler)(id sender, id display);
@end

@interface CGVirtualDisplayMode : NSObject
- (instancetype)initWithWidth:(uint32_t)width
                       height:(uint32_t)height
                  refreshRate:(double)refreshRate;
@end

@interface CGVirtualDisplay : NSObject
@property(nonatomic, readonly) CGDirectDisplayID displayID;
- (instancetype)initWithDescriptor:(CGVirtualDisplayDescriptor *)descriptor;
- (BOOL)applySettings:(CGVirtualDisplaySettings *)settings;
@end

// ---- 本体 ----

int main(int argc, char **argv) {
  @autoreleasepool {
    uint32_t width = argc > 1 ? (uint32_t)atoi(argv[1]) : 1920;
    uint32_t height = argc > 2 ? (uint32_t)atoi(argv[2]) : 1080;
    double refresh = argc > 3 ? atof(argv[3]) : 60.0;
    if (width < 640 || height < 480 || refresh < 30) {
      fprintf(stderr, "invalid arguments\n");
      return 2;
    }

    CGVirtualDisplayDescriptor *desc = [[CGVirtualDisplayDescriptor alloc] init];
    desc.name = @"LaptopDisplay";
    desc.maxPixelsWide = width;
    desc.maxPixelsHigh = height;
    // 約 96dpi 相当の物理サイズにしておくと文字サイズが自然になる
    desc.sizeInMillimeters = CGSizeMake(width * 25.4 / 96.0, height * 25.4 / 96.0);
    desc.productID = 0x4C44; // 'LD'
    desc.vendorID = 0x4C44;
    desc.serialNum = 1;
    desc.queue = dispatch_get_main_queue();
    desc.terminationHandler = ^(id sender, id display) {
      exit(0);
    };

    CGVirtualDisplay *display = [[CGVirtualDisplay alloc] initWithDescriptor:desc];
    if (!display) {
      fprintf(stderr, "failed to create virtual display\n");
      return 1;
    }

    CGVirtualDisplaySettings *settings = [[CGVirtualDisplaySettings alloc] init];
    settings.hiDPI = 0;
    settings.modes = @[ [[CGVirtualDisplayMode alloc] initWithWidth:width
                                                             height:height
                                                        refreshRate:refresh] ];
    if (![display applySettings:settings]) {
      fprintf(stderr, "failed to apply settings\n");
      return 1;
    }

    printf("created %ux%u@%.0fHz id=%u\n", width, height, refresh, display.displayID);
    fflush(stdout);

    [[NSRunLoop mainRunLoop] run];
  }
  return 0;
}
