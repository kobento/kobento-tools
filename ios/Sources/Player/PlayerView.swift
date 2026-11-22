import MetalKit
import SwiftUI

/// A RemoteCompose document filling its frame: laid out to it in points, drawn by `KBPlayer`
/// (the C++ engine, Skia on Metal) at the screen's refresh rate while it animates, paused
/// while it does not. Touches go to the document in the same coordinates.
struct PlayerView: UIViewRepresentable {
    let bytes: Data
    let dark: Bool
    var background: UIColor = .systemBackground
    /// The app's side of the Navigator convention, if the screen keeps back's meaning.
    var nav: NavigatorBridge? = nil

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> DocumentMTKView {
        let c = context.coordinator
        let view = DocumentMTKView(frame: .zero, device: c.device)
        view.framebufferOnly = false            // Skia reads back what it draws
        view.colorPixelFormat = .bgra8Unorm
        view.isOpaque = true
        view.autoResizeDrawable = true
        view.preferredFramesPerSecond = UIScreen.main.maximumFramesPerSecond   // 120 on ProMotion
        view.delegate = c
        view.player = c.player
        c.view = view
        if let nav {
            nav.player = c.player
            nav.wake = { [weak c] in c?.wake() }
            c.player.onNamedAction = { [weak nav] name, value in nav?.action(name, value) }
        }
        c.load(bytes, dark: dark, background: background)
        return view
    }

    func updateUIView(_ view: DocumentMTKView, context: Context) {
        context.coordinator.load(bytes, dark: dark, background: background)
    }

    final class Coordinator: NSObject, MTKViewDelegate {
        let device: MTLDevice
        let player: KBPlayer
        weak var view: DocumentMTKView?
        private var bytes = Data()
        private var animTime = 0.0
        private var last: CFTimeInterval = 0

        override init() {
            guard let device = MTLCreateSystemDefaultDevice(), let queue = device.makeCommandQueue(),
                  let player = KBPlayer(device: device, commandQueue: queue) else {
                fatalError("Metal is not available")
            }
            self.device = device
            self.player = player
        }

        func load(_ data: Data, dark: Bool, background: UIColor) {
            player.backgroundArgb = background.argb
            if data != bytes {
                bytes = data
                if !player.load(data) { print("[PlayerView] cannot read the document (\(data.count) bytes)") }
                animTime = 0
                last = 0
            }
            player.dark = dark
            wake()
        }

        /// Draws again: after a touch, a resize, a new document or theme.
        func wake() { view?.run() }

        func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) { wake() }

        func draw(in view: MTKView) {
            let now = CACurrentMediaTime()
            let dt = last == 0 ? 1.0 / 60 : min(now - last, 0.25)
            last = now
            animTime += dt
            player.draw(in: view, animTime: animTime, deltaTime: dt)
            // Nothing moving: stop the display link until something changes (a touch, a resize).
            if !player.needsAnimation() && !((view as? DocumentMTKView)?.touching ?? false) {
                (view as? DocumentMTKView)?.rest()
                last = 0
            }
        }
    }
}

/// The Metal view, with the document's touches: down, drag and up with the release velocity.
final class DocumentMTKView: MTKView {
    weak var player: KBPlayer?
    private(set) var touching = false
    private var samples: [(p: CGPoint, t: TimeInterval)] = []
    private var start: CGPoint?

    /// Draws every frame (the display link runs).
    func run() {
        enableSetNeedsDisplay = false
        isPaused = false
    }

    /// Stops the display link; a later run() starts it again.
    func rest() {
        isPaused = true
        enableSetNeedsDisplay = true
    }

    private func wake() { run() }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard let t = touches.first else { return }
        let p = t.location(in: self)
        touching = true
        start = p
        samples = [(p, t.timestamp)]
        player?.touchDownX(Float(p.x), y: Float(p.y))
        wake()
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard let t = touches.first else { return }
        let p = t.location(in: self)
        samples.append((p, t.timestamp))
        if samples.count > 6 { samples.removeFirst(samples.count - 6) }
        player?.touchDragX(Float(p.x), y: Float(p.y))
        wake()
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard let t = touches.first else { return }
        let p = t.location(in: self)
        // The release velocity over the last few samples (points a second): the newest sample
        // alone gives zero, as the finger does not move between the last move and the lift.
        var v = CGPoint.zero
        if let first = samples.first, t.timestamp - first.t > 0.001 {
            let dt = t.timestamp - first.t
            v = CGPoint(x: (p.x - first.p.x) / dt, y: (p.y - first.p.y) / dt)
        }
        touching = false
        player?.touchUpX(Float(p.x), y: Float(p.y), velocityX: Float(v.x), velocityY: Float(v.y))
        // A tap is also a click (a button's onClick); a drag that ends over a button is not.
        if let start, hypot(p.x - start.x, p.y - start.y) < 10 { player?.clickX(Float(p.x), y: Float(p.y)) }
        samples = []
        start = nil
        wake()
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
        start = nil   // a cancelled touch is no click
        touchesEnded(touches, with: event)
    }
}

extension UIColor {
    /// 0xAARRGGBB, in the current trait collection.
    var argb: UInt32 {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        getRed(&r, green: &g, blue: &b, alpha: &a)
        let c = { (x: CGFloat) in UInt32(max(0, min(255, (x * 255).rounded()))) }
        return c(a) << 24 | c(r) << 16 | c(g) << 8 | c(b)
    }
}
