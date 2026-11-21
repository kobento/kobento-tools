package dev.kobento.showcases

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * The stream tab's state, kept by App so it survives opening an item and coming back: the
 * filters, and the items last loaded for them ([loadedFor]).
 */
class StreamState {
    var sort by mutableStateOf("new")
    var tag by mutableStateOf<String?>(null)
    var query by mutableStateOf("")
    var items by mutableStateOf<List<StreamItem>?>(null)
    var tags by mutableStateOf(emptyList<String>())
    var loading by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)
    var loadedFor by mutableStateOf<List<Any?>?>(null)
    var reloads by mutableIntStateOf(0)
}

/** What the stream tab needs from the app: the account (to vote) and the server calls. */
class StreamUi(
    val state: StreamState,
    val signedInAs: String?,
    val load: suspend (sort: String, tag: String?, query: String) -> StreamPage,
    val vote: suspend (pageId: String, value: Int) -> Vote,
    /** The signed-in account's id: its own items offer no Report or Block. */
    val accountId: Long?,
    val report: suspend (pageId: String, reason: String, note: String) -> Unit,
    val block: suspend (authorId: Long) -> Unit,
    val onSignIn: () -> Unit,
    val onOpen: (StreamItem) -> Unit,
)

@Composable
internal fun StreamTab(ui: StreamUi, insets: PaddingValues) {
    val st = ui.state
    val scope = rememberCoroutineScope()
    val key = listOf(st.sort, st.tag, st.query.trim(), ui.signedInAs, st.reloads)
    LaunchedEffect(key) {
        if (st.loadedFor == key) return@LaunchedEffect
        if (st.loadedFor != null && st.query.trim() != (st.loadedFor?.get(2) as String?)) delay(300)   // typing
        st.loading = true
        try {
            val page = ui.load(st.sort, st.tag, st.query)
            st.items = page.items; st.tags = page.tags; st.error = null; st.loadedFor = key
        } catch (e: Exception) {
            st.error = e.message ?: e.toString()
        } finally {
            st.loading = false
        }
    }
    fun vote(item: StreamItem, value: Int) {
        if (ui.signedInAs == null) { ui.onSignIn(); return }
        val v = if (item.myVote == value) 0 else value
        scope.launch {
            try {
                val t = ui.vote(item.pageId, v)
                st.items = st.items?.map { if (it.pageId == item.pageId) it.copy(score = t.score, ups = t.ups, downs = t.downs, myVote = t.myVote) else it }
            } catch (e: Exception) {
                st.error = e.message ?: e.toString()
            }
        }
    }
    // Report and Block (store rules for shared content): a reported item, or a blocked author's
    // items, leave this list at once; the server keeps them out of the next loads.
    var reporting by remember { mutableStateOf<StreamItem?>(null) }
    var notice by remember { mutableStateOf<String?>(null) }
    fun block(item: StreamItem) {
        val author = item.authorId ?: return
        if (ui.signedInAs == null) { ui.onSignIn(); return }
        scope.launch {
            try {
                ui.block(author)
                st.items = st.items?.filter { it.authorId != author }
                notice = "Blocked ${item.author}. You no longer see their items. Unblock them from the Showcases tab."
            } catch (e: Exception) {
                st.error = e.message ?: e.toString()
            }
        }
    }
    reporting?.let { item ->
        ReportDialog(item, onDismiss = { reporting = null }) { reason, note ->
            reporting = null
            scope.launch {
                try {
                    ui.report(item.pageId, reason, note)
                    st.items = st.items?.filter { it.pageId != item.pageId }
                    notice = "Thanks. \"${item.title}\" is hidden for you, and we will review it."
                } catch (e: Exception) {
                    st.error = e.message ?: e.toString()
                }
            }
        }
    }
    notice?.let { n ->
        AlertDialog(onDismissRequest = { notice = null }, text = { Text(n) },
            confirmButton = { TextButton(onClick = { notice = null }) { Text("OK") } })
    }
    val focus = LocalFocusManager.current
    CardGrid(insets) {
        item(span = { GridItemSpan(maxLineSpan) }) {
            Column(Modifier.padding(bottom = 4.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Stream", style = MaterialTheme.typography.headlineMedium, modifier = Modifier.weight(1f))
                    if (st.loading) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                }
                Text(
                    "Documents people made with Kobento and chose to share." +
                        if (ui.signedInAs == null) " Sign in to vote." else "",
                    style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                OutlinedTextField(
                    value = st.query, onValueChange = { st.query = it },
                    modifier = Modifier.fillMaxWidth(), singleLine = true,
                    placeholder = { Text("Search titles, people, tags") },
                    leadingIcon = { Icon(painterResource(R.drawable.ic_search), contentDescription = null) },
                    trailingIcon = {
                        if (st.query.isNotEmpty()) IconButton(onClick = { st.query = "" }) {
                            Icon(painterResource(R.drawable.ic_close), contentDescription = "Clear the search")
                        }
                    },
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                    keyboardActions = KeyboardActions(onSearch = { focus.clearFocus() }),
                )
                Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilterChip(selected = st.sort == "new", onClick = { st.sort = "new" }, label = { Text("Newest") })
                    FilterChip(selected = st.sort == "top", onClick = { st.sort = "top" }, label = { Text("Top") })
                    Box(Modifier.size(width = 8.dp, height = 1.dp))
                    FilterChip(selected = st.tag == null, onClick = { st.tag = null }, label = { Text("All") })
                    val shown = st.tag?.takeIf { it !in st.tags }?.let { listOf(it) + st.tags } ?: st.tags
                    for (t in shown) FilterChip(selected = st.tag == t, onClick = { st.tag = if (st.tag == t) null else t }, label = { Text("#$t") })
                }
                st.error?.let { e ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(e, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error, modifier = Modifier.weight(1f))
                        TextButton(onClick = { st.reloads++ }) { Text("Try again") }
                    }
                }
            }
        }
        val items = st.items
        if (items != null && items.isEmpty()) item(span = { GridItemSpan(maxLineSpan) }) {
            Hint(if (st.query.isNotBlank() || st.tag != null) "Nothing matches." else "Nothing in the stream yet.")
        }
        if (items != null) items(items, key = { it.pageId }) { item ->
            val others = ui.accountId == null || item.authorId != ui.accountId
            StreamCard(item, onClick = { ui.onOpen(item) }, onVote = { vote(item, it) },
                onReport = if (others) { { if (ui.signedInAs == null) ui.onSignIn() else reporting = item } } else null,
                onBlock = if (others && item.authorId != null) { { block(item) } } else null)
        }
    }
}

