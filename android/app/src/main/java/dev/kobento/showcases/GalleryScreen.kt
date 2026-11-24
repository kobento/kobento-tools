package dev.kobento.showcases

import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyGridScope
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.Button
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.TextButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** What the gallery shows of the account: signed out, signing in, or signed in with its pages. */
data class AccountUi(
    val email: String?,
    val busy: Boolean,
    val error: String?,
    val pages: List<PublishedPage>?,
    /** The account's apps (null until listed). */
    val apps: List<MyApp>? = null,
    /** Plays an app: its published copy, or (draft) the owner's pages as they are now. */
    val onOpenApp: (MyApp, Boolean) -> Unit = { _, _ -> },
    val onSignIn: () -> Unit,
    val onSignOut: () -> Unit,
    val onRefresh: () -> Unit,
    val onOpenPage: (PublishedPage) -> Unit,
    /** The authors this account blocked in the stream, and showing one again. */
    val loadBlocked: suspend () -> List<BlockedAuthor>,
    val unblock: suspend (authorId: Long) -> Unit,
    /** Deletes the account on the server (asked first), then signs out. */
    val deleteAccount: suspend () -> Unit,
)

/** The gallery's two tabs: the bundled showcases, and the signed-in account's own pages. */
enum class GalleryTab(val label: String, val icon: Int) {
    Showcases("Showcases", R.drawable.ic_showcases),
    Stream("Stream", R.drawable.ic_stream),
    Pages("Your pages", R.drawable.ic_person),
}

@Composable
fun GalleryScreen(
    showcases: List<Showcase>,
    account: AccountUi,
    stream: StreamUi,
    tab: GalleryTab,
    onTab: (GalleryTab) -> Unit,
    onOpen: (Showcase) -> Unit,
) {
    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        bottomBar = {
            NavigationBar(containerColor = MaterialTheme.colorScheme.surfaceContainer) {
                for (t in GalleryTab.entries) NavigationBarItem(
                    selected = t == tab, onClick = { onTab(t) },
                    icon = { Icon(painterResource(t.icon), contentDescription = null) },
                    label = { Text(t.label) },
                )
            }
        },
    ) { insets ->
        when (tab) {
            GalleryTab.Showcases -> ShowcasesTab(showcases, insets, onOpen)
            GalleryTab.Stream -> StreamTab(stream, insets)
            GalleryTab.Pages -> PagesTab(account, insets)
        }
    }
}

@Composable
internal fun CardGrid(insets: PaddingValues, content: LazyGridScope.() -> Unit) {
    LazyVerticalGrid(
        columns = GridCells.Adaptive(minSize = 168.dp),
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(
            start = 16.dp, end = 16.dp,
            top = insets.calculateTopPadding() + 16.dp,
            bottom = insets.calculateBottomPadding() + 16.dp,
        ),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
        content = content,
    )
}

