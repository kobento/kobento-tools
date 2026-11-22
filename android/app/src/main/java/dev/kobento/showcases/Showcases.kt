package dev.kobento.showcases

import android.content.res.AssetManager
import org.json.JSONObject

/**
 * One showcase as the build copied it into assets/showcases/<folder>/: doc.rc, its mono looks
 * (doc.mono-dark.rc, doc.mono-light.rc) when it has them, the light and dark renders, meta.json.
 */
data class Showcase(
    val id: String,
    val folder: String,
    /** "Marble drop" out of "Marble drop: a physics toy with pegs, gravity and tilt". */
    val name: String,
    /** The rest of the title ("A physics toy with pegs, gravity and tilt"), or the whole title. */
    val tagline: String,
    val summary: String,
    /** phone, tablet, square, watch-round, widget-4x1: how the player frames it. */
    val formFactor: String,
    val looks: List<Look>,
    /**
     * Why the androidx player cannot play it, or null: the document uses Kobento's 3D extension
     * (DRAW_MESH_3D, SET_CAMERA_3D, ...), operations only Kobento's players implement.
     */
    val unsupported: String?,
    /** The document as the catalog built it: operations, the size it is designed at (dp). */
    val opCount: Int,
    val designWidth: Int,
    val designHeight: Int,
    /** How often it repaints: continuous, scheduled or idle (only when something changes). */
    val repaint: String?,
    /** What it shows off, as the catalog's labels ("Particles", "Drag"). */
    val capabilities: List<String>,
) {
    fun asset(file: String) = "showcases/$folder/$file"
}

/** A way to play a document: the theme the player is given, and which .rc. */
enum class Look(val label: String, val file: String) {
    Auto("Auto", "doc.rc"),
    Light("Light", "doc.rc"),
    Dark("Dark", "doc.rc"),
    MonoLight("Mono light", "doc.mono-light.rc"),
    MonoDark("Mono dark", "doc.mono-dark.rc"),
}

/** The showcases in assets, by id (SHW-04, SHW-10, ...). */
fun loadShowcases(assets: AssetManager): List<Showcase> {
    val labels = capabilityLabels(assets)
    val folders = assets.list("showcases").orEmpty().filter { it.startsWith("SHW-") }
    return folders.mapNotNull { folder ->
        val files = assets.list("showcases/$folder").orEmpty().toSet()
        if ("doc.rc" !in files || "meta.json" !in files) return@mapNotNull null
        val meta = JSONObject(assets.open("showcases/$folder/meta.json").bufferedReader().use { it.readText() })
        val derived = meta.optJSONObject("derived")
        val header = derived?.optJSONObject("header")
        val title = meta.optString("title", folder)
        val colon = title.indexOf(": ")
        Showcase(
            id = meta.optString("id", folder.substringBefore('-', folder)),
            folder = folder,
            // "Marble drop: a physics toy ..." is a name and a tagline; a title without one ("A world
            // clock with day and night") is the tagline, under the example's short name ("World clock").
            name = if (colon > 0) title.substring(0, colon)
                else meta.optString("name").replace('-', ' ').replaceFirstChar { it.uppercase() }.ifBlank { title },
            tagline = if (colon > 0) title.substring(colon + 2).replaceFirstChar { it.uppercase() } else title,
            summary = meta.optString("summary"),
            formFactor = meta.optString("form_factor", "phone"),
            looks = Look.entries.filter { it.file in files },
            unsupported = if (BuildConfig.PLAYER_3D) null else meta.optJSONObject("derived")?.optJSONObject("operations")?.keys()?.asSequence()
                ?.filter { "_3D" in it }?.toList()?.takeIf { it.isNotEmpty() }
                ?.let { "It draws with Kobento's 3D extension (${it.sorted().joinToString(", ")}), which the androidx player does not implement." },
            opCount = derived?.optInt("op_count") ?: 0,
            designWidth = header?.optInt("width") ?: 0,
            designHeight = header?.optInt("height") ?: 0,
            repaint = derived?.optString("repaint")?.ifBlank { null },
            capabilities = meta.optJSONObject("capabilities")?.optJSONArray("primary")
                ?.let { a -> (0 until a.length()).map { a.getString(it) } }.orEmpty()
                .map { labels[it] ?: it },
        )
    }.sortedBy { it.id.substringAfter('-').toIntOrNull() ?: Int.MAX_VALUE }
}

/** The catalog's capability labels ("fx.particles" -> "Particles"), from examples-vocabulary.json. */
private fun capabilityLabels(assets: AssetManager): Map<String, String> = runCatching {
    val caps = JSONObject(assets.open("examples-vocabulary.json").bufferedReader().use { it.readText() })
        .getJSONObject("capabilities")
    caps.keys().asSequence().associateWith { caps.getJSONObject(it).optString("label", it) }
}.getOrDefault(emptyMap())
