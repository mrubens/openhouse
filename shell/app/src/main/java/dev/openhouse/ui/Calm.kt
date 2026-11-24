package dev.openhouse.ui

// OpenHouse's one look for its own screens, native and Compose alike: the home screen's paper, ink and one accent
// (chat/src/home.jsx, the "paper" palette), its type (Inter, as bridge/kit/quiet.css), one dark button for the main
// action and quiet text buttons for the rest. Every screen the shell draws itself takes its colors, sizes and pieces
// from here, so they can't drift apart again.
//
// Sizes are in u, as on the home screen: one u is one pixel of a 1536-wide layout, scaled to the screen, so a
// screen reads the same on any tablet and from across the kitchen.

import android.app.Dialog
import android.content.Context
import android.content.DialogInterface
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.content.res.ColorStateList
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight

object Calm {
    // --- colors (ARGB), the home screen's "paper" palette ---------------------------------------------------
    /** Behind everything (the home screen's rail). */
    const val PAPER = 0xFFEFEAE1.toInt()
    /** The page things sit on (the home screen's sheet). */
    const val SHEET = 0xFFFBF9F5.toInt()
    const val INK = 0xFF2A2826.toInt()
    /** Secondary text: still readable across the room. */
    const val SOFT = 0xFF6E6A65.toInt()
    /** Small print and hints. */
    const val FAINT = 0xFF97928B.toInt()
    const val LINE = 0xFFE4E1DC.toInt()
    /** A soft fill on the sheet: cards, fields, quiet buttons. */
    const val TINT = 0xFFF1EEE9.toInt()
    const val TINT2 = 0xFFE7E3DC.toInt()
    /** The one accent: today, what's chosen, a focus ring. Never a button's fill. */
    const val ACCENT = 0xFFB5562F.toInt()
    const val SCRIM = 0x4D2A2826
    /** A button that deletes or replaces something that can't simply be put back (docs/ux.md). */
    const val DANGER = 0xFFA8321E.toInt()

    // --- the type scale (u) ----------------------------------------------------------------------------------
    const val DISPLAY = 44f   // a first-run screen's question
    const val TITLE = 30f     // a dialog's or sheet's title
    const val LEAD = 22f      // the line under a title
    const val BODY = 21f
    const val LABEL = 20f     // buttons and row titles
    const val SMALL = 16f     // small print
    const val EYEBROW = 14f   // section labels, in capitals

    // --- shapes (u) ------------------------------------------------------------------------------------------
    const val R_SHEET = 28f
    const val R_CARD = 22f
    const val R_FIELD = 18f
    const val BUTTON_H = 64f

    // --- Compose ---------------------------------------------------------------------------------------------
    val paper = Color(PAPER); val sheet = Color(SHEET); val ink = Color(INK); val soft = Color(SOFT); val faint = Color(FAINT)
    val line = Color(LINE); val tint = Color(TINT); val tint2 = Color(TINT2); val accent = Color(ACCENT); val scrim = Color(SCRIM)

    /** The shell's Compose sheets: this look as a [Palette] (Inter, ink on the sheet, a dark main button). */
    fun palette() = Palette(
        text = ink, muted = soft, card = tint, card2 = tint2, line = line, accent = ink, accentInk = sheet,
        ok = Color(0xFF4E7D5C), tipBg = tint, warnBg = Color(0xFFF6E7DF), timerBg = tint, timerLine = line, timerOnBg = tint2,
        panel = tint, font = PaperLook.quiet,
    )

    // --- Android views ---------------------------------------------------------------------------------------
    /** Pixels per u on this screen (the long side is 1536 u). */
    fun u(c: Context): Float = c.resources.displayMetrics.let { maxOf(it.widthPixels, it.heightPixels) / 1536f }
    fun px(c: Context, v: Number): Int = (v.toFloat() * u(c)).toInt()

