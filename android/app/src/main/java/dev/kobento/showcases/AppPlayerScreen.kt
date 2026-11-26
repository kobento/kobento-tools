package dev.kobento.showcases

import android.annotation.SuppressLint
import android.content.Context
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.remote.core.CoreDocument
import androidx.compose.remote.player.view.RemoteComposePlayer
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.zIndex
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import org.json.JSONObject
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.CubicBezierEasing

/**
 * An app made of several published pages (kobento-mcp's `apps` tool), played screen by screen:
 * the start screen, then each screen a route opens sliding in over the last (a sheet rising from
 * the bottom), with the route's values set as its string variables and the app's shared values
 * on it. Back (the system gesture, a document's back) returns to the screen under it, as it
 * was left: every screen on the stack keeps its own player.
 *
 * The app comes from its link: <link>app.json (the copy frozen when it was published) and
 * <link>screens/<screen>.rc. Routes resolve as the server and the web page resolve them: a route
 * limited to the screen it is sent from first, then an exact route before a pattern
 * ("/plant/:id" passes id).
 *
 * An app with tabs has a bottom bar: each tab keeps its own stack (every player stays alive while
 * another tab shows), a route to a tab's screen switches to it, and tapping the tab showing goes
 * back to its first screen. Values the app marks persist are kept for next time (per app).
 * [fetch] reads the app's files: [download] for a published app, the account's for a draft.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AppPlayerScreen(link: String, title: String, onBack: () -> Unit, fetch: suspend (String) -> ByteArray = { download(it) }, draft: Boolean = false) {
    val base = if (link.endsWith("/")) link else "$link/"
    var attempt by remember { mutableIntStateOf(0) }
    val app by produceState<Result<AppSpec>?>(null, base, attempt) {
        value = runCatching { parseApp(String(fetch("${base}app.json"))) }
    }
    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(app?.getOrNull()?.title ?: title, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(if (draft) "App · draft" else "App", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                },
                navigationIcon = { IconButton(onClick = onBack) { Icon(painterResource(R.drawable.ic_arrow_back), contentDescription = "Back") } },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
            )
        },
    ) { insets ->
        Box(Modifier.fillMaxSize().padding(insets), contentAlignment = Alignment.Center) {
            val result = app
            when {
                result == null -> CircularProgressIndicator()
                result.isFailure -> Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("Could not load this app", style = MaterialTheme.typography.titleMedium)
                    Text(result.exceptionOrNull()?.message.orEmpty(), style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(8.dp))
                    TextButton(onClick = { attempt++ }) { Text("Try again") }
                }
                else -> AppStack(result.getOrThrow(), base, fetch, onLeave = onBack)
            }
        }
    }
}

/** One screen on the stack: which, the values its route passed, how it came in. */
private class StackEntry(val key: Int, val screen: String, val params: Map<String, String>, val sheet: Boolean) {
    var player: AppScreenPlayer? = null
}

