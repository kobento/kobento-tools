package dev.kobento.showcases

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

/** The authors this account blocked in the stream, each with Unblock. */
@Composable
internal fun BlockedDialog(load: suspend () -> List<BlockedAuthor>, unblock: suspend (Long) -> Unit, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    var list by remember { mutableStateOf<List<BlockedAuthor>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) {
        try { list = load() } catch (e: Exception) { error = e.message ?: e.toString() }
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("People you blocked") },
        text = {
            Column(Modifier.heightIn(max = 360.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                val l = list
                when {
                    error != null -> Text(error!!, color = MaterialTheme.colorScheme.error)
                    l == null -> CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                    l.isEmpty() -> Text("Nobody. In the stream, an item's menu has Block: their items no longer show.")
                    else -> for (b in l) Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Text(b.name, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        TextButton(onClick = {
                            scope.launch {
                                try { unblock(b.id); list = list?.filter { it.id != b.id } } catch (e: Exception) { error = e.message ?: e.toString() }
                            }
                        }) { Text("Unblock") }
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Done") } },
    )
}

/** Deleting the account for good: what goes, then the server call; the app signs out after it. */
@Composable
internal fun DeleteAccountDialog(email: String, delete: suspend () -> Unit, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text("Delete your account?") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("This deletes $email on Kobento for good, right away: every page you published (their links stop working), " +
                    "your items in the stream with their votes, your libraries, uploads and session history, and your sign-ins " +
                    "on every device. It cannot be undone.")
                error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            }
        },
        confirmButton = {
            TextButton(
                enabled = !busy,
                colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error),
                onClick = {
                    busy = true; error = null
                    scope.launch {
                        try { delete(); onDismiss() } catch (e: Exception) { error = e.message ?: e.toString() }
                        busy = false
                    }
                },
            ) { if (busy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp) else Text("Delete my account") }
        },
        dismissButton = { TextButton(enabled = !busy, onClick = onDismiss) { Text("Cancel") } },
    )
}