    private val faces = HashMap<Int, Typeface>()
    /** Inter at [weight], from the shell's assets; the system sans if it can't be read. */
    fun face(c: Context, weight: Int = 400): Typeface = faces.getOrPut(weight) {
        runCatching { Typeface.Builder(c.assets, "fonts/Inter.ttf").setFontVariationSettings("'wght' $weight").build() }.getOrNull()
            ?: Typeface.create(Typeface.SANS_SERIF, if (weight >= 600) Typeface.BOLD else Typeface.NORMAL)
    }

    fun text(c: Context, s: CharSequence?, size: Float = BODY, weight: Int = 400, color: Int = INK) = TextView(c).apply {
        text = s; setTextSize(TypedValue.COMPLEX_UNIT_PX, size * u(c)); typeface = face(c, weight); setTextColor(color)
        includeFontPadding = false; setLineSpacing(size * u(c) * .32f, 1f)
        if (size >= TITLE) letterSpacing = -0.012f
    }
    fun display(c: Context, s: CharSequence?) = text(c, s, DISPLAY, 500)
    fun title(c: Context, s: CharSequence?) = text(c, s, TITLE, 600)
    fun lead(c: Context, s: CharSequence?) = text(c, s, LEAD, 400, SOFT)
    fun small(c: Context, s: CharSequence?) = text(c, s, SMALL, 400, FAINT)
    fun eyebrow(c: Context, s: CharSequence?) = text(c, s?.toString()?.uppercase(), EYEBROW, 600, SOFT).apply { letterSpacing = .08f }

    fun rounded(color: Int, radius: Float, stroke: Int = 0, strokeColor: Int = LINE) = GradientDrawable().apply {
        setColor(color); cornerRadius = radius; if (stroke > 0) setStroke(stroke, strokeColor)
    }
    /** [d] that darkens a little while pressed. */
    fun pressable(c: Context, d: GradientDrawable, radius: Float) =
        RippleDrawable(ColorStateList.valueOf(0x1F2A2826), d, rounded(0xFFFFFFFF.toInt(), radius))

    private fun button(c: Context, label: CharSequence, bg: Int, fg: Int, weight: Int, onClick: () -> Unit) = text(c, label, LABEL, weight, fg).apply {
        gravity = Gravity.CENTER; minHeight = px(c, BUTTON_H); val p = px(c, 32); setPadding(p, 0, p, 0)
        val r = BUTTON_H * u(c) / 2
        background = pressable(c, rounded(bg, r), r); isClickable = true; isFocusable = true
        setOnClickListener { onClick() }
    }
    /** The main action: ink, one per screen. */
    fun primary(c: Context, label: CharSequence, onClick: () -> Unit) = button(c, label, INK, SHEET, 600, onClick)
    /** The main action when it deletes or replaces something for good: red, one per screen. */
    fun danger(c: Context, label: CharSequence, onClick: () -> Unit) = button(c, label, DANGER, SHEET, 600, onClick)
    /** A second action that still wants a shape (Continue beside a field). */
    fun soft(c: Context, label: CharSequence, onClick: () -> Unit) = button(c, label, TINT2, INK, 600, onClick)
    /** Everything else: words that can be tapped (Not now, Cancel). */
    fun quiet(c: Context, label: CharSequence, onClick: () -> Unit) = button(c, label, 0x00000000, SOFT, 500, onClick).apply {
        val p = px(c, 20); setPadding(p, 0, p, 0)
    }

    /** A text box on the sheet: a soft fill, no underline. */
    fun field(c: Context, hint: CharSequence? = null, size: Float = 26f) = EditText(c).apply {
        this.hint = hint; setTextSize(TypedValue.COMPLEX_UNIT_PX, size * u(c)); typeface = face(c, 400)
        setTextColor(INK); setHintTextColor(FAINT); setSingleLine(); minHeight = px(c, BUTTON_H)
        val p = px(c, 24); setPadding(p, px(c, 14), p, px(c, 14))
        background = rounded(TINT, R_FIELD * u(c))
        highlightColor = 0x33B5562F
        textCursorDrawable = GradientDrawable().apply { setColor(INK); setSize(px(c, 2.5f).coerceAtLeast(2), 1) }
    }
    fun gap(c: Context, w: Number = 0, h: Number = 0) = View(c).apply { layoutParams = LinearLayout.LayoutParams(px(c, w), px(c, h)) }
    fun column(c: Context, gap: Number = 0) = LinearLayout(c).apply {
        orientation = LinearLayout.VERTICAL
        if (gap.toFloat() > 0) { showDividers = LinearLayout.SHOW_DIVIDER_MIDDLE; dividerDrawable = GradientDrawable().apply { setSize(1, px(c, gap)) } }
    }
    fun row(c: Context, gap: Number = 0) = LinearLayout(c).apply {
        orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
        if (gap.toFloat() > 0) { showDividers = LinearLayout.SHOW_DIVIDER_MIDDLE; dividerDrawable = GradientDrawable().apply { setSize(px(c, gap), 1) } }
    }

