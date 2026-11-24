#import "KBPlayer.h"

#import <Metal/Metal.h>

#include <chrono>
#include <vector>

#include "rccore/WireBuffer.h"
#include "rccore/CoreDocument.h"
#include "rccore/RemoteContext.h"
#include "rccore/TimeVariables.h"
#include "rcskia/SkiaPaintContext.h"

#include "include/core/SkCanvas.h"
#include "include/core/SkSurface.h"
#include "include/gpu/ganesh/GrBackendSurface.h"
#include "include/gpu/ganesh/GrDirectContext.h"
#include "include/gpu/ganesh/SkSurfaceGanesh.h"
#include "include/gpu/ganesh/mtl/GrMtlBackendContext.h"
#include "include/gpu/ganesh/mtl/GrMtlBackendSurface.h"
#include "include/gpu/ganesh/mtl/GrMtlDirectContext.h"
#include "include/gpu/ganesh/mtl/GrMtlTypes.h"

// The engine's theme values (applyDataOperations / paint): the document's dark or light colours.
static constexpr int THEME_DARK = -2;
static constexpr int THEME_LIGHT = -3;

@implementation KBPlayer {
    id<MTLDevice> _device;
    id<MTLCommandQueue> _queue;
    sk_sp<GrDirectContext> _grContext;

    std::vector<uint8_t> _bytes;
    std::unique_ptr<rccore::CoreDocument> _doc;
    std::unique_ptr<rccore::RemoteContext> _context;
    std::unique_ptr<rcskia::SkiaPaintContext> _paintCtx;
    rccore::TimeVariables _timeVars;
    BOOL _needsSetup;
    // Values the host keeps on the document (keepString / keepFloat): NSString or NSNumber.
    NSMutableDictionary<NSString *, id> *_kept;
}

- (instancetype)initWithDevice:(id<MTLDevice>)device commandQueue:(id<MTLCommandQueue>)queue {
    self = [super init];
    if (!self) return nil;
    _device = device;
    _queue = queue;
    GrMtlBackendContext backend;
    backend.fDevice.retain((__bridge GrMTLHandle)_device);
    backend.fQueue.retain((__bridge GrMTLHandle)_queue);
    _grContext = GrDirectContexts::MakeMetal(backend);
    if (!_grContext) return nil;
    _backgroundArgb = 0xFF000000;
    return self;
}

- (void)dealloc {
    // The paint context holds Skia objects made on this GPU context: let them go first.
    _paintCtx = nullptr;
    _context = nullptr;
    _doc = nullptr;
    if (_grContext) _grContext->abandonContext();
}

- (BOOL)loadData:(NSData *)data {
    _bytes.assign((const uint8_t *)data.bytes, (const uint8_t *)data.bytes + data.length);
    _paintCtx = nullptr;
    _context = nullptr;
    _doc = std::make_unique<rccore::CoreDocument>();
    try {
        rccore::WireBuffer buffer(_bytes.data(), _bytes.size());
        if (!_doc->initFromBuffer(buffer)) { _doc = nullptr; return NO; }
    } catch (const std::exception &e) {
        NSLog(@"[KBPlayer] cannot read the document (%lu bytes): %s", (unsigned long)data.length, e.what());
        _doc = nullptr;
        return NO;
    }
    _needsSetup = YES;
    return YES;
}

- (void)setDark:(BOOL)dark {
    if (dark == _dark) return;
    _dark = dark;
    // The theme goes in with the data pass: start the document again in the other one.
    if (_doc && _context) [self loadData:[NSData dataWithBytes:_bytes.data() length:_bytes.size()]];
}

- (CGSize)designSize {
    return _doc ? CGSizeMake(_doc->getWidth(), _doc->getHeight()) : CGSizeZero;
}

- (int)theme { return _dark ? THEME_DARK : THEME_LIGHT; }

/// A fresh context for the document: its variables, listeners and data pass, at `size` (points).
- (void)setupAt:(CGSize)size {
    _context = std::make_unique<rccore::RemoteContext>();
    _paintCtx = std::make_unique<rcskia::SkiaPaintContext>(*_context, nullptr);
    _context->setPaintContext(_paintCtx.get());
    _context->setDocument(_doc.get());
    _context->mWidth = (float)size.width;
    _context->mHeight = (float)size.height;
    _context->mDensity = 1.0f;   // laid out in dp; the canvas scale takes it to pixels
    __weak KBPlayer *weakSelf = self;
    _context->hostNamedAction = [weakSelf](const std::string &name, int, const std::string &value) {
        KBPlayer *me = weakSelf;
        if (!me || !me.onNamedAction) return;
        NSString *n = [NSString stringWithUTF8String:name.c_str()] ?: @"";
        NSString *v = [NSString stringWithUTF8String:value.c_str()] ?: @"";
        // Actions run inside a touch or a paint: the app hears of them after it.
        dispatch_async(dispatch_get_main_queue(), ^{ if (me.onNamedAction) me.onNamedAction(n, v); });
    };
    _doc->registerListeners(*_context);
    _doc->applyDataOperations(*_context, [self theme]);
    _timeVars = rccore::TimeVariables();
    _needsSetup = NO;
    for (NSString *name in _kept) [self apply:_kept[name] named:name];
}

/// Sets one kept value on the started document; NO when it has no variable of that name.
- (BOOL)apply:(id)value named:(NSString *)name {
    if (!_context) return NO;
    int id = _context->namedVariableId(name.UTF8String);
    if (id < 0) return NO;
    if ([value isKindOfClass:NSString.class]) _context->overrideText(id, ((NSString *)value).UTF8String);
    else _context->overrideFloat(id, [(NSNumber *)value floatValue]);
    return YES;
}

