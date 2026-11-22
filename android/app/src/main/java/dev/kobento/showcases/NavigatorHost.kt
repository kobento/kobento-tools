package dev.kobento.showcases

import androidx.activity.compose.BackHandler
import androidx.compose.remote.core.CoreDocument
import androidx.compose.remote.player.view.RemoteComposePlayer
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import kotlinx.coroutines.delay

/**
 * The app's side of the Navigator convention (kobento-mcp's Navigator component, which any
 * document may follow): the document navigates inside itself and the app keeps the back
 * gesture's meaning.
 *
 * - The document exports `canGoBack`: 1 while back is its own (its stack is deeper than one, a
 *   sheet is open). Then the system back, predictive gesture included, is the document's: each
 *   press adds 1 to its exported `backCount`, and it pops. Otherwise back is the app's, and the
 *   handlers further up (MainActivity's) take it.
 * - The document asks the app with host actions: `back` (its start screen's back: leave it) and
 *   `navigate`, whose value is a route of the app's, maybe with `?presentation=modal|replace`.
 *
 * `canGoBack` is read every 50 ms, so the handler is enabled before a gesture starts. A document
 * without these variables reads NaN: the handler stays off. (The player throws for a name the
 * document does not have, NoSuchElementException, where the newer sources return NaN.)
 */
@Composable
internal fun NavigatorHost(player: RemoteComposePlayer, onBack: () -> Unit, onNavigate: (String) -> Unit) {
    var canGoBack by remember(player) { mutableStateOf(false) }
    LaunchedEffect(player) {
        while (true) {
            canGoBack = player.floatOrNaN("canGoBack") > 0.5f
            delay(50)
        }
    }
    BackHandler(enabled = canGoBack) {
        val n = player.floatOrNaN("backCount")
        player.setLocalFloat("backCount", (if (n.isNaN()) 0f else n) + 1f)
        // setLocalFloat invalidates the document, not the view: an idle player would not draw
        // (nor re-evaluate what reads backCount) until something else asked for a frame.
        player.invalidate()
    }
    val back by rememberUpdatedState(onBack)
    val navigate by rememberUpdatedState(onNavigate)
    DisposableEffect(player) {
        // Lives as long as the player's document: the player is made again for each look.
        player.document.document.addActionCallback(CoreDocument.ActionCallback { name, value ->
            when (name) {
                "back" -> back()
                "navigate" -> navigate(value?.toString().orEmpty())
            }
        })
        onDispose { }
    }
}

/** A float the document exports, or NaN when it has none of that name. */
private fun RemoteComposePlayer.floatOrNaN(name: String): Float =
    try { getNamedFloat(name) } catch (_: NoSuchElementException) { Float.NaN }
