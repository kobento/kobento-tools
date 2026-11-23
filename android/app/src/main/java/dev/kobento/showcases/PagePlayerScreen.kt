package dev.kobento.showcases

import android.content.Intent
import androidx.compose.animation.AnimatedVisibility
import kotlinx.coroutines.launch
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.remember
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Button
import androidx.compose.material3.AlertDialog
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri

private val PAGE_LOOKS = listOf(Look.Auto, Look.Light, Look.Dark)

/** A published page (the account's own, or one from the stream): its document downloaded and played like a showcase. */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun PagePlayerScreen(page: PublishedPage, subtitle: String, share: ShareUi?, onBack: () -> Unit) {
    var look by rememberSaveable(page.id) { mutableStateOf(Look.Auto) }
    var info by rememberSaveable(page.id) { mutableStateOf(false) }
    var attempt by rememberSaveable(page.id) { mutableIntStateOf(0) }
    val bytes by produceState<Result<ByteArray>?>(null, page.rcUrl, attempt) { value = runCatching { download(page.rcUrl) } }
    val context = LocalContext.current
    var sharing by rememberSaveable(page.id) { mutableStateOf(false) }
    if (sharing && share != null) ShareDialog(page, share, onDone = { sharing = false })
    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(page.title, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(subtitle, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                },
                navigationIcon = { IconButton(onClick = onBack) { Icon(painterResource(R.drawable.ic_arrow_back), contentDescription = "Back") } },
                actions = {
                    val loaded = bytes?.getOrNull()
                    if (loaded != null && DocumentWidget.supported()) IconButton(onClick = { DocumentWidget.addToHomeScreen(context, loaded, page.title) }) {
                        Icon(painterResource(R.drawable.ic_widget), contentDescription = stringResource(R.string.widget_add))
                    }
                    if (share != null) IconButton(onClick = { sharing = true }) {
                        Icon(painterResource(R.drawable.ic_share),
                            contentDescription = if (page.stream != null) "Edit or take out of the stream" else "Share to the stream")
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
            AnimatedVisibility(info) {
                Column(Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) {
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        bytes?.getOrNull()?.let { Fact("Size", formatBytes(it.size)) }
                        if (page.width > 0) Fact("Designed at", "${page.width} × ${page.height} dp")
                        if (page.created.length >= 10) Fact("Published", page.created.take(10))
                        page.stream?.let { Fact("In the stream", "score ${it.score}") }
                    }
                    TextButton(onClick = { context.startActivity(Intent(Intent.ACTION_VIEW, page.url.toUri())) },
                        modifier = Modifier.padding(top = 4.dp)) { Text("Open the web page") }
                }
            }
            Row(
                Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                for (l in PAGE_LOOKS) FilterChip(selected = l == look, onClick = { look = l }, label = { Text(l.label) })
            }
            val result = bytes
            Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                when {
                    result == null -> CircularProgressIndicator()
                    result.isFailure -> Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text("Could not load this page", style = MaterialTheme.typography.titleMedium)
                        Text(result.exceptionOrNull()?.message.orEmpty(), style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(8.dp))
                        TextButton(onClick = { attempt++ }) { Text("Try again") }
                    }
                    else -> DocumentFrame("phone", Modifier.fillMaxSize()) { key(look) { Player(result.getOrThrow(), look, onBack) } }
                }
            }
        }
    }
}

/** Sharing one of the account's own pages: what the dialog needs and does. */
class ShareUi(
    /** The account's public name, or null: the first post sets one. */
    val name: String?,
    val post: suspend (title: String, tags: String, name: String?) -> Unit,
    val remove: suspend () -> Unit,
)

/** Post a page to the stream, or rename, retag or take it out. */
@Composable
private fun ShareDialog(page: PublishedPage, share: ShareUi, onDone: () -> Unit) {
    val entry = page.stream
    var name by rememberSaveable { mutableStateOf("") }
    var title by rememberSaveable { mutableStateOf(entry?.title ?: page.title) }
    var tags by rememberSaveable { mutableStateOf(entry?.tags?.joinToString(", ").orEmpty()) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    fun act(step: suspend () -> Unit) {
        scope.launch {
            busy = true; error = null
            try { step(); onDone() } catch (e: Exception) { error = e.message ?: e.toString() }
            busy = false
        }
    }
    val needsName = share.name == null
    AlertDialog(
        onDismissRequest = { if (!busy) onDone() },
        title = { Text(if (entry == null) "Share to the stream" else "In the stream") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(
                    if (entry == null) "Everyone can open it from the stream and vote on it. The page itself stays where it is."
                    else "Score ${entry.score}. Rename or retag it, or take it out (its votes go too).",
                    style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (needsName) OutlinedTextField(name, { name = it }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                    label = { Text("Your name") }, supportingText = { Text("Shown with what you post") })
                OutlinedTextField(title, { title = it }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                    label = { Text("Name in the stream") })
                OutlinedTextField(tags, { tags = it }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                    label = { Text("Tags") }, supportingText = { Text("A few words, with commas: game, physics") })
                error?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
            }
        },
        confirmButton = {
            Button(
                enabled = !busy && title.isNotBlank() && (!needsName || name.isNotBlank()),
                onClick = { act { share.post(title.trim(), tags, if (needsName) name.trim() else null) } },
            ) { Text(if (entry == null) "Share" else "Save") }
        },
        dismissButton = {
            Row {
                if (entry != null) TextButton(enabled = !busy, onClick = { act { share.remove() } }) {
                    Text("Take out", color = MaterialTheme.colorScheme.error)
                }
                TextButton(enabled = !busy, onClick = onDone) { Text("Cancel") }
            }
        },
    )
}
