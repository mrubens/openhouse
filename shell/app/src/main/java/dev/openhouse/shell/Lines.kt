package dev.openhouse.shell

import android.app.Activity
import android.view.Gravity
import android.view.View
import android.widget.LinearLayout
import android.widget.TextView
import dev.openhouse.ui.Calm

/** A list of rows in sections, built as views: Settings' Connections and the calendars' own list (CalendarAccounts.fill). */
internal class Lines(private val a: Activity) {
    val col: LinearLayout = Calm.column(a)

    /** A section's label, with a quiet [action] at its right (Add). */
    fun header(label: String, action: String? = null, onAction: (() -> Unit)? = null) {
        col.addView(Calm.row(a).apply {
            gravity = Gravity.CENTER_VERTICAL; setPadding(Calm.px(a, 16), Calm.px(a, if (col.childCount == 0) 4 else 28), Calm.px(a, 4), Calm.px(a, 4))
            addView(Calm.eyebrow(a, label), LinearLayout.LayoutParams(0, -2, 1f))
            if (action != null && onAction != null) addView(Calm.quiet(a, action) { onAction() })
        }, LinearLayout.LayoutParams(-1, -2))
    }

    /** A row's second line, soft. */
    fun soft(t: CharSequence): TextView = Calm.text(a, t, 17f, 400, Calm.SOFT)

    /** A row: [title] (after a dot of [tone]), [sub] under it, [value] at its right; [lead] before it (a box), [end]
     *  after it (Sign out, Remove). [tap]: the row itself, when it opens something. */
    fun line(title: CharSequence, sub: TextView? = null, tone: String? = null, lead: View? = null, value: CharSequence? = null, end: View? = null, tap: (() -> Unit)? = null) {
        val row = Calm.row(a).apply { minimumHeight = Calm.px(a, 72); gravity = Gravity.CENTER_VERTICAL }
        if (lead != null) row.addView(lead, LinearLayout.LayoutParams(Calm.px(a, 72), Calm.px(a, 72)))
        row.addView(Calm.row(a, 10).apply {
            gravity = Gravity.CENTER_VERTICAL
            val r = 16 * Calm.u(a)
            if (tap != null) { background = Calm.pressable(a, Calm.rounded(0x00FFFFFF, r), r); isClickable = true; setOnClickListener { tap() } }
            setPadding(Calm.px(a, if (lead != null) 8 else 16), Calm.px(a, 14), Calm.px(a, 16), Calm.px(a, 14))
            addView(Calm.column(a, 4).apply {
                addView(Calm.row(a, 10).apply {
                    gravity = Gravity.CENTER_VERTICAL
                    tone?.takeIf { it.startsWith("#") }?.let { t -> addView(View(a).apply { background = android.graphics.drawable.GradientDrawable().apply { shape = android.graphics.drawable.GradientDrawable.OVAL; setColor(android.graphics.Color.parseColor(t)) } }, LinearLayout.LayoutParams(Calm.px(a, 14), Calm.px(a, 14))) }
                    addView(Calm.text(a, title, 22f, 500))
                })
                sub?.let { addView(it) }
            }, LinearLayout.LayoutParams(0, -2, 1f))
            value?.let { addView(Calm.text(a, it, 18f, 400, Calm.SOFT).apply { maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END; maxWidth = Calm.px(a, 320) }) }
        }, LinearLayout.LayoutParams(0, -2, 1f))
        end?.let { row.addView(it) }
        col.addView(row, LinearLayout.LayoutParams(-1, -2))
    }

    /** A line of soft words in a section with nothing in it yet. */
    fun note(t: CharSequence) {
        col.addView(soft(t).apply { setPadding(Calm.px(a, 16), Calm.px(a, 10), Calm.px(a, 16), Calm.px(a, 10)) }, LinearLayout.LayoutParams(-1, -2))
    }
}
