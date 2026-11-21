import XCTest

/// The account flow end to end against a local Kobento server (kobento-mcp's examples and
/// deploy servers behind one origin, http://localhost:8899 by default): sign in through the
/// server's own page, share one of the account's pages to the stream and take it out, vote;
/// report someone else's item, block its author and unblock them, delete the account.
///
///   TEST_RUNNER_KOBENTO_TOKEN=rc_... TEST_RUNNER_KOBENTO_SERVER=http://localhost:8899 \
///     xcodebuild test -scheme KobentoShowcases -destination 'platform=iOS Simulator,name=iPhone 17 Pro'
///
/// testSignInShareAndVote needs an account with at least one published page and no public name
/// yet (the first share sets it). testReportBlockAndDelete needs another account's two items in
/// the stream, and deletes the account it signs in with (TEST_RUNNER_KOBENTO_DELETE_TOKEN, a
/// throwaway one).
final class AccountFlowTests: XCTestCase {
    private var env: [String: String] { ProcessInfo.processInfo.environment }

    func testSignInShareAndVote() throws {
        let token = try XCTUnwrap(env["KOBENTO_TOKEN"], "set TEST_RUNNER_KOBENTO_TOKEN to a test account's token")
        let app = try signedIn(token)

        // Share the first page: the first post also sets the account's public name.
        let card = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'page-'")).firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 15), "a page of the account's")
        card.tap()
        let share = app.buttons["Share to the stream"]
        XCTAssertTrue(share.waitForExistence(timeout: 10))
        share.tap()
        let name = app.textFields["Your name"]
        XCTAssertTrue(name.waitForExistence(timeout: 5), "the first share asks for a public name")
        name.tap()
        name.typeText("iOS tester")
        let tags = app.textFields["Tags"]
        tags.tap()
        tags.typeText("ios, test")
        app.buttons["Share"].tap()
        XCTAssertTrue(app.buttons["Edit or take out of the stream"].waitForExistence(timeout: 10), "shared")

        // It is in the stream: vote it up, and the score follows.
        app.tabBars.buttons["Stream"].tap()
        let up = app.buttons["Vote up"].firstMatch
        XCTAssertTrue(up.waitForExistence(timeout: 10), "the stream lists it")
        up.tap()
        XCTAssertTrue(app.buttons["Vote up (tap again to take it back)"].firstMatch.waitForExistence(timeout: 10), "voted")

        // Take it out again.
        app.tabBars.buttons["Your pages"].tap()
        let edit = app.buttons["Edit or take out of the stream"]
        XCTAssertTrue(edit.waitForExistence(timeout: 10))
        edit.tap()
        app.buttons["Take out of the stream"].tap()
        XCTAssertTrue(app.buttons["Share to the stream"].waitForExistence(timeout: 10), "taken out")
    }

    func testReportBlockAndDelete() throws {
        let token = try XCTUnwrap(env["KOBENTO_DELETE_TOKEN"], "set TEST_RUNNER_KOBENTO_DELETE_TOKEN to a throwaway account's token")
        let app = try signedIn(token)
        app.tabBars.buttons["Stream"].tap()
        let menus = app.buttons.matching(identifier: "Report or block")
        XCTAssertTrue(menus.firstMatch.waitForExistence(timeout: 10), "someone else's items have the menu")
        let before = menus.count

        // Report one: it leaves the list at once.
        menus.firstMatch.tap()
        app.buttons["Report…"].tap()
        let send = app.navigationBars.buttons["Report"]
        XCTAssertTrue(send.waitForExistence(timeout: 5), "the report sheet")
        XCTAssertFalse(send.isEnabled, "a reason first")
        app.buttons["Spam or misleading"].tap()
        send.tap()
        let ok = app.alerts.buttons["OK"]
        XCTAssertTrue(ok.waitForExistence(timeout: 10), "the thank-you note")
        ok.tap()
        XCTAssertEqual(menus.count, before - 1, "the reported item is gone")

        // Block the author: their other items go too.
        menus.firstMatch.tap()
        let block = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Block '")).firstMatch
        XCTAssertTrue(block.waitForExistence(timeout: 5))
        block.tap()
        XCTAssertTrue(ok.waitForExistence(timeout: 10), "blocked")
        ok.tap()
        XCTAssertFalse(menus.firstMatch.waitForExistence(timeout: 2), "the author's items are gone")

        // Unblock from Your pages.
        app.tabBars.buttons["Your pages"].tap()
        app.buttons["People you blocked"].tap()
        let unblock = app.buttons["Unblock"]
        XCTAssertTrue(unblock.waitForExistence(timeout: 10), "the blocked author is listed")
        unblock.tap()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH 'Nobody'")).firstMatch.waitForExistence(timeout: 10))
        app.buttons["Done"].tap()

        // Delete the account: asked first, then signed out.
        app.buttons["Delete account"].tap()
        let confirm = app.alerts.buttons["Delete my account"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 5), "asked first")
        confirm.tap()
        XCTAssertTrue(app.staticTexts["Not signed in"].waitForExistence(timeout: 15), "deleted and signed out")
    }

    /// Launches the app on the test server and signs in with `token` through the server's pages.
    private func signedIn(_ token: String) throws -> XCUIApplication {
        let server = env["KOBENTO_SERVER"] ?? "http://localhost:8899"
        let app = XCUIApplication()
        app.launchArguments = ["-server", server, "-tab", "pages"]
        app.launch()

        // Signed in from an earlier run: sign out first.
        let signOut = app.buttons["Sign out"]
        if signOut.waitForExistence(timeout: 3) { signOut.tap() }

        // Sign in: iOS asks first, then the server's page (its token form, unless Safari is still
        // signed in to the website from an earlier run), then its Allow page.
        let signIn = app.buttons["Sign in"]
        XCTAssertTrue(signIn.waitForExistence(timeout: 10))
        signIn.tap()
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let proceed = springboard.buttons["Continue"]
        XCTAssertTrue(proceed.waitForExistence(timeout: 10), "the system's sign-in prompt")
        proceed.tap()
        // The sign-in sheet is Safari's (its own process), not the app's.
        let web = XCUIApplication(bundleIdentifier: "com.apple.SafariViewService").webViews.firstMatch
        let tokenField = web.secureTextFields.firstMatch
        let allow = web.buttons["Allow"]
        let deadline = Date().addingTimeInterval(15)
        while !tokenField.exists && !allow.exists && Date() < deadline { usleep(250_000) }
        if tokenField.exists {
            tokenField.tap()
            tokenField.typeText(token + "\n")   // Return submits its form (the page has other "Sign in"s)
        }
        XCTAssertTrue(allow.waitForExistence(timeout: 15), "the consent page")
        allow.tap()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH 'Signed in as'")).firstMatch
            .waitForExistence(timeout: 15), "back in the app, signed in")
        return app
    }
}
