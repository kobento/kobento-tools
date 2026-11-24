package dev.kobento.showcases

import android.content.Context
import android.net.Uri
import android.util.Base64
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.edit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * Signing in to a Kobento server (mcp.kobento.dev) the way a native app should (RFC 8252): the
 * server's own sign-in page in a Custom Tab, OAuth 2.1's authorization code with PKCE, and the
 * answer coming back to the app on its private scheme, dev.kobento.showcases:/oauth.
 *
 * The app registers itself once per server (dynamic client registration, RFC 7591), keeps the
 * access token (1 h) and the refresh token (30 days, a new one on every refresh) in its private
 * preferences, and refreshes when the access token has expired or is refused. A visitor already
 * signed in on the website in the browser only sees the "Allow" page.
 */
class Account(context: Context) {
    private val prefs = context.getSharedPreferences("account", Context.MODE_PRIVATE)

    /** A server named by this launch (`--es server http://localhost:8899`); never saved. */
    private var override: String? = null
    private var meta: JSONObject? = null

    /** The server: BuildConfig.KOBENTO_SERVER, or the one this launch named. */
    val server: String get() = override ?: BuildConfig.KOBENTO_SERVER.trimEnd('/')

    /** The signed-in account's email, or null: Compose state, so the gallery follows it. */
    var email by mutableStateOf(prefs.getString(K_EMAIL, null)?.takeIf { prefs.contains(K_REFRESH) })
        private set

    /** The signed-in account's id (its items' author_id in the stream), once pages.json said it. */
    val accountId: Long? get() = prefs.getLong(K_ID, -1).takeIf { it >= 0 && email != null }

    init { forgetOtherServer() }

    /** Another server for this launch only (tests against a local one); the next plain launch is back on the default. */
    fun useServer(url: String) {
        override = url.trimEnd('/')
        forgetOtherServer()
    }

    /** The saved tokens and client id belong to one server ([K_SERVER]): on another, sign out of that one. */
    private fun forgetOtherServer() {
        if (prefs.getString(K_SERVER, null) == server) return
        clear()
        meta = null
        prefs.edit { putString(K_SERVER, server); remove(K_CLIENT); remove(K_CLIENT_FOR); remove(K_STATE); remove(K_VERIFIER) }
    }