    /** A choice laid out as a card: a name and one line of what it needs. */
    fun choice(c: Context, name: CharSequence, needs: CharSequence, icon: Int = 0, onClick: () -> Unit) = column(c, 10).apply {
        val r = R_CARD * u(c)
        background = pressable(c, rounded(TINT, r), r); isClickable = true; isFocusable = true
        val p = px(c, 32); setPadding(p, px(c, 30), p, px(c, 30))
        if (icon != 0) addView(android.widget.ImageView(c).apply { setImageResource(icon) }, LinearLayout.LayoutParams(px(c, 44), px(c, 44)).apply { bottomMargin = px(c, 10) })
        addView(text(c, name, 26f, 600))
        addView(text(c, needs, 18f, 400, SOFT))
        setOnClickListener { onClick() }
    }

    /**
     * A QR code on a white square (scanners want the quiet border), a caption under it and, with [onShare], a quiet
     * Share. [image] is the ImageView to show it in (so a caller can swap the code later); [size] in u.
     */
    fun qr(c: Context, image: android.widget.ImageView, caption: TextView?, size: Number = 340, onShare: (() -> Unit)? = null) = column(c).apply {
        gravity = Gravity.CENTER_HORIZONTAL
        (image.parent as? ViewGroup)?.removeView(image)
        val pad = px(c, 18)
        addView(FrameLayout(c).apply {
            background = rounded(0xFFFFFFFF.toInt(), R_CARD * u(c), px(c, 1.5f).coerceAtLeast(1), LINE); setPadding(pad, pad, pad, pad)
            addView(image, FrameLayout.LayoutParams(px(c, size), px(c, size)))
        })
        caption?.let { t -> (t.parent as? ViewGroup)?.removeView(t); t.gravity = Gravity.CENTER; addView(t, LinearLayout.LayoutParams(px(c, size.toFloat() + 36), -2).apply { topMargin = px(c, 16) }) }
        onShare?.let { addView(quiet(c, "Share") { it() }, LinearLayout.LayoutParams(-2, -2).apply { topMargin = px(c, 4) }) }
    }
    fun caption(c: Context, s: CharSequence?) = text(c, s, 17f, 400, SOFT)

    /** "More": details that don't change the decision, shown only when tapped (docs/ux.md). Never a right or a host. */
    fun more(c: Context, details: CharSequence) = column(c).apply {
        val link = text(c, "More", 18f, 500, SOFT).apply {
            setPadding(0, px(c, 10), px(c, 24), px(c, 10)); isClickable = true
        }
        val body = text(c, details, 17f, 400, SOFT).apply { visibility = View.GONE; setPadding(0, px(c, 4), 0, 0) }
        link.setOnClickListener { link.visibility = View.GONE; body.visibility = View.VISIBLE }
        addView(link, LinearLayout.LayoutParams(-2, -2)); addView(body, LinearLayout.LayoutParams(-1, -2))
    }

    /**
     * What something may do, as a list a parent can scan: a small icon for each kind and a few words. [items] are
     * (kind, words); the kinds are [ICONS]' keys, anything else gets a plain dot. Always shown in full, never behind More.
     */
    fun rights(c: Context, items: List<Pair<String, String>>) = column(c, 12).apply {
        for ((kind, words) in items) addView(row(c, 16).apply {
            gravity = Gravity.TOP
            addView(icon(c, kind, 26), LinearLayout.LayoutParams(px(c, 26), px(c, 26)).apply { topMargin = px(c, 1) })
            addView(text(c, words, BODY, 400, INK), LinearLayout.LayoutParams(0, -2, 1f))
        })
    }

