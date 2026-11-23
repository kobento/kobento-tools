package dev.kobento.showcases

import android.annotation.SuppressLint
import android.content.Context
import android.view.WindowManager
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import android.widget.Toast
import androidx.compose.remote.player.view.RemoteComposePlayer
import kotlin.math.ceil

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PlayerScreen(showcase: Showcase, onBack: () -> Unit) {
    var look by rememberSaveable(showcase.id) { mutableStateOf(Look.Auto) }
    var info by rememberSaveable(showcase.id) { mutableStateOf(false) }
    val context = LocalContext.current
    // The look being played: its own file (the mono looks are separate documents).
    val bytes = remember(showcase.folder, look) { context.assets.open(showcase.asset(look.file)).use { it.readBytes() } }
    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(showcase.name, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(showcase.id, style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(painterResource(R.drawable.ic_arrow_back), contentDescription = "Back") }
                },
                actions = {
                    if (DocumentWidget.supported()) IconButton(onClick = { DocumentWidget.addToHomeScreen(context, bytes, showcase.name) }) {
                        Icon(painterResource(R.drawable.ic_widget), contentDescription = stringResource(R.string.widget_add))
                    }
                    IconButton(onClick = { info = !info }) {
                        Icon(painterResource(R.drawable.ic_info), contentDescription = if (info) "Hide details" else "Details")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
            )
        },
    ) { insets ->
        Column(Modifier.fillMaxSize().padding(insets)) {
            AnimatedVisibility(info) { Details(showcase, bytes.size) }
            Row(
                Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                for (l in showcase.looks) FilterChip(selected = l == look, onClick = { look = l }, label = { Text(l.label) })
            }
            var anyway by rememberSaveable(showcase.id) { mutableStateOf(false) }
            if (showcase.unsupported != null && !anyway) {
                Unsupported(showcase.unsupported, Modifier.weight(1f).fillMaxWidth(), onPlay = { anyway = true })
            } else {
                DocumentFrame(showcase.formFactor, Modifier.weight(1f).fillMaxWidth()) {
                    // A new player per look: each look is its own document (or the same one in another theme).
                    key(look) { Player(bytes, look, onBack) }
                }
            }
        }
    }
}

