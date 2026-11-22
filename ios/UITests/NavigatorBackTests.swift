import XCTest

/// The Navigator convention: while the document can go back, the navigation bar's back pops
/// inside it; at its start, back (the bar's, or the document's own arrow, a host action "back")
/// leaves the screen. Needs a showcase that plays kobento-mcp's Navigator demo, named in
/// TEST_RUNNER_NAVIGATOR_SHOWCASE (default SHW-90), in the app's showcases. iPhone 17 Pro points.
final class NavigatorBackTests: XCTestCase {
    private var showcase: String { ProcessInfo.processInfo.environment["NAVIGATOR_SHOWCASE"] ?? "SHW-90" }

    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-showcase", showcase]
        app.launch()
        sleep(2)
        return app
    }

    private func shot(_ app: XCUIApplication, _ name: String) {
        let s = XCTAttachment(screenshot: app.screenshot())
        s.name = name
        s.lifetime = .keepAlways
        add(s)
    }

    private func tap(_ app: XCUIApplication, _ x: CGFloat, _ y: CGFloat) {
        app.windows.firstMatch.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: y)).tap()
        sleep(1)
    }

    func testBarBackPopsInsideTheDocumentThenLeaves() {
        let app = launch()
        tap(app, 200, 320)   // Balcony: pushes the room's plants
        shot(app, "pushed")
        let back = app.navigationBars.buttons["Back"]
        XCTAssertTrue(back.waitForExistence(timeout: 3), "the bar's back is the document's")
        back.tap()
        sleep(1)
        shot(app, "popped")
        XCTAssertTrue(app.staticTexts["SHW-90"].exists || app.staticTexts[showcase].exists, "still on the showcase")
        // At the start the bar's back is the system's again: it leaves.
        app.navigationBars.buttons.firstMatch.tap()
        sleep(1)
        shot(app, "left")
        XCTAssertFalse(app.staticTexts[showcase].exists, "back at the start leaves the showcase")
    }

    func testTheDocumentsStartArrowLeaves() {
        let app = launch()
        tap(app, 40, 198)   // the document's own arrow at its start: host action "back"
        shot(app, "after the start arrow")
        XCTAssertFalse(app.staticTexts[showcase].exists, "the host action back leaves the showcase")
    }
}