    /** Line icons (24 u, stroked in the ink) for the kinds of right a card lists. */
    val ICONS = mapOf(
        "data" to "<svg viewBox='0 0 24 24' fill='none' stroke='#2A2826' stroke-width='1.8'><rect x='4' y='4' width='16' height='16' rx='3'/><path d='M8 9h8M8 13h8M8 17h5'/></svg>",
        "web" to "<svg viewBox='0 0 24 24' fill='none' stroke='#2A2826' stroke-width='1.8'><circle cx='12' cy='12' r='8.5'/><path d='M3.5 12h17M12 3.5c2.6 2.6 3.6 5.4 3.6 8.5s-1 5.9-3.6 8.5M12 3.5C9.4 6.1 8.4 8.9 8.4 12s1 5.9 3.6 8.5'/></svg>",
        "offline" to "<svg viewBox='0 0 24 24' fill='none' stroke='#2A2826' stroke-width='1.8'><circle cx='12' cy='12' r='8.5'/><path d='M6 18L18 6'/></svg>",
        "voice" to "<svg viewBox='0 0 24 24' fill='none' stroke='#2A2826' stroke-width='1.8'><rect x='9' y='3.5' width='6' height='11' rx='3'/><path d='M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5'/></svg>",
        "watch" to "<svg viewBox='0 0 24 24' fill='none' stroke='#2A2826' stroke-width='1.8'><path d='M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z'/><circle cx='12' cy='12' r='2.8'/></svg>",
        "background" to "<svg viewBox='0 0 24 24' fill='none' stroke='#2A2826' stroke-width='1.8'><circle cx='12' cy='12' r='8.5'/><path d='M12 7.5V12l3 2'/></svg>",
        "tv" to "<svg viewBox='0 0 24 24' fill='none' stroke='#2A2826' stroke-width='1.8'><rect x='3' y='5' width='18' height='12' rx='2'/><path d='M8.5 20.5h7'/></svg>",
        "look" to "<svg viewBox='0 0 24 24' fill='none' stroke='#2A2826' stroke-width='1.8'><path d='M12 3.5a8.5 8.5 0 1 0 0 17c1.2 0 1.8-.8 1.8-1.7 0-1.3-1.2-1.6-1.2-2.8 0-1 .8-1.6 1.8-1.6h2.2a3.9 3.9 0 0 0 3.9-3.9C20.5 6.8 16.7 3.5 12 3.5z'/><circle cx='7.8' cy='11' r='1'/><circle cx='11' cy='7.5' r='1'/><circle cx='15.3' cy='8.4' r='1'/></svg>",
        "tabs" to "<svg viewBox='0 0 24 24' fill='none' stroke='#2A2826' stroke-width='1.8'><rect x='3.5' y='4.5' width='17' height='15' rx='2.5'/><path d='M9 4.5v15'/></svg>",
        "devices" to "<svg viewBox='0 0 24 24' fill='none' stroke='#2A2826' stroke-width='1.8'><rect x='6' y='3' width='12' height='18' rx='2.5'/><circle cx='12' cy='14' r='3'/><path d='M12 6.8v.4'/></svg>",
        "cloud" to "<svg viewBox='0 0 24 24' fill='none' stroke='#2A2826' stroke-width='1.8'><path d='M7 18.5h10a4 4 0 0 0 .6-8 6 6 0 0 0-11.5 1.6A3.3 3.3 0 0 0 7 18.5z'/></svg>",
        "apps" to "<svg viewBox='0 0 24 24' fill='none' stroke='#2A2826' stroke-width='1.8'><rect x='4' y='4' width='6.5' height='6.5' rx='1.6'/><rect x='13.5' y='4' width='6.5' height='6.5' rx='1.6'/><rect x='4' y='13.5' width='6.5' height='6.5' rx='1.6'/><rect x='13.5' y='13.5' width='6.5' height='6.5' rx='1.6'/></svg>",
        "from" to "<svg viewBox='0 0 24 24' fill='none' stroke='#2A2826' stroke-width='1.8'><path d='M12 3.5l7 3v5.2c0 4.3-3 7.5-7 8.8-4-1.3-7-4.5-7-8.8V6.5z'/></svg>",
        "new" to "<svg viewBox='0 0 24 24' fill='none' stroke='#A8321E' stroke-width='2'><path d='M12 5v14M5 12h14'/></svg>",
    )
    private const val DOT = "<svg viewBox='0 0 24 24'><circle cx='12' cy='12' r='3' fill='#6E6A65'/></svg>"