@Composable
private fun Unsupported(reason: String, modifier: Modifier, onPlay: () -> Unit) {
    Column(modifier.padding(32.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        Text("Not playable here", style = MaterialTheme.typography.titleMedium)
        Text(reason, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center, modifier = Modifier.padding(vertical = 8.dp))
        TextButton(onClick = onPlay) { Text("Play anyway") }
    }
}

/** The document at the size its form factor wants: a phone or tablet fills the screen and relays out to it. */
@Composable
internal fun DocumentFrame(formFactor: String, modifier: Modifier, content: @Composable () -> Unit) {
    BoxWithConstraints(modifier.padding(12.dp), contentAlignment = Alignment.Center) {
        val side = minOf(maxWidth, maxHeight)
        val frame = when (formFactor) {
            "watch-round" -> Modifier.size(side * 0.9f).clip(CircleShape)
            "square" -> Modifier.size(side)
            "widget-4x1" -> Modifier.fillMaxWidth().aspectRatio(4f).clip(RoundedCornerShape(16.dp))
            else -> Modifier.fillMaxSize().clip(RoundedCornerShape(12.dp))
        }
        Box(frame) { content() }
    }
}

/** Size and shape of the document, what it shows off, then what it is. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Details(showcase: Showcase, bytes: Int) {
    Column(Modifier.padding(horizontal = 16.dp, vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Fact("Size", formatBytes(bytes))
            if (showcase.opCount > 0) Fact("Operations", "%,d".format(showcase.opCount))
            if (showcase.designWidth > 0) Fact("Designed at", "${showcase.designWidth} × ${showcase.designHeight} dp")
            Fact("Form", FORMS[showcase.formFactor] ?: showcase.formFactor)
            showcase.repaint?.let { Fact("Repaints", REPAINTS[it] ?: it) }
        }
        if (showcase.capabilities.isNotEmpty()) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                for (c in showcase.capabilities) {
                    Text(c, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSecondaryContainer,
                        modifier = Modifier.background(MaterialTheme.colorScheme.secondaryContainer, RoundedCornerShape(6.dp))
                            .padding(horizontal = 8.dp, vertical = 3.dp))
                }
            }
        }
        Text(showcase.summary, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
internal fun Fact(label: String, value: String) {
    Column {
        Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, style = MaterialTheme.typography.titleSmall)
    }
}

private val FORMS = mapOf("phone" to "Phone", "tablet" to "Tablet", "square" to "Square",
    "watch-round" to "Round watch", "widget-4x1" to "4×1 widget")
private val REPAINTS = mapOf("continuous" to "Every frame", "scheduled" to "On a schedule", "idle" to "When something changes")

/**
 * No frame budget: the player's defaults (Limits: 60 fps at most, 10 fps on average over a 10 s
 * window) keep a launcher's widgets light, and slow a demo to a crawl. setDocument resets the
 * limiter to those defaults and a document's own fps request is capped at Limits.MAX_FPS, so all
 * three are raised to the display's refresh rate before the document is set; the average limit
 * equal to the maximum never throttles.
 *
 * After setDocument (which turns it back on), setUseChoreographer(false): with the choreographer
 * a frame that wants the next one posts a frame callback, which then posts an invalidate on the
 * following vsync, so each frame takes two vsyncs (30 fps at 60 Hz). Without it the view
 * invalidates at once and draws on the next vsync; a document that waits (a clock's next minute)
 * still gets a delayed invalidate.
 */
private fun RemoteComposePlayer.fullSpeed(context: Context) {
    val fps = maxOf(60, ceil(displayRefreshRate(context)).toInt())
    setMaxFps(fps)
    setDefaultMaxFps(fps)
    setDefaultMaxAvgFps(fps)
}

/**
 * Runtime shaders on: the player's default ShaderControl refuses every shader (isShaderValid
 * returns false), so a document's shader paints draw nothing. setDocument checks the document's
 * shaders against the control, so it is set first.
 */
private fun RemoteComposePlayer.allowShaders() = setShaderControl { true }

@Suppress("DEPRECATION")   // Context.getDisplay needs API 30; the app runs from 26
private fun displayRefreshRate(context: Context): Float =
    (context.getSystemService(Context.WINDOW_SERVICE) as WindowManager).defaultDisplay.refreshRate

internal fun formatBytes(n: Int) = if (n < 1024) "$n B" else "%.1f KB".format(n / 1024.0)

@SuppressLint("VisibleForTests")   // setUseChoreographer is marked for tests: see fullSpeed
@Composable
internal fun Player(bytes: ByteArray, look: Look, onBack: () -> Unit) {
    val theme = when (look) {
        Look.Auto -> if (isSystemInDarkTheme()) RemoteComposePlayer.THEME_DARK else RemoteComposePlayer.THEME_LIGHT
        Look.Light, Look.MonoLight -> RemoteComposePlayer.THEME_LIGHT
        Look.Dark, Look.MonoDark -> RemoteComposePlayer.THEME_DARK
    }
    val context = LocalContext.current
    var player by remember { mutableStateOf<RemoteComposePlayer?>(null) }
    player?.let { NavigatorHost(it, onBack = onBack, onNavigate = { route ->
        // This app has no screens of its own to open: say what the document asked for.
        Toast.makeText(context, "navigate $route", Toast.LENGTH_SHORT).show()
    }) }
    AndroidView(
        modifier = Modifier.fillMaxSize(),
        factory = { DpHost(it, RemoteComposePlayer(DpHost.childContext(it)).apply { fullSpeed(it); allowShaders(); setTheme(theme); setDocument(bytes); setUseChoreographer(false); player = this }) },
        // Auto follows the system: the theme changes in place, the document keeps its state.
        update = { (it.child as RemoteComposePlayer).setTheme(theme) },
    )
}