    /** Opens the server's sign-in page; the answer arrives as an intent ([finishSignIn]). */
    suspend fun startSignIn(context: Context) {
        val meta = metadata()
        val clientId = clientId(meta)
        val verifier = random(48)
        val state = random(16)
        prefs.edit { putString(K_VERIFIER, verifier); putString(K_STATE, state) }
        val challenge = b64(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray()))
        val uri = Uri.parse(meta.getString("authorization_endpoint")).buildUpon()
            .appendQueryParameter("response_type", "code")
            .appendQueryParameter("client_id", clientId)
            .appendQueryParameter("redirect_uri", REDIRECT)
            .appendQueryParameter("code_challenge", challenge)
            .appendQueryParameter("code_challenge_method", "S256")
            .appendQueryParameter("scope", "mcp")
            .appendQueryParameter("state", state)
            .build()
        CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(context, uri)
    }

    /** True when [uri] is the sign-in's answer (dev.kobento.showcases:/oauth?...). */
    fun isRedirect(uri: Uri?) = uri != null && uri.scheme == SCHEME && uri.path == "/oauth"

    /** Exchanges the answer's code for tokens, then reads who signed in. Throws with a message to show. */
    suspend fun finishSignIn(uri: Uri) {
        val state = prefs.getString(K_STATE, null)
        val verifier = prefs.getString(K_VERIFIER, null)
        prefs.edit { remove(K_STATE); remove(K_VERIFIER) }
        uri.getQueryParameter("error")?.let { e ->
            throw IOException(if (e == "access_denied") "Sign-in cancelled." else uri.getQueryParameter("error_description") ?: e)
        }
        if (state == null || verifier == null || uri.getQueryParameter("state") != state) throw IOException("This sign-in was not started here. Try again.")
        val code = uri.getQueryParameter("code") ?: throw IOException("The server sent no code.")
        val meta = metadata()
        val tokens = post(meta.getString("token_endpoint"), mapOf(
            "grant_type" to "authorization_code", "code" to code, "redirect_uri" to REDIRECT,
            "client_id" to clientId(meta), "code_verifier" to verifier))
        keep(tokens)
        val me = pages()
        prefs.edit { putString(K_EMAIL, me.email) }
        email = me.email
    }

    /** The signed-in account's published pages, newest first (the server's deploy/pages.json). */
    suspend fun pages(): MyPages {
        val body = JSONObject(authorizedGet("$server/deploy/pages.json"))
        val list = body.getJSONArray("pages")
        val account = body.getJSONObject("account")
        if (account.has("id")) prefs.edit { putLong(K_ID, account.getLong("id")) }
        return MyPages(account.getString("email"), account.optString("name").takeIf { it.isNotBlank() && it != "null" },
            (0 until list.length()).map { i ->
                val p = list.getJSONObject(i)
                val doc = p.optJSONObject("document")
                PublishedPage(
                    id = p.getString("id"), title = p.optString("title").ifBlank { "Untitled" }, url = p.getString("url"),
                    rcUrl = p.getString("rc_url"), previewUrl = p.optString("preview_url").takeIf { it.isNotBlank() && it != "null" },
                    created = p.optString("created"), rcBytes = p.optInt("rc_bytes"),
                    width = doc?.optInt("width") ?: 0, height = doc?.optInt("height") ?: 0,
                    stream = p.optJSONObject("stream")?.let { st ->
                        StreamEntry(st.optString("title"), st.optJSONArray("tags").strings(), st.optInt("score"))
                    },
                )
            })
    }

    /**
     * The public stream (the examples site's stream/items.json, under /examples): sorted "new" or "top", only [tag]'s
     * items, matching [query]'s words. Signed in, each item carries this account's vote.
     */
    /** The signed-in account's apps (kobento-mcp's apps tool), newest first: deploy/apps.json. */
    suspend fun apps(): List<MyApp> {
        val a = JSONObject(authorizedGet("$server/deploy/apps.json")).getJSONArray("apps")
        return (0 until a.length()).map { a.getJSONObject(it) }.map {
            MyApp(it.getString("app_id"), it.optString("title"), it.optInt("screens"), it.optString("url").ifEmpty { null }, it.optInt("version"),
                draft = it.optString("draft").ifEmpty { null })
        }
    }

    /** A file only the signed-in account may read (an app's draft: its app.json and screens). */
    suspend fun authorizedDownload(url: String): ByteArray {
        suspend fun once(token: String): ByteArray = withContext(Dispatchers.IO) {
            val c = URL(url).openConnection() as HttpURLConnection
            try {
                c.connectTimeout = 15_000
                c.readTimeout = 30_000
                c.setRequestProperty("Authorization", "Bearer $token")
                if (c.responseCode >= 400) throw HttpError(c.responseCode, "HTTP ${c.responseCode} for $url")
                c.inputStream.use { it.readBytes() }
            } finally {
                c.disconnect()
            }
        }
        return try { once(accessToken()) } catch (e: HttpError) {
            if (e.status != 401) throw e
            once(accessToken(forceRefresh = true))
        }
    }

    suspend fun stream(sort: String, tag: String?, query: String): StreamPage {
        val qs = buildString {
            append("?sort=").append(sort)
            tag?.let { append("&tag=").append(enc(it)) }
            query.trim().takeIf { it.isNotEmpty() }?.let { append("&q=").append(enc(it)) }
        }
        val url = "$server/examples/stream/items.json$qs"
        val text = if (email == null) get(url) else try { authorizedGet(url) } catch (_: SignedOut) { get(url) }
        val body = JSONObject(text)
        val items = body.getJSONArray("items")
        val tags = body.optJSONArray("tags")
        return StreamPage(
            items = (0 until items.length()).map { i ->
                val it = items.getJSONObject(i)
                val doc = it.optJSONObject("document")
                StreamItem(
                    pageId = it.getString("page_id"), title = it.optString("title").ifBlank { "Untitled" },
                    author = it.optString("author"), authorId = if (it.isNull("author_id")) null else it.optLong("author_id"), tags = it.optJSONArray("tags").strings(),
                    score = it.optInt("score"), ups = it.optInt("ups"), downs = it.optInt("downs"),
                    myVote = if (it.isNull("my_vote")) null else it.optInt("my_vote"), showcase = it.optBoolean("showcase"),
                    isApp = it.optString("kind") == "app",
                    page = PublishedPage(
                        id = it.getString("page_id"), title = it.optString("title").ifBlank { "Untitled" }, url = it.getString("url"),
                        rcUrl = if (it.isNull("rc_url")) "" else it.optString("rc_url"), previewUrl = it.optString("preview_url").takeIf { u -> u.isNotBlank() && u != "null" },
                        created = it.optString("created"), rcBytes = it.optInt("rc_bytes"),
                        width = doc?.optInt("width") ?: 0, height = doc?.optInt("height") ?: 0,
                    ),
                )
            },
            tags = tags?.let { a -> (0 until a.length()).map { a.getJSONObject(it).getString("tag") } }.orEmpty(),
        )
    }

    /** Votes on a stream item: 1, -1, or 0 to take the vote back. Returns the item's new tally. */
    suspend fun vote(pageId: String, value: Int): Vote {
        val url = "$server/examples/stream/$pageId/vote"
        val body = "value=$value"
        val text = try {
            request("POST", url, body, "application/x-www-form-urlencoded", accessToken())
        } catch (e: HttpError) {
            if (e.status != 401) throw e
            request("POST", url, body, "application/x-www-form-urlencoded", accessToken(forceRefresh = true))
        }
        val j = JSONObject(text)
        return Vote(j.optInt("score"), j.optInt("ups"), j.optInt("downs"), j.optInt("my_vote"))
    }

    /**
     * Posts one of the account's pages to the stream, or renames and retags it there: [tags] as
     * "a, b". [name], when given, becomes the account's public name first (posting needs one).
     */
    suspend fun postToStream(pageId: String, title: String, tags: String, name: String?): StreamEntry {
        val form = buildMap {
            put("title", title); put("tags", tags)
            if (name != null) put("name", name)
        }
        val j = JSONObject(authorizedPost("$server/examples/stream/$pageId/post", form)).getJSONObject("item")
        return StreamEntry(j.optString("title"), j.optJSONArray("tags").strings(), j.optInt("score"))
    }

    /** Takes one of the account's pages out of the stream (its votes go too). */
    suspend fun removeFromStream(pageId: String) {
        authorizedPost("$server/examples/stream/$pageId/remove", emptyMap())
    }

    /** Reports someone else's stream item ([REPORT_REASONS]'s key, an optional note): it leaves this account's stream. */
    suspend fun report(pageId: String, reason: String, note: String) {
        authorizedPost("$server/examples/stream/$pageId/report", mapOf("reason" to reason, "note" to note))
    }

    /** Hides an author's stream items from this account ([unblock] shows them again). */
    suspend fun block(authorId: Long) { authorizedPost("$server/examples/stream/authors/$authorId/block", emptyMap()) }

    suspend fun unblock(authorId: Long) { authorizedPost("$server/examples/stream/authors/$authorId/unblock", emptyMap()) }

    /** The authors this account blocked. */
    suspend fun blocked(): List<BlockedAuthor> {
        val a = JSONObject(authorizedGet("$server/examples/stream/blocked.json")).getJSONArray("blocked")
        return (0 until a.length()).map { i ->
            val b = a.getJSONObject(i)
            BlockedAuthor(b.getLong("id"), b.optString("name").takeIf { it.isNotBlank() && it != "null" } ?: "Someone")
        }
    }

    /**
     * Deletes the account on the server, for good: its pages, Stream items, libraries, uploads and
     * tokens (the person confirmed first). Then the app forgets it.
     */
    suspend fun deleteAccount() {
        authorizedPost("$server/account/me/delete", mapOf("confirm" to "delete"))
        clear()
    }

    private suspend fun authorizedPost(url: String, form: Map<String, String>): String {
        val body = form.entries.joinToString("&") { (k, v) -> "${enc(k)}=${enc(v)}" }
        return try {
            request("POST", url, body, "application/x-www-form-urlencoded", accessToken())
        } catch (e: HttpError) {
            if (e.status != 401) throw e
            request("POST", url, body, "application/x-www-form-urlencoded", accessToken(forceRefresh = true))
        }
    }

    /** Signs out: the server forgets the grant (revoking the refresh token), the app its tokens. */
    suspend fun signOut() {
        val refresh = prefs.getString(K_REFRESH, null)
        clear()
        if (refresh != null) runCatching {
            metadata().optString("revocation_endpoint").takeIf { it.isNotBlank() }?.let { post(it, mapOf("token" to refresh, "client_id" to (prefs.getString(K_CLIENT, null) ?: ""))) }
        }
    }

    private fun clear() {
        prefs.edit { remove(K_ACCESS); remove(K_REFRESH); remove(K_EXPIRES); remove(K_EMAIL); remove(K_ID) }
        email = null
    }

    // --- tokens

    private fun keep(t: JSONObject) {
        prefs.edit {
            putString(K_ACCESS, t.getString("access_token"))
            t.optString("refresh_token").takeIf { it.isNotBlank() }?.let { putString(K_REFRESH, it) }
            putLong(K_EXPIRES, System.currentTimeMillis() + t.optLong("expires_in", 3600) * 1000 - 60_000)
        }
    }

    private suspend fun accessToken(forceRefresh: Boolean = false): String {
        val access = prefs.getString(K_ACCESS, null)
        if (!forceRefresh && access != null && System.currentTimeMillis() < prefs.getLong(K_EXPIRES, 0)) return access
        val refresh = prefs.getString(K_REFRESH, null) ?: throw SignedOut()
        val meta = metadata()
        val t = try {
            post(meta.getString("token_endpoint"), mapOf("grant_type" to "refresh_token", "refresh_token" to refresh, "client_id" to clientId(meta)))
        } catch (e: HttpError) {
            if (e.status in 400..401) { clear(); throw SignedOut() }   // expired or revoked: sign in again
            throw e
        }
        keep(t)
        return t.getString("access_token")
    }

    private suspend fun authorizedGet(url: String): String {
        try {
            return get(url, accessToken())
        } catch (e: HttpError) {
            if (e.status != 401) throw e
        }
        return try { get(url, accessToken(forceRefresh = true)) } catch (e: HttpError) {
            if (e.status == 401) { clear(); throw SignedOut() }
            throw e
        }
    }

    // --- the server

    private suspend fun metadata(): JSONObject = meta ?: JSONObject(get("$server/.well-known/oauth-authorization-server")).also { meta = it }

    /** This app's client id on the server, registered the first time. */
    private suspend fun clientId(meta: JSONObject): String {
        prefs.getString(K_CLIENT, null)?.takeIf { prefs.getString(K_CLIENT_FOR, null) == server }?.let { return it }
        val reg = JSONObject().put("client_name", "Kobento showcases (Android)")
            .put("redirect_uris", org.json.JSONArray().put(REDIRECT))
            .put("grant_types", org.json.JSONArray().put("authorization_code").put("refresh_token"))
            .put("token_endpoint_auth_method", "none")
        val id = JSONObject(request("POST", meta.getString("registration_endpoint"), reg.toString(), "application/json")).getString("client_id")
        prefs.edit { putString(K_CLIENT, id); putString(K_CLIENT_FOR, server) }
        return id
    }

    private suspend fun get(url: String, bearer: String? = null) = request("GET", url, null, null, bearer)

    private suspend fun post(url: String, form: Map<String, String>) = JSONObject(request("POST", url,
        form.entries.joinToString("&") { (k, v) -> "${enc(k)}=${enc(v)}" }, "application/x-www-form-urlencoded"))

    private suspend fun request(method: String, url: String, body: String?, type: String?, bearer: String? = null): String =
        withContext(Dispatchers.IO) {
            val c = URL(url).openConnection() as HttpURLConnection
            try {
                c.requestMethod = method
                c.connectTimeout = 15_000
                c.readTimeout = 20_000
                c.setRequestProperty("Accept", "application/json")
                bearer?.let { c.setRequestProperty("Authorization", "Bearer $it") }
                if (body != null) {
                    c.doOutput = true
                    c.setRequestProperty("Content-Type", type)
                    c.outputStream.use { it.write(body.toByteArray()) }
                }
                val status = c.responseCode
                val text = (if (status < 400) c.inputStream else c.errorStream)?.bufferedReader()?.use { it.readText() }.orEmpty()
                if (status >= 400) {
                    val why = runCatching { JSONObject(text).let { it.optString("error_description").ifBlank { it.optString("error") } } }.getOrNull()
                    throw HttpError(status, why?.ifBlank { null } ?: "HTTP $status")
                }
                text
            } finally {
                c.disconnect()
            }
        }

    class HttpError(val status: Int, message: String) : IOException(message)
    class SignedOut : IOException("Signed out: sign in again.")

    companion object {
        const val SCHEME = "dev.kobento.showcases"
        const val REDIRECT = "$SCHEME:/oauth"
        private const val K_SERVER = "server"   // the server the saved tokens belong to
        private const val K_CLIENT = "client_id"
        private const val K_CLIENT_FOR = "client_server"
        private const val K_ACCESS = "access"
        private const val K_REFRESH = "refresh"
        private const val K_EXPIRES = "expires"
        private const val K_EMAIL = "email"
        private const val K_ID = "account_id"

        /** Why an item is reported: the server's REPORT_REASONS (lib/accounts.mjs), in its order. */
        val REPORT_REASONS = listOf(
            "offensive" to "Offensive or hateful", "sexual" to "Sexual content", "violent" to "Violent or dangerous",
            "spam" to "Spam or misleading", "illegal" to "Illegal, or someone else's work", "other" to "Something else",
        )
        private const val K_VERIFIER = "verifier"
        private const val K_STATE = "state"

        private fun org.json.JSONArray?.strings() = this?.let { a -> (0 until a.length()).map { a.getString(it) } }.orEmpty()
        private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")
        private fun b64(b: ByteArray) = Base64.encodeToString(b, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
        private fun random(n: Int) = b64(ByteArray(n).also { SecureRandom().nextBytes(it) })
    }
}