    /** One of [ICONS] as a view, [size] u square. */
    fun icon(c: Context, kind: String, size: Number = 26): View {
        val svg = SvgIcon.parse(ICONS[kind] ?: DOT)
        return object : View(c) {
            override fun onDraw(canvas: android.graphics.Canvas) { svg?.draw(canvas, 0f, 0f, minOf(width, height).toFloat()) }
        }.apply { minimumWidth = px(c, size); minimumHeight = px(c, size) }
    }
    /** The name, as the first screens show it in their corner (until there's a logo). */
    fun wordmark(c: Context) = text(c, "OpenHouse", 22f, 600)

    /** A ScrollView no taller than [maxPx]. */
    class Capped(c: Context, private val maxPx: Int) : ScrollView(c) {
        override fun onMeasure(w: Int, h: Int) {
            val size = View.MeasureSpec.getSize(h)
            super.onMeasure(w, View.MeasureSpec.makeMeasureSpec(if (size in 1 until maxPx) size else maxPx, View.MeasureSpec.AT_MOST))
        }
    }
}

/** Compose type in the shared look: Inter, ink, the shared scale. */
@Composable fun calmText(size: Number, weight: FontWeight = FontWeight.Normal, color: Color = Calm.ink, lineHeight: Float = 1.35f): TextStyle =
    quietText(size, weight, color, lineHeight)

/**
 * The one dialog: a sheet with a title, a line of text, any view, a list of rows, and its buttons (the main one in
 * ink, the rest quiet words). It stands in for Android's AlertDialog everywhere the shell asks something, and takes
 * the same calls, so `AlertDialog.Builder(a)` becomes `CalmDialog(a)`.
 */
class CalmDialog(private val c: Context) {
    /** A row in a list: a [title], an optional [detail] line; a [header] is a section label, not a choice. */
    data class Row(val title: CharSequence, val detail: CharSequence? = null, val header: Boolean = false, val image: android.graphics.Bitmap? = null, val value: CharSequence? = null)

    private var title: CharSequence? = null
    private var message: CharSequence? = null
    private var view: View? = null
    private var rows: List<Row>? = null
    private var checked = -1
    private var onRow: ((DialogInterface, Int) -> Unit)? = null
    private var positive: Pair<CharSequence, ((DialogInterface, Int) -> Unit)?>? = null
    private var negative: Pair<CharSequence, ((DialogInterface, Int) -> Unit)?>? = null
    private var neutral: Pair<CharSequence, ((DialogInterface, Int) -> Unit)?>? = null
    private var cancelable = true
    private var onDismiss: ((DialogInterface) -> Unit)? = null
    private var widthU = 760f
    private var messageView: TextView? = null
    private var more: CharSequence? = null
    private var rights: List<Pair<String, String>>? = null
    private var danger = false

