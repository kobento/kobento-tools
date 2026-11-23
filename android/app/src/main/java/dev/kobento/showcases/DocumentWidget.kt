package dev.kobento.showcases

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.widget.RemoteViews
import android.widget.Toast
import java.io.File

/**
 * A launcher widget that shows a RemoteCompose document. The launcher plays it itself: the
 * widget hands over the document's bytes as RemoteViews draw instructions (Android 15+, a
 * launcher with the draw_data_parcel flag), so it runs on the platform's player, not this app's.
 *
 * Each widget keeps its document in files/widgets/<id>.rc. "Add to home screen" writes the
 * document to next.rc and asks the launcher to pin a new widget; the first widget without a
 * document of its own takes next.rc, whether it is the pinned one or one added from the
 * launcher's widget list.
 */
class DocumentWidget : AppWidgetProvider() {

    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        for (id in ids) show(context, manager, id)
    }

    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)
        // The launcher's answer to a pin request: the new widget's id.
        if (intent.action == ACTION_PINNED) {
            val id = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
            if (id != AppWidgetManager.INVALID_APPWIDGET_ID) show(context, AppWidgetManager.getInstance(context), id)
        }
    }

    override fun onDeleted(context: Context, ids: IntArray) {
        for (id in ids) docFile(context, id).delete()
    }

    companion object {
        private const val ACTION_PINNED = "dev.kobento.showcases.WIDGET_PINNED"

        private fun dir(context: Context) = File(context.filesDir, "widgets").apply { mkdirs() }
        private fun docFile(context: Context, id: Int) = File(dir(context), "$id.rc")
        private fun nextFile(context: Context) = File(dir(context), "next.rc")

        /** Draws widget [id]: its document, or the next one waiting, or how to give it one. */
        private fun show(context: Context, manager: AppWidgetManager, id: Int) {
            val doc = docFile(context, id)
            val next = nextFile(context)
            if (!doc.exists() && next.exists()) next.renameTo(doc)
            manager.updateAppWidget(id, views(context, doc.takeIf { it.exists() }?.readBytes()))
        }

        private fun views(context: Context, bytes: ByteArray?): RemoteViews {
            if (bytes != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.VANILLA_ICE_CREAM) {
                try {
                    return RemoteViews(RemoteViews.DrawInstructions.Builder(listOf(bytes)).build())
                } catch (e: Exception) {
                    // The platform has the API but not the feature (draw_data_parcel off): say so below.
                    android.util.Log.w("DocumentWidget", "draw instructions refused", e)
                }
            }
            return RemoteViews(context.packageName, R.layout.widget_message).apply {
                setTextViewText(R.id.widget_message, context.getString(
                    if (bytes == null) R.string.widget_empty else R.string.widget_unsupported))
                val open = Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                setOnClickPendingIntent(R.id.widget_message,
                    PendingIntent.getActivity(context, 0, open, PendingIntent.FLAG_IMMUTABLE))
            }
        }

        /**
         * A published page's JSON (for [rcUrl], its `.../pages/<id>/document.rc`): the files its
         * page lists for its JSON viewer, the expanded one first (components drawn in place,
         * what json2rc reads), else the document as published; null for a page published
         * from an .rc.
         */
        suspend fun pageJson(rcUrl: String): String? {
            val base = rcUrl.substringBeforeLast('/') + "/"
            val html = String(download(base))
            val files = Regex("\"url\":\"([\\w.-]+\\.json)\"").findAll(html).map { it.groupValues[1] }.toList()
            val file = files.firstOrNull { it.endsWith(".expanded.json") } ?: files.firstOrNull() ?: return null
            return String(download(base + file))
        }

        /** Whether this device can show a document in a widget at all. */
        fun supported() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.VANILLA_ICE_CREAM

        /**
         * The device's density for the server (`?density=`): the launcher's player lays a
         * document out in pixels, so the widget gets the document converted to them.
         */
        private fun densityParam(context: Context): String =
            "%.4f".format(java.util.Locale.US, context.resources.displayMetrics.density).trimEnd('0').trimEnd('.')

        /**
         * Puts a document on the home screen: asks the launcher to pin a new widget showing it.
         * The launcher lays documents out in pixels and they are written in dp, so the widget
         * gets the document converted for this screen's density: from its JSON ([json], the
         * showcase's own or the page's), converted here (DensityBaker); else the server's copy
         * ([densityUrl]`?density=`); else [bytes] as they are (they show small, and a message
         * says so). A launcher that can't pin is told to add the widget from its list; the
         * document waits.
         */
        suspend fun addToHomeScreen(context: Context, bytes: ByteArray, title: String,
                                    json: (suspend () -> String?)?, densityUrl: String?) {
            if (!supported()) {
                Toast.makeText(context, R.string.widget_unsupported, Toast.LENGTH_LONG).show()
                return
            }
            val density = context.resources.displayMetrics.density
            val baked = json?.let { source ->
                runCatching { source()?.let { DensityBaker.bake(context, it, density) } }
                    .onFailure { android.util.Log.w("DocumentWidget", "no JSON to convert", it) }.getOrNull()
            }
            val sep = if (densityUrl?.contains('?') == true) "&" else "?"
            val scaled = baked ?: densityUrl?.let { runCatching { download("$it${sep}density=${densityParam(context)}") }.getOrNull() }
            if (scaled == null) Toast.makeText(context, R.string.widget_not_scaled, Toast.LENGTH_LONG).show()
            nextFile(context).writeBytes(scaled ?: bytes)
            val manager = AppWidgetManager.getInstance(context)
            val provider = ComponentName(context, DocumentWidget::class.java)
            val pinned = PendingIntent.getBroadcast(context, 0,
                Intent(context, DocumentWidget::class.java).setAction(ACTION_PINNED),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE)   // mutable: the launcher adds the id
            if (manager.isRequestPinAppWidgetSupported && manager.requestPinAppWidget(provider, null, pinned)) return
            Toast.makeText(context, context.getString(R.string.widget_add_manually, title), Toast.LENGTH_LONG).show()
        }
    }
}