@Composable
private fun AppStack(app: AppSpec, base: String, fetch: suspend (String) -> ByteArray, onLeave: () -> Unit) {
    val context = LocalContext.current
    // One stack per tab (one without tabs), each starting on its tab's screen; cur is the tab showing.
    val roots = app.tabs.map { it.screen }.ifEmpty { listOf(app.start) }
    var nextKey by remember(app) { mutableIntStateOf(roots.size) }
    val stacks = remember(app) { roots.mapIndexed { i, r -> mutableStateListOf(StackEntry(i, r, emptyMap(), false)) } }
    var cur by remember(app) { mutableIntStateOf(0) }
    val stack = stacks[cur]
    // The app's shared values, as the screens leave them; those marked persist start from last time.
    val prefs = remember(app) { context.getSharedPreferences("app-values", Context.MODE_PRIVATE) }
    val state = remember(app) {
        mutableStateMapOf<String, Any>().apply {
            app.state.forEach { (n, v) ->
                val key = "${app.id}:$n"
                put(n, if (n in app.persist && prefs.contains(key)) (if (v is String) prefs.getString(key, v)!! else prefs.getFloat(key, v as Float)) else v)
            }
        }
    }
    fun keep(name: String, value: Any) {
        if (name !in app.persist) return
        prefs.edit().apply { if (value is String) putString("${app.id}:$name", value) else putFloat("${app.id}:$name", (value as Number).toFloat()) }.apply()
    }
    // Each screen's document, downloaded once.
    val documents = remember(app) { mutableStateMapOf<String, ByteArray>() }
    var failed by remember(app) { mutableStateOf<String?>(null) }
    LaunchedEffect(app) {
        try {
            coroutineScope {
                app.screens.keys.map { id -> async { id to fetch("${base}screens/$id.rc") } }.forEach { val (id, b) = it.await(); documents[id] = b }
            }
        } catch (e: Exception) { failed = e.message ?: e.toString() }
    }
    failed?.let { Text("Could not load the screens: $it", color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(16.dp)); return }

    fun selectTab(i: Int) {
        if (i == cur) { while (stacks[i].size > 1) stacks[i].removeAt(stacks[i].lastIndex); return }
        cur = i
    }
    fun pop() {
        val st = stacks[cur]
        when {
            st.size > 1 -> st.removeAt(st.lastIndex)
            cur != 0 -> cur = 0          // back on another tab's first screen: the first tab, as Android apps do
            else -> onLeave()
        }
    }
    fun navigate(from: StackEntry, sent: String) {
        val hit = app.resolve(from.screen, sent)
        if (hit == null) { Toast.makeText(context, "$sent goes nowhere in this app", Toast.LENGTH_SHORT).show(); return }
        val (route, params) = hit
        val tab = app.tabs.indexOfFirst { it.screen == route.to }
        if (tab >= 0) {
            // The tab's first screen is what the route names: that tab, back to its first screen.
            cur = tab
            while (stacks[tab].size > 1) stacks[tab].removeAt(stacks[tab].lastIndex)
            stacks[tab].first().player?.let { p -> params.forEach { (k, v) -> p.setString(k, v) } }
            return
        }
        val asked = Regex("[?&]presentation=(\\w+)").find(sent)?.groupValues?.get(1)
        val how = route.presentation ?: if (asked == "modal") "sheet" else asked
        val st = stacks[cur]
        if (how == "replace" && st.size > 1) st.removeAt(st.lastIndex)
        st.add(StackEntry(nextKey++, route.to, params, how == "sheet" || app.screens[route.to]?.sheet == true))
    }
    val onAction by rememberUpdatedState { entry: StackEntry, name: String, value: String ->
        if (entry === stacks[cur].lastOrNull()) when (name) {
            "back" -> pop()
            "navigate" -> navigate(entry, value)
            else -> Toast.makeText(context, "Action to the app: $name", Toast.LENGTH_SHORT).show()
        }
    }

    // Back: the top screen's own first (a Navigator inside it: canGoBack), then the stack's, then the first tab.
    BackHandler(enabled = stack.size > 1 || cur != 0) { pop() }
    val top = stack.lastOrNull()
    var topCanGoBack by remember { mutableStateOf(false) }
    LaunchedEffect(top?.key, cur) {
        // A screen shown again gets the app's values as the others left them.
        top?.player?.let { p -> pushState(p, app, top.screen, state) }
        while (true) {
            val p = top?.player
            if (p != null) {
                topCanGoBack = p.floatOrNaN("canGoBack") > 0.5f
                // What the top screen changed of the shared values.
                for ((name, kind) in app.screens[top.screen]?.vars.orEmpty()) {
                    if (!state.containsKey(name)) continue
                    val now: Any? = if (kind == "string") runCatching { p.getNamedString(name) }.getOrNull() else p.floatOrNaN(name).takeIf { !it.isNaN() }
                    if (now != null && now != state[name]) { state[name] = now; keep(name, now) }
                }
            }
            delay(100)
        }
    }
    BackHandler(enabled = topCanGoBack) {
        val p = top?.player ?: return@BackHandler
        val n = p.floatOrNaN("backCount")
        p.setLocalFloat("backCount", (if (n.isNaN()) 0f else n) + 1f)
        p.invalidate()
    }

    Column(Modifier.fillMaxSize()) {
        BoxWithConstraints(Modifier.fillMaxWidth().weight(1f)) {
            val widthPx = with(LocalDensity.current) { maxWidth.toPx() }
            val heightPx = with(LocalDensity.current) { maxHeight.toPx() }
            // Every tab's stack stays composed (its players alive); the one showing is on top.
            for ((t, st) in stacks.withIndex()) key("tab$t") {
                // A tab switch: the tab chosen fades in over the one showing (which stays as it is
                // under it) while growing from 96% (250 ms), then the one under it goes. The first
                // showing starts at its target: no animation.
                val showing = t == cur
                val alpha by animateFloatAsState(if (showing) 1f else 0f,
                    if (showing) tween(250, easing = FadeThroughEasing) else tween(1, delayMillis = 250), label = "tabAlpha")
                val scale by animateFloatAsState(if (showing) 1f else 0.96f,
                    if (showing) tween(250, easing = FadeThroughEasing) else tween(1, delayMillis = 250), label = "tabScale")
                Box(Modifier.fillMaxSize().zIndex(if (showing) 1f else 0f).graphicsLayer { this.alpha = alpha; scaleX = scale; scaleY = scale }) {
                    if (t == cur || st.any { it.player != null }) StackView(st, app, documents, state, widthPx, heightPx, live = t == cur, onAction = { e, n, v -> onAction(e, n, v) }, onScrim = { pop() })
                }
            }
        }
        if (app.tabs.isNotEmpty()) NavigationBar(containerColor = MaterialTheme.colorScheme.surfaceContainer) {
            app.tabs.forEachIndexed { i, t ->
                NavigationBarItem(
                    selected = i == cur,
                    onClick = { selectTab(i) },
                    icon = { Icon(remember(t, i == cur) { tabIcon(if (i == cur) t.pathSelected ?: t.path else t.path) }, contentDescription = null) },
                    label = { Text(t.label, maxLines = 1) },
                )
            }
        }
    }
}