    fun setTitle(t: CharSequence?) = apply { title = t }
    fun setMessage(t: CharSequence?) = apply { message = t }
    fun setView(v: View) = apply { view = v }
    fun setWidth(u: Float) = apply { widthU = u }
    /** Details that don't change the decision, behind a "More" (docs/ux.md). */
    fun setMore(t: CharSequence?) = apply { more = t?.takeIf { it.isNotBlank() } }
    /** What it may do, as a scannable list of (kind, words) ([Calm.rights]). Always shown. */
    fun setRights(r: List<Pair<String, String>>) = apply { rights = r.takeIf { it.isNotEmpty() } }
    /** The main button deletes or replaces something for good: it's red. */
    fun setDanger() = apply { danger = true }
    fun setPositiveButton(t: CharSequence, l: ((DialogInterface, Int) -> Unit)?) = apply { positive = t to l }
    fun setNegativeButton(t: CharSequence, l: ((DialogInterface, Int) -> Unit)?) = apply { negative = t to l }
    fun setNeutralButton(t: CharSequence, l: ((DialogInterface, Int) -> Unit)?) = apply { neutral = t to l }
    fun setCancelable(b: Boolean) = apply { cancelable = b }
    fun setOnDismissListener(l: (DialogInterface) -> Unit) = apply { onDismiss = l }
    /** Rows that each close the dialog and call [l] with their index. */
    fun setItems(items: Array<out CharSequence>, l: (DialogInterface, Int) -> Unit) = apply { rows = items.map { Row(it) }; onRow = l }
    /** Rows with a detail line and section labels; [l] gets the index into [items]. */
    fun setRows(items: List<Row>, l: (DialogInterface, Int) -> Unit) = apply { rows = items; onRow = l }
    /** Rows with the [checked] one marked; [l] decides whether to close. */
    fun setSingleChoiceItems(items: Array<out CharSequence>, checked: Int, l: (DialogInterface, Int) -> Unit) =
        apply { rows = items.map { Row(it) }; this.checked = checked; onRow = l }

    /** Change the line under the title of a dialog that's showing (one made with a message). */
    fun updateMessage(t: CharSequence) { messageView?.text = t }