@Composable
private fun StreamCard(item: StreamItem, onClick: () -> Unit, onVote: (Int) -> Unit, onReport: (() -> Unit)?, onBlock: (() -> Unit)?) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainer),
    ) {
        Column(Modifier.clickable(onClick = onClick)) {
            Box(
                Modifier.fillMaxWidth().aspectRatio(3f / 4f).background(MaterialTheme.colorScheme.surfaceContainerHigh),
                contentAlignment = Alignment.Center,
            ) {
                Preview(item.page.previewUrl)
                if (item.showcase) {
                    Text(
                        "Showcase",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onTertiaryContainer,
                        modifier = Modifier.align(Alignment.TopStart).padding(10.dp)
                            .background(MaterialTheme.colorScheme.tertiaryContainer, RoundedCornerShape(6.dp))
                            .padding(horizontal = 6.dp, vertical = 2.dp),
                    )
                }
            }
            Column(Modifier.padding(start = 12.dp, end = 12.dp, top = 10.dp)) {
                Text(item.title, style = MaterialTheme.typography.titleSmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text("by ${item.author}", style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (item.tags.isNotEmpty()) Text(item.tags.joinToString("  ") { "#$it" }, style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.primary, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        Row(Modifier.padding(horizontal = 4.dp, vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
            VoteButton(R.drawable.ic_vote_up, "Vote up", item.myVote == 1, Color(0xFF2E9D57)) { onVote(1) }
            Text("${item.score}", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
            VoteButton(R.drawable.ic_vote_down, "Vote down", item.myVote == -1, Color(0xFFD0453A)) { onVote(-1) }
            Text("+${item.ups} / −${item.downs}", style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, modifier = Modifier.weight(1f))
            if (onReport != null || onBlock != null) Box {
                var menu by remember { mutableStateOf(false) }
                IconButton(onClick = { menu = true }) {
                    Icon(painterResource(R.drawable.ic_more), contentDescription = "Report or block",
                        tint = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    onReport?.let { DropdownMenuItem(text = { Text("Report…") }, onClick = { menu = false; it() }) }
                    onBlock?.let { DropdownMenuItem(text = { Text("Block ${item.author}") }, onClick = { menu = false; it() }) }
                }
            }
        }
    }
}

@Composable
private fun VoteButton(icon: Int, label: String, on: Boolean, color: Color, onClick: () -> Unit) {
    IconButton(
        onClick = onClick,
        colors = IconButtonDefaults.iconButtonColors(contentColor = if (on) color else MaterialTheme.colorScheme.onSurfaceVariant),
    ) {
        Icon(painterResource(icon), contentDescription = if (on) "$label (taken back if tapped again)" else label)
    }
}

/** Why the item is reported (the server's reasons), and an optional note. */
@Composable
private fun ReportDialog(item: StreamItem, onDismiss: () -> Unit, onSend: (reason: String, note: String) -> Unit) {
    var reason by remember { mutableStateOf<String?>(null) }
    var note by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Report \"${item.title}\"") },
        text = {
            Column(Modifier.selectableGroup()) {
                Text("It disappears from your stream now. After several reports it is hidden for everyone until we review it.",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                for ((key, label) in Account.REPORT_REASONS) {
                    Row(
                        Modifier.fillMaxWidth().selectable(selected = reason == key, onClick = { reason = key }, role = Role.RadioButton),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RadioButton(selected = reason == key, onClick = null)
                        Text(label, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(start = 8.dp, top = 10.dp, bottom = 10.dp))
                    }
                }
                OutlinedTextField(value = note, onValueChange = { note = it.take(500) }, modifier = Modifier.fillMaxWidth(),
                    placeholder = { Text("Anything to add (optional)") }, maxLines = 3)
            }
        },
        confirmButton = { TextButton(enabled = reason != null, onClick = { reason?.let { onSend(it, note.trim()) } }) { Text("Report") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