/** Material's emphasized-decelerate curve, for the fade through's incoming tab. */
private val FadeThroughEasing = CubicBezierEasing(0.2f, 0f, 0f, 1f)

/** One stack's screens, each sliding in over the last (a sheet rising over a dim). */
@Composable
private fun StackView(
    stack: List<StackEntry>, app: AppSpec, documents: Map<String, ByteArray>, state: Map<String, Any>,
    widthPx: Float, heightPx: Float, live: Boolean, onAction: (StackEntry, String, String) -> Unit, onScrim: () -> Unit,
) {
    for ((i, entry) in stack.withIndex()) key(entry.key) {
        val bytes = documents[entry.screen]
        val covered = i < stack.lastIndex && !stack[i + 1].sheet
        if (entry.sheet) Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.32f))
            .clickable(remember { MutableInteractionSource() }, indication = null) { if (live && entry === stack.lastOrNull()) onScrim() })
        // Slides in from the end (a sheet from the bottom) the first time it shows.
        val slide = remember { Animatable(if (i == 0) 0f else 1f) }
        LaunchedEffect(Unit) { slide.animateTo(0f, tween(280)) }
        Box(
            Modifier.fillMaxSize().graphicsLayer {
                if (entry.sheet) translationY = slide.value * heightPx * 0.72f
                else translationX = slide.value * widthPx - if (covered) widthPx * 0.24f else 0f
            },
            contentAlignment = Alignment.BottomCenter,
        ) {
            val frame = if (entry.sheet) Modifier.fillMaxWidth().fillMaxHeight(0.72f).clip(RoundedCornerShape(topStart = 16.dp, topEnd = 16.dp))
                        else Modifier.fillMaxSize()
            Box(frame.background(MaterialTheme.colorScheme.background), contentAlignment = Alignment.Center) {
                if (bytes == null) CircularProgressIndicator()
                else ScreenPlayer(entry, bytes, app, state, onAction = { n, v -> onAction(entry, n, v) })
            }
        }
    }
}

/** A tab's icon: a Material Symbols path in a 960 box (app.json's tabs). */
private fun tabIcon(path: String?): ImageVector = ImageVector.Builder(defaultWidth = 24.dp, defaultHeight = 24.dp, viewportWidth = 960f, viewportHeight = 960f)
    .apply { if (!path.isNullOrBlank()) addPath(pathData = addPathNodes(path), fill = SolidColor(Color.Black)) }
    .build()

/** A screen's player: its document, the values its route passed, and the app's shared values. */
@SuppressLint("VisibleForTests")
@Composable
private fun ScreenPlayer(entry: StackEntry, bytes: ByteArray, app: AppSpec, state: Map<String, Any>, onAction: (String, String) -> Unit) {
    val theme = if (isSystemInDarkTheme()) RemoteComposePlayer.THEME_DARK else RemoteComposePlayer.THEME_LIGHT
    val act by rememberUpdatedState(onAction)
    AndroidView(
        modifier = Modifier.fillMaxSize(),
        factory = { ctx ->
            val p = AppScreenPlayer(DpHost.childContext(ctx)).apply {
                fullSpeed(ctx); allowShaders(); setTheme(theme); setDocument(bytes); setUseChoreographer(false)
            }
            entry.params.forEach { (k, v) -> p.setString(k, v) }
            pushState(p, app, entry.screen, state)
            p.document.document.addActionCallback(CoreDocument.ActionCallback { name, value -> act(name, value?.toString().orEmpty()) })
            entry.player = p
            DpHost(ctx, p)
        },
        update = { ((it as DpHost).child as RemoteComposePlayer).setTheme(theme) },
    )
}