- (void)keepString:(NSString *)value named:(NSString *)name {
    if (!_kept) _kept = [NSMutableDictionary dictionary];
    _kept[name] = [value copy];
    [self apply:value named:name];
}

- (void)keepFloat:(float)value named:(NSString *)name {
    if (!_kept) _kept = [NSMutableDictionary dictionary];
    _kept[name] = @(value);
    [self apply:@(value) named:name];
}

- (NSString *)stringNamed:(NSString *)name {
    if (!_context) return nil;
    int id = _context->namedVariableId(name.UTF8String);
    if (id < 0) return nil;
    return [NSString stringWithUTF8String:_context->getText(id).c_str()];
}

- (void)drawInView:(MTKView *)view animTime:(double)animTime deltaTime:(double)deltaTime {
    if (!_doc || !_grContext) return;
    id<CAMetalDrawable> drawable = view.currentDrawable;
    if (!drawable) return;
    id<MTLTexture> texture = drawable.texture;
    CGSize points = view.bounds.size;
    if (points.width <= 0 || points.height <= 0) return;
    float scale = (float)texture.width / (float)points.width;

    if (_needsSetup || !_context) [self setupAt:points];

    try {
        GrMtlTextureInfo info;
        info.fTexture.retain((__bridge GrMTLHandle)texture);
        GrBackendRenderTarget target = GrBackendRenderTargets::MakeMtl((int)texture.width, (int)texture.height, info);
        sk_sp<SkSurface> surface = SkSurfaces::WrapBackendRenderTarget(
            _grContext.get(), target, kTopLeft_GrSurfaceOrigin, kBGRA_8888_SkColorType, nullptr, nullptr);
        if (!surface) return;

        SkCanvas *canvas = surface->getCanvas();
        canvas->clear((SkColor)_backgroundArgb);
        canvas->save();
        canvas->scale(scale, scale);
        _paintCtx->setCanvas(canvas);
        // Software 3D at 2x the document's resolution (a 3x screen would cost 9x the 3D time
        // for little more): sharp next to the 2D, not a 1x picture scaled up.
        _paintCtx->setSupersample3D(std::max(1, std::min(2, (int)lroundf(scale))));
        // Laid out at the view's size every frame: a rotation or a resize lays it out again.
        _context->mWidth = (float)points.width;
        _context->mHeight = (float)points.height;
        _timeVars.updateTime(*_context, animTime, deltaTime);
        [self loadPower];
        _doc->paint(*_context, [self theme]);
        canvas->restore();

        _grContext->flushAndSubmit(GrSyncCpu::kNo);
        id<MTLCommandBuffer> cmd = [_queue commandBuffer];
        [cmd presentDrawable:drawable];
        [cmd commit];
    } catch (const std::exception &e) {
        NSLog(@"[KBPlayer] paint failed: %s", e.what());
    }
}

/// The device's battery for the document (a watch face's battery ring): 0..100 and the power
/// state, -1 when unknown (the Simulator has no battery). The engine reads them; the host sets them.
- (void)loadPower {
    UIDevice *d = UIDevice.currentDevice;
    if (!d.batteryMonitoringEnabled) d.batteryMonitoringEnabled = YES;
    float level = d.batteryLevel < 0 ? -1.0f : roundf(d.batteryLevel * 100.0f);
    float power;
    switch (d.batteryState) {
        case UIDeviceBatteryStateUnplugged: power = 0; break;
        case UIDeviceBatteryStateCharging: power = 1; break;
        case UIDeviceBatteryStateFull: power = 2; break;
        default: power = -1; break;
    }
    _context->loadFloat(rccore::RemoteContext::ID_BATTERY_LEVEL, level);
    _context->loadFloat(rccore::RemoteContext::ID_POWER_STATE, power);
}

- (BOOL)needsAnimation {
    if (!_context) return YES;   // not painted yet
    const int64_t now = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
    if (_context->getRepaintDelay(now) > 0) return YES;
    // A document can ask for the next frame itself: a fling coasting after the finger lifts.
    if (rccore::PaintContext *pc = _context->getPaintContext()) {
        if (pc->doesNeedsRepaint()) return YES;
    }
    return NO;
}

- (void)touchDownX:(float)x y:(float)y {
    if (_doc && _context) _doc->touchDown(*_context, x, y);
}

- (void)touchDragX:(float)x y:(float)y {
    if (_doc && _context) _doc->touchDrag(*_context, x, y);
}

- (void)touchUpX:(float)x y:(float)y velocityX:(float)vx velocityY:(float)vy {
    if (_doc && _context) _doc->touchUp(*_context, x, y, vx, vy);
}

- (void)clickX:(float)x y:(float)y {
    // Clicks are their own dispatch (click areas), not part of the touch listeners.
    if (_doc && _context) _doc->onClick(*_context, x, y);
}

- (float)floatNamed:(NSString *)name {
    if (!_context) return NAN;
    int id = _context->namedVariableId(name.UTF8String);
    return id < 0 ? NAN : _context->getFloat(id);
}

- (BOOL)setFloat:(float)value named:(NSString *)name {
    if (!_context) return NO;
    int id = _context->namedVariableId(name.UTF8String);
    if (id < 0) return NO;
    _context->overrideFloat(id, value);
    return YES;
}

@end