/** What pages.json returns: who is signed in (and the public name the stream shows), and their pages. */
data class MyPages(val email: String, val name: String?, val pages: List<PublishedPage>)

/** An app of the account's: several pages tied together; `url` (its published link) is null until it is published. */
data class MyApp(val id: String, val title: String, val screens: Int, val url: String?, val version: Int,
    /** The owner's draft (the pages as they are now), played signed in. */
    val draft: String? = null)

/** A page's entry in the stream: the name it is shown under, its tags and its score. */
data class StreamEntry(val title: String, val tags: List<String>, val score: Int)

/** A page the account published (rc-deploy), with its document as an .rc. */
data class PublishedPage(
    val id: String,
    val title: String,
    val url: String,
    val rcUrl: String,
    val previewUrl: String?,
    val created: String,
    val rcBytes: Int,
    val width: Int,
    val height: Int,
    /** Its entry in the stream, when the account posted it (only on the account's own pages). */
    val stream: StreamEntry? = null,
)

/** What stream/items.json returns: the items, and the tags in use (the most used first). */
data class StreamPage(val items: List<StreamItem>, val tags: List<String>)

/** One item of the stream: its name, poster and votes, and the published page it plays. */
data class StreamItem(
    val pageId: String,
    val title: String,
    val author: String,
    /** The poster's account id (to block them), or null from an older server. */
    val authorId: Long?,
    val tags: List<String>,
    val score: Int,
    val ups: Int,
    val downs: Int,
    /** This account's vote (1, -1, 0), or null signed out. */
    val myVote: Int?,
    val showcase: Boolean,
    /** An app (several screens, played by AppPlayerScreen from page.url), not a page. */
    val isApp: Boolean = false,
    val page: PublishedPage,
)

/** An author this account blocked in the stream. */
data class BlockedAuthor(val id: Long, val name: String)

/** An item's tally after a vote. */
data class Vote(val score: Int, val ups: Int, val downs: Int, val myVote: Int)

/** Downloads a public file (a page's .rc or preview). */
suspend fun download(url: String): ByteArray = withContext(Dispatchers.IO) {
    val c = URL(url).openConnection() as HttpURLConnection
    try {
        c.connectTimeout = 15_000
        c.readTimeout = 30_000
        if (c.responseCode >= 400) throw IOException("HTTP ${c.responseCode} for $url")
        c.inputStream.use { it.readBytes() }
    } finally {
        c.disconnect()
    }
}