    fun show(): Dialog {
        val d = Dialog(c)
        d.requestWindowFeature(android.view.Window.FEATURE_NO_TITLE)
        val u = Calm.u(c)
        val screenH = c.resources.displayMetrics.let { minOf(it.widthPixels, it.heightPixels) }
        val card = Calm.column(c).apply {
            background = Calm.rounded(Calm.SHEET, Calm.R_SHEET * u); elevation = 10 * u
            setPadding(Calm.px(c, 44), Calm.px(c, 40), Calm.px(c, 44), Calm.px(c, 28))
        }
        title?.let { card.addView(Calm.title(c, it)) }
        message?.let { card.addView(Calm.text(c, it, Calm.BODY, 400, Calm.SOFT).apply { setPadding(0, Calm.px(c, if (title != null) 12 else 0), 0, 0) }.also { v -> messageView = v }) }
        rights?.let { r -> card.addView(Calm.Capped(c, (screenH * .42f).toInt()).apply { addView(Calm.rights(c, r)); isVerticalScrollBarEnabled = false },
            LinearLayout.LayoutParams(-1, -2).apply { topMargin = Calm.px(c, 22) }) }
        view?.let { v ->
            (v.parent as? ViewGroup)?.removeView(v)
            card.addView(v, LinearLayout.LayoutParams(-1, -2).apply { topMargin = Calm.px(c, 24) })
        }
        rows?.let { list ->
            val col = Calm.column(c)
            list.forEachIndexed { i, r ->
                if (r.header) {
                    col.addView(Calm.eyebrow(c, r.title).apply { setPadding(Calm.px(c, 16), Calm.px(c, if (i == 0) 4 else 28), 0, Calm.px(c, 8)) })
                    return@forEachIndexed
                }
                val line = Calm.row(c).apply {
                    val rr = 16 * u
                    background = Calm.pressable(c, Calm.rounded(0x00FFFFFF, rr), rr); isClickable = true
                    minimumHeight = Calm.px(c, 72); setPadding(Calm.px(c, 16), Calm.px(c, 14), Calm.px(c, 16), Calm.px(c, 14))
                    r.image?.let { b -> // a picture (a plugin's preview), rounded, before the words
                        addView(android.widget.ImageView(c).apply {
                            setImageBitmap(b); scaleType = android.widget.ImageView.ScaleType.CENTER_CROP
                            clipToOutline = true; background = Calm.rounded(Calm.TINT2, 12 * u)
                        }, LinearLayout.LayoutParams(Calm.px(c, 112), Calm.px(c, 76)).apply { rightMargin = Calm.px(c, 20) })
                    }
                    addView(Calm.column(c, 4).apply {
                        addView(Calm.text(c, r.title, 22f, 500))
                        r.detail?.let { addView(Calm.text(c, it, 17f, 400, Calm.SOFT)) }
                    }, LinearLayout.LayoutParams(0, -2, 1f))
                    r.value?.let { addView(Calm.text(c, it, 19f, 400, Calm.SOFT), LinearLayout.LayoutParams(-2, -2).apply { leftMargin = Calm.px(c, 16) }) }
                    if (checked >= 0) addView(View(c).apply {
                        background = if (i == checked) GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Calm.INK) }
                            else GradientDrawable().apply { shape = GradientDrawable.OVAL; setStroke(Calm.px(c, 2), Calm.TINT2) }
                    }, LinearLayout.LayoutParams(Calm.px(c, 18), Calm.px(c, 18)).apply { leftMargin = Calm.px(c, 16) })
                    setOnClickListener { if (checked < 0) d.dismiss(); onRow?.invoke(d, i) }
                }
                col.addView(line, LinearLayout.LayoutParams(-1, -2))
            }
            card.addView(Calm.Capped(c, (screenH * .62f).toInt()).apply { addView(col); isVerticalScrollBarEnabled = false },
                LinearLayout.LayoutParams(-1, -2).apply { topMargin = Calm.px(c, 18); leftMargin = -Calm.px(c, 16); rightMargin = -Calm.px(c, 16) })
        }
        more?.let { card.addView(Calm.more(c, it), LinearLayout.LayoutParams(-1, -2).apply { topMargin = Calm.px(c, 8) }) }
        if (positive != null || negative != null || neutral != null) {
            val bar = Calm.row(c, 8).apply { setPadding(0, Calm.px(c, 28), 0, 0) }
            fun act(p: Pair<CharSequence, ((DialogInterface, Int) -> Unit)?>, which: Int) { d.dismiss(); p.second?.invoke(d, which) }
            neutral?.let { n -> bar.addView(Calm.quiet(c, n.first) { act(n, DialogInterface.BUTTON_NEUTRAL) }.apply { setPadding(Calm.px(c, 4), 0, Calm.px(c, 20), 0) }) }
            bar.addView(View(c), LinearLayout.LayoutParams(0, 1, 1f))
            negative?.let { n -> bar.addView(Calm.quiet(c, n.first) { act(n, DialogInterface.BUTTON_NEGATIVE) }) }
            positive?.let { p -> bar.addView((if (danger) Calm::danger else Calm::primary)(c, p.first) { act(p, DialogInterface.BUTTON_POSITIVE) }) }
            card.addView(bar, LinearLayout.LayoutParams(-1, -2))
        } else card.setPadding(card.paddingLeft, card.paddingTop, card.paddingRight, Calm.px(c, 40))

        val holder = FrameLayout(c).apply { addView(card, FrameLayout.LayoutParams(Calm.px(c, widthU), -2, Gravity.CENTER)) }
        d.setContentView(holder)
        d.setCancelable(cancelable)
        if (cancelable) dev.openhouse.shell.addEdgeBack(holder) { d.cancel() } // the tablet hides the system's back: swipe in from an edge
        d.setOnDismissListener { onDismiss?.invoke(it); Openhouse.settingsChanged() } // Settings, under it, reads its values again
        d.window?.apply {
            setBackgroundDrawable(ColorDrawable(0))
            setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.WRAP_CONTENT)
            setDimAmount(.3f)
            if (view?.let { hasField(it) } == true) setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_VISIBLE or WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        }
        d.show()
        d.window?.insetsController?.hide(WindowInsets.Type.systemBars()) // the tablet stays full screen
        view?.let { firstField(it)?.requestFocus() }
        return d
    }

    private fun hasField(v: View): Boolean = firstField(v) != null
    private fun firstField(v: View): EditText? = when (v) {
        is EditText -> v
        is ViewGroup -> (0 until v.childCount).firstNotNullOfOrNull { firstField(v.getChildAt(it)) }
        else -> null
    }
}
