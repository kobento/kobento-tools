package dev.kobento.showcases

import android.annotation.SuppressLint
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.coroutines.resume

/**
 * Converts a document's JSON to an .rc for this screen's density, on the device: a launcher's
 * widget host lays documents out in pixels and the documents are written in dp, so a widget
 * gets them converted (json2rc's density option: lengths times the density, what the player
 * reports in pixels read back in dp).
 *
 * json2rc is TypeScript: its browser bundle (json2rc/build/json2rc-browser.js, an asset) runs in
 * a WebView that is never shown. The JSON goes in and the bytes come out (base64) through a
 * JavaScript interface, so neither passes through a script's source.
 */
object DensityBaker {
    private const val ASSET = "json2rc-browser.js"

    /** The .rc of [json] for [density], or null when it can't be converted (the reason logged). */
    suspend fun bake(context: Context, json: String, density: Float): ByteArray? {
        val script = withContext(Dispatchers.IO) {
            runCatching { context.assets.open(ASSET).bufferedReader().use { it.readText() } }.getOrNull()
        } ?: return null
        return withTimeoutOrNull(30_000) { withContext(Dispatchers.Main) { run(context.applicationContext, script, json, density) } }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private suspend fun run(context: Context, script: String, json: String, density: Float): ByteArray? =
        suspendCancellableCoroutine { cont ->
            val web = WebView(context)
            val main = Handler(Looper.getMainLooper())
            fun finish(bytes: ByteArray?) {
                main.post {
                    web.destroy()
                    if (cont.isActive) cont.resume(bytes)
                }
            }
            web.settings.javaScriptEnabled = true
            web.addJavascriptInterface(object {
                @JavascriptInterface fun json(): String = json
                @JavascriptInterface fun done(base64: String) = finish(Base64.decode(base64, Base64.DEFAULT))
                @JavascriptInterface fun fail(message: String) {
                    android.util.Log.w("DensityBaker", "json2rc: $message")
                    finish(null)
                }
            }, "Host")
            cont.invokeOnCancellation { main.post { web.destroy() } }
            val d = "%.4f".format(java.util.Locale.US, density)
            // Scripts run in a loaded page: a blank one, then the converter and the call.
            web.webViewClient = object : WebViewClient() {
                private var started = false
                override fun onPageFinished(view: WebView, url: String?) {
                    if (started) return
                    started = true
                    convert(web, script, d)
                }
            }
            web.loadDataWithBaseURL(null, "<!doctype html><title></title>", "text/html", "utf-8", null)
        }

    private fun convert(web: WebView, script: String, d: String) {
        web.evaluateJavascript(script) {
            web.evaluateJavascript("""
                (function () {
                  try {
                    var b = json2rc.convert(JSON.parse(Host.json()), { density: $d });
                    var s = "";
                    for (var i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
                    Host.done(btoa(s));
                  } catch (e) { Host.fail(String(e && e.message || e)); }
                })();
            """.trimIndent(), null)
        }
    }
}
