package dev.kobento.showcases

import android.annotation.SuppressLint
import android.content.Context
import android.content.res.Configuration
import android.util.DisplayMetrics
import android.view.ContextThemeWrapper
import android.view.View
import android.view.ViewGroup
import kotlin.math.roundToInt

/**
 * Hosts one child laid out in dp: the child gets this view's size divided by the display density
 * and is scaled back up by it. A document without a density header (densityBehavior, API level 8)
 * is laid out by the androidx player in pixels, while the showcases are written in dp, as the web
 * and C++ players read them: without this a phone screen would be a 1080-unit-wide document and
 * everything in it a third of its size. View scaling keeps the drawing sharp (it scales the
 * recorded drawing, not a bitmap) and maps touches back into the child's coordinates.
 *
 * The child is made with [childContext]: its density is 1 (160 dpi), since the scaling is done
 * here. The player scales some values by its context's density even in a document without a
 * density header (widthIn / heightIn, which androidx's Compose creation writes in dp; dp widths;
 * the density() variable), and with the display's density they would be scaled twice: a 48 dp
 * heightIn row was 126 dp tall at 2.625 (kobento-mcp findings U97).
 */
@SuppressLint("ViewConstructor")   // made in code, around its child: never inflated
class DpHost(context: Context, val child: View) : ViewGroup(context) {
    private val density = if (enabled) context.resources.displayMetrics.density else 1f

    companion object {
        /** Off (`--ez dp false` at launch): the player lays the document out in pixels, as it would by itself. */
        var enabled = true

        /** The context to make the child with: its density 1 when [enabled], else [context] itself. */
        fun childContext(context: Context): Context = if (!enabled) context else
            ContextThemeWrapper(context, context.theme).apply {
                applyOverrideConfiguration(Configuration().apply { densityDpi = DisplayMetrics.DENSITY_DEFAULT })
            }
    }

    init {
        clipChildren = true
        addView(child)
        child.pivotX = 0f
        child.pivotY = 0f
        child.scaleX = density
        child.scaleY = density
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val w = MeasureSpec.getSize(widthMeasureSpec)
        val h = MeasureSpec.getSize(heightMeasureSpec)
        setMeasuredDimension(w, h)
        child.measure(
            MeasureSpec.makeMeasureSpec((w / density).roundToInt(), MeasureSpec.EXACTLY),
            MeasureSpec.makeMeasureSpec((h / density).roundToInt(), MeasureSpec.EXACTLY),
        )
    }

    override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
        child.layout(0, 0, child.measuredWidth, child.measuredHeight)
    }
}