@Composable
private fun ShowcasesTab(showcases: List<Showcase>, insets: PaddingValues, onOpen: (Showcase) -> Unit) {
    CardGrid(insets) {
        item(span = { GridItemSpan(maxLineSpan) }) {
            Column(Modifier.padding(bottom = 4.dp)) {
                Text("Kobento showcases", style = MaterialTheme.typography.headlineMedium)
                Text(
                    "${showcases.size} RemoteCompose documents, played by the androidx player. " +
                        "Tap one to run it.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        items(showcases, key = { it.id }) { ShowcaseCard(it, onClick = { onOpen(it) }) }
    }
}

@Composable
private fun PagesTab(account: AccountUi, insets: PaddingValues) {
    CardGrid(insets) {
        item(span = { GridItemSpan(maxLineSpan) }) {
            Column(Modifier.padding(bottom = 4.dp)) {
                Text("Your pages", style = MaterialTheme.typography.headlineMedium)
                AccountRow(account)
            }
        }
        // Apps: several pages tied together, played screen by screen.
        val apps = account.apps.orEmpty()
        if (account.email != null && apps.isNotEmpty()) {
            item(span = { GridItemSpan(maxLineSpan) }) { Text("Apps", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 4.dp)) }
            items(apps, key = { "app-" + it.id }, span = { GridItemSpan(maxLineSpan) }) { AppRow(it, onOpen = { draft -> account.onOpenApp(it, draft) }) }
            item(span = { GridItemSpan(maxLineSpan) }) { Text("Pages", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 8.dp)) }
        }
        val pages = account.pages
        when {
            account.email == null -> item(span = { GridItemSpan(maxLineSpan) }) {
                Hint("Sign in with your Kobento account to play the pages you published with Kobento's MCP tools.")
            }
            pages == null -> {}
            pages.isEmpty() -> item(span = { GridItemSpan(maxLineSpan) }) {
                Hint("None published yet. Pages you publish with Kobento's MCP tools appear here.")
            }
            else -> items(pages, key = { it.id }) { PageCard(it, onClick = { account.onOpenPage(it) }) }
        }
    }
}

/**
 * An app in the list: its name and screens. A tap plays the published app (the draft when it is
 * not published yet); Draft plays the pages as they are now.
 */
@Composable
private fun AppRow(app: MyApp, onOpen: (draft: Boolean) -> Unit) {
    val canPlay = app.url != null || app.draft != null
    Card(
        modifier = Modifier.fillMaxWidth().let { if (canPlay) it.clickable { onOpen(app.url == null) } else it },
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainer),
    ) {
        Row(Modifier.padding(start = 14.dp, end = 6.dp, top = 6.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f).padding(vertical = 6.dp)) {
                Text(app.title, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(
                    "${app.screens} screen${if (app.screens == 1) "" else "s"}" + if (app.url == null) " · draft, not published yet" else " · version ${app.version}",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (app.url != null && app.draft != null) TextButton(onClick = { onOpen(true) }) { Text("Draft") }
        }
    }
}

@Composable
internal fun Hint(text: String) =
    Text(text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)

@Composable
private fun ShowcaseCard(showcase: Showcase, onClick: () -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick),
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainer),
    ) {
        Box(
            Modifier.fillMaxWidth().aspectRatio(3f / 4f).background(MaterialTheme.colorScheme.surfaceContainerHigh),
            contentAlignment = Alignment.Center,
        ) {
            val thumb by thumbnail(showcase)
            thumb?.let {
                Image(it, contentDescription = null, contentScale = ContentScale.Fit,
                    modifier = Modifier.fillMaxSize().padding(8.dp).clip(RoundedCornerShape(6.dp)))
            }
            if (showcase.unsupported != null) {
                Text(
                    "Kobento 3D",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onTertiaryContainer,
                    modifier = Modifier.align(Alignment.TopStart).padding(10.dp)
                        .background(MaterialTheme.colorScheme.tertiaryContainer, RoundedCornerShape(6.dp))
                        .padding(horizontal = 6.dp, vertical = 2.dp),
                )
            }
        }
        Column(Modifier.padding(horizontal = 12.dp, vertical = 10.dp)) {
            Text(showcase.name, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(
                showcase.tagline,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 2, overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

/** Sign in, or who is signed in (and sign out); a sign-in error under it. */
@Composable
private fun AccountRow(account: AccountUi) {
    Column(Modifier.fillMaxWidth().padding(top = 4.dp, bottom = 8.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(account.email?.let { "Signed in as $it" } ?: "Not signed in",
                style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            when {
                account.busy -> CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                account.email == null -> Button(onClick = account.onSignIn) { Text("Sign in") }
                else -> {
                    TextButton(onClick = account.onRefresh) { Text("Refresh") }
                    TextButton(onClick = account.onSignOut) { Text("Sign out") }
                }
            }
        }
        account.error?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
        if (account.email != null) {
            var dialog by remember { mutableStateOf<String?>(null) }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                TextButton(onClick = { dialog = "blocked" }) { Text("People you blocked") }
                TextButton(onClick = { dialog = "delete" }) { Text("Delete account", color = MaterialTheme.colorScheme.error) }
            }
            when (dialog) {
                "blocked" -> BlockedDialog(account.loadBlocked, account.unblock, onDismiss = { dialog = null })
                "delete" -> DeleteAccountDialog(account.email, account.deleteAccount, onDismiss = { dialog = null })
            }
        }
    }
}

@Composable
private fun PageCard(page: PublishedPage, onClick: () -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick),
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainer),
    ) {
        Box(
            Modifier.fillMaxWidth().aspectRatio(3f / 4f).background(MaterialTheme.colorScheme.surfaceContainerHigh),
            contentAlignment = Alignment.Center,
        ) {
            Preview(page.previewUrl)
        }
        Column(Modifier.padding(horizontal = 12.dp, vertical = 10.dp)) {
            Text(page.title, style = MaterialTheme.typography.titleSmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(listOfNotNull(page.created.take(10).ifBlank { null }, page.rcBytes.takeIf { it > 0 }?.let(::formatBytes)).joinToString(" · "),
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            page.stream?.let {
                Text("In the stream · score ${it.score}", style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.primary, maxLines = 1)
            }
        }
    }
}

/** A published page's preview.png, downloaded (nothing while it loads or when there is none). */
@Composable
internal fun Preview(url: String?) {
    val preview by produceState<ImageBitmap?>(null, url) {
        value = url?.let { u ->
            runCatching { download(u).let { BitmapFactory.decodeByteArray(it, 0, it.size)?.asImageBitmap() } }.getOrNull()
        }
    }
    preview?.let {
        Image(it, contentDescription = null, contentScale = ContentScale.Fit,
            modifier = Modifier.fillMaxSize().padding(8.dp).clip(RoundedCornerShape(6.dp)))
    }
}

/** The showcase's render in the system's light or dark, decoded off the main thread. */
@Composable
private fun thumbnail(showcase: Showcase) = LocalContext.current.let { context ->
    val file = if (isSystemInDarkTheme()) "render-dark.png" else "render-light.png"
    produceState<ImageBitmap?>(null, showcase.folder, file) {
        value = withContext(Dispatchers.IO) {
            runCatching {
                context.assets.open(showcase.asset(file)).use { BitmapFactory.decodeStream(it)?.asImageBitmap() }
            }.getOrNull()
        }
    }
}
