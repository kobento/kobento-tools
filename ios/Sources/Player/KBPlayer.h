#import <UIKit/UIKit.h>
#import <MetalKit/MetalKit.h>

NS_ASSUME_NONNULL_BEGIN

/// One RemoteCompose document played with the C++ engine and Skia on Metal, laid out to the view.
///
/// The document is laid out at the view's size in points (dp, as the web and C++ players read a
/// document) and drawn at the screen's scale, so it fills the view and lays out again when the
/// view changes size (a rotation, a split view). Touches are in points, the same coordinates.
@interface KBPlayer : NSObject

- (nullable instancetype)initWithDevice:(id<MTLDevice>)device commandQueue:(id<MTLCommandQueue>)queue;

/// Parses the .rc bytes. NO when they are not a document the engine can read.
- (BOOL)loadData:(NSData *)data;

/// The theme the document is given: dark or light. Changing it restarts the document in it.
@property (nonatomic) BOOL dark;

/// The colour behind the document (ARGB), where it draws nothing.
@property (nonatomic) uint32_t backgroundArgb;

/// The size the document says it is designed at (dp), or zero.
@property (nonatomic, readonly) CGSize designSize;

/// Paints one frame into the view's drawable and presents it.
- (void)drawInView:(MTKView *)view animTime:(double)animTime deltaTime:(double)deltaTime;

/// Whether the document wants another frame: an animation, a clock, a fling coasting.
- (BOOL)needsAnimation;

- (void)touchDownX:(float)x y:(float)y;
- (void)touchDragX:(float)x y:(float)y;
- (void)touchUpX:(float)x y:(float)y velocityX:(float)vx velocityY:(float)vy;
/// A tap: the document's click areas (a button's onClick). Send it after touchUp.
- (void)clickX:(float)x y:(float)y;

/// A float the document exports by that name, or NaN (no such variable, or not started yet).
- (float)floatNamed:(NSString *)name NS_SWIFT_NAME(float(named:));

/// Sets a float the document exports, as a host value (it sticks until the document's own
/// actions write it). NO when the document has no float of that name, or has not started.
- (BOOL)setFloat:(float)value named:(NSString *)name NS_SWIFT_NAME(setFloat(_:named:));

/// A string the document exports by that name, or nil (no such variable, or not started yet).
- (nullable NSString *)stringNamed:(NSString *)name NS_SWIFT_NAME(string(named:));

/// A value the host gives the document by name (an exported string or float variable), kept
/// across restarts: set now if the document has started, and again each time it starts (a new
/// theme starts it again). The document's own actions may still change it. A name the document
/// does not declare is ignored.
- (void)keepString:(NSString *)value named:(NSString *)name NS_SWIFT_NAME(keep(string:named:));
- (void)keepFloat:(float)value named:(NSString *)name NS_SWIFT_NAME(keep(float:named:));

/// The document's host actions (hostNamedAction): the name, and the value as text ("" for none).
@property (nonatomic, copy, nullable) void (^onNamedAction)(NSString *name, NSString *value);

@end

NS_ASSUME_NONNULL_END
