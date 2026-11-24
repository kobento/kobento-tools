import XCTest

/// An app (kobento-mcp's apps tool) played screen by screen: opened at launch from its link
/// (TEST_RUNNER_KOBENTO_APP), then a list of taps (TEST_RUNNER_APP_TAPS: "x,y" in iPhone 17 Pro
/// points, or "back" for the navigation bar's back, separated by ";"), a screenshot after each,
/// attached and, with TEST_RUNNER_APP_SHOTS (a directory), written there as 1.png, 2.png...
/// Skipped without an app link.
final class AppPlayerTests: XCTestCase {
    func testPlayTheApp() throws {
        let env = ProcessInfo.processInfo.environment
        guard let link = env["KOBENTO_APP"] else { throw XCTSkip("set TEST_RUNNER_KOBENTO_APP to an app's link") }
        let app = XCUIApplication()
        app.launchArguments = ["-tab", "pages", "-app", link] + (env["KOBENTO_SERVER"].map { ["-server", $0] } ?? [])
        app.launch()
        sleep(4)
        let steps = (env["APP_TAPS"] ?? "").split(separator: ";").map { $0.trimmingCharacters(in: .whitespaces) }
        shot(app, 0, "start")
        for (i, step) in steps.enumerated() {
            if step == "back" {
                app.navigationBars.buttons["Back"].tap()
            } else {
                let xy = step.split(separator: ",").compactMap { Double($0) }
                XCTAssertEqual(xy.count, 2, "a tap is x,y: \(step)")
                app.windows.firstMatch.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: xy[0], dy: xy[1])).tap()
            }
            sleep(1)
            shot(app, i + 1, step)
        }
    }

    private func shot(_ app: XCUIApplication, _ n: Int, _ name: String) {
        let s = app.screenshot()
        let a = XCTAttachment(screenshot: s)
        a.name = "\(n) after \(name)"
        a.lifetime = .keepAlways
        add(a)
        if let dir = ProcessInfo.processInfo.environment["APP_SHOTS"] {
            try? s.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(n).png"))
        }
    }
}