/** The app's shared values on a screen that declares them. */
private fun pushState(p: AppScreenPlayer, app: AppSpec, screen: String, state: Map<String, Any>) {
    val vars = app.screens[screen]?.vars.orEmpty()
    for ((name, value) in state) {
        if (!vars.containsKey(name)) continue
        when (value) {
            is Float -> p.setLocalFloat(name, value)
            is Number -> p.setLocalFloat(name, value.toFloat())
            else -> p.setString(name, value.toString())
        }
    }
    p.invalidate()
}

/**
 * The androidx player, able to set a document's string variable by its own name: the player's
 * setLocalString and setUserLocalString both add a domain prefix ("USER:"), and the documents'
 * exported names have none (setLocalFloat takes the name as it is).
 */
class AppScreenPlayer(context: Context) : RemoteComposePlayer(context) {
    fun setString(name: String, value: String) { mInner.setLocalString(name, value); invalidate() }
}

/** A float the document exports, or NaN when it has none of that name. */
private fun RemoteComposePlayer.floatOrNaN(name: String): Float =
    try { getNamedFloat(name) } catch (_: Exception) { Float.NaN }

// ---- the app's description (app.json) --------------------------------------------------------------

data class AppScreenSpec(val title: String, val sheet: Boolean, val vars: Map<String, String>)
data class AppTab(val screen: String, val label: String, val path: String?, val pathSelected: String?)
data class AppRoute(val route: String, val to: String, val from: String?, val presentation: String?)
data class AppSpec(
    val id: String,
    val title: String,
    val start: String,
    val screens: Map<String, AppScreenSpec>,
    val routes: List<AppRoute>,
    /** Shared values: a Float or a String each. */
    val state: Map<String, Any>,
    /** The shared values kept for next time. */
    val persist: Set<String> = emptySet(),
    /** The bottom bar's tabs (empty: no bar). */
    val tabs: List<AppTab> = emptyList(),
) {
    /** The route that answers `sent` from `from`, and the values it passes; null when none does. */
    fun resolve(from: String, sent: String): Pair<AppRoute, Map<String, String>>? {
        if (sent.startsWith("@")) return null
        return routes.withIndex().mapNotNull { (i, r) ->
            val params = matchRoute(r.route, sent) ?: return@mapNotNull null
            if (r.from != null && r.from != from) return@mapNotNull null
            Triple((if (r.from != null) 0 else 2) + (if (':' in r.route) 1 else 0), i, r to params)
        }.minWithOrNull(compareBy({ it.first }, { it.second }))?.third
    }
}

/** "/plant/:id" against "/plant/42": {id: "42"}, or null. */
fun matchRoute(pattern: String, sent: String): Map<String, String>? {
    val p = pattern.substringBefore('?').split('/').filter { it.isNotEmpty() }
    val s = sent.substringBefore('?').split('/').filter { it.isNotEmpty() }
    if (p.size != s.size) return null
    val params = mutableMapOf<String, String>()
    for (i in p.indices) {
        if (p[i].startsWith(":")) params[p[i].substring(1)] = java.net.URLDecoder.decode(s[i], "UTF-8")
        else if (p[i] != s[i]) return null
    }
    return params
}

fun parseApp(text: String): AppSpec {
    val o = JSONObject(text)
    val screens = o.getJSONObject("screens").let { s ->
        s.keys().asSequence().associateWith { id ->
            val e = s.getJSONObject(id)
            val vars = e.optJSONObject("vars")?.let { v -> v.keys().asSequence().associateWith { v.getString(it) } }.orEmpty()
            AppScreenSpec(e.optString("title", id), e.optString("as") == "sheet", vars)
        }
    }
    val routes = o.optJSONArray("routes")?.let { a ->
        (0 until a.length()).map { a.getJSONObject(it) }.map {
            AppRoute(it.getString("route"), it.getString("to"), it.optString("from").ifEmpty { null }, it.optString("presentation").ifEmpty { null })
        }
    }.orEmpty()
    val state = o.optJSONObject("state")?.let { s ->
        s.keys().asSequence().associateWith { n ->
            val v = s.getJSONObject(n)
            if (v.optString("type") == "string") v.optString("value") else v.optDouble("value", 0.0).toFloat()
        }
    }.orEmpty()
    val persist = o.optJSONObject("state")?.let { s -> s.keys().asSequence().filter { s.getJSONObject(it).optBoolean("persist") }.toSet() }.orEmpty()
    val tabs = o.optJSONArray("tabs")?.let { a ->
        (0 until a.length()).map { a.getJSONObject(it) }.map {
            AppTab(it.getString("screen"), it.optString("label"), it.optString("path").ifEmpty { null }, it.optString("path_selected").ifEmpty { null })
        }
    }.orEmpty()
    return AppSpec(o.optString("id").ifEmpty { o.optString("title") }, o.optString("title"), o.getString("start"), screens, routes, state, persist, tabs)
}
