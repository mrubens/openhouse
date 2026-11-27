package dev.openhouse.ui

// The pages in Settings' right pane (docs/settings.md). While Settings is open, a CalmDialog that is a list, a form or
// a step of a menu shows here instead of over the screen (CalmDialog.showPage), so nothing stacks: a page that opens
// another replaces it, and ‹ (its Back or Cancel) goes up. Confirmations, a person's cards and the PIN pad still float.

import android.app.Dialog
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.view.View
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

object SettingsPages {
    /** Settings is open: dialogs that are pages go in its pane. */
    val active: Boolean get() = Openhouse.showSettings

    internal val stack = mutableStateListOf<PageDialog>()
    /** The page just closed, still shown for a moment, so going from one page to the next (close, then open) doesn't
     *  flash the tab's own rows, nor while a question asked from it is up. */
    internal var lingering by mutableStateOf<PageDialog?>(null)
    val top: PageDialog? get() = stack.lastOrNull() ?: lingering

    /** The chosen tab is itself a page of the shell's (Calendars, Account, Advanced): [reopen] opens it again. */
    internal var rootIsPage = false
    internal var reopen: (() -> Unit)? = null
    private var expectRoot = false
    /** A tab's own page is wanted next: whatever its row opens is that page, even a line with no list. */
    internal val wantsRoot: Boolean get() = expectRoot
    private var rootTitle: String? = null
    /** Real dialogs showing over Settings (a question, the PIN pad): while one is, the page under it stays. */
    internal var dialogs by mutableStateOf(0)

    /** A tab was chosen (or its page is to be opened again): the next page is its own. */
    internal fun openRoot(page: (() -> Unit)?) {
        rootIsPage = page != null; reopen = page; rootTitle = null
        expectRoot = page != null
        page?.invoke()
    }

    /** Settings closed, or another tab was chosen: every page goes (their own dismiss listeners run). */
    fun clear() {
        val all = stack.toList()
        stack.clear(); lingering = null
        all.forEach { it.gone() }
    }

    private val main = Handler(Looper.getMainLooper())
    private fun linger(p: PageDialog) { lingering = p; main.postDelayed(::settle, if (rootIsPage) 600 else 200) }
    private fun settle() {
        if (lingering == null || stack.isNotEmpty()) return
        if (dialogs > 0) { main.postDelayed(::settle, 300); return }
        lingering = null
        if (rootIsPage && active) { expectRoot = true; reopen?.invoke() }
    }

    /** A page that acts like the Dialog its menu expects: show() puts it in the pane, dismiss() takes it out. */
    class PageDialog(c: Context, val title: String, val content: View, private val back: (() -> Unit)?, private val onDismiss: (PageDialog) -> Unit) : Dialog(c) {
        /** The tab's own page (Advanced, Account…): nothing to go back to, inside the tab. */
        var root = false; private set
        val canBack: Boolean get() = !root

        /** ‹: up one level (its Back or Cancel, or the tab's own page). */
        fun goBack() {
            dismiss()
            if (back != null) back.invoke()
            else if (rootIsPage && stack.isEmpty()) { lingering = null; expectRoot = true; reopen?.invoke() }
        }

        override fun show() {
            root = rootIsPage && (expectRoot || title == rootTitle)
            if (root && expectRoot) { rootTitle = title; expectRoot = false }
            lingering = null
            // The tab's own page shown again (after a change, or by its Back) replaces the one before, never stacks on it.
            if (root) stack.filter { it.root && it !== this }.forEach { stack.remove(it); it.gone() }
            stack.remove(this); stack.add(this)
        }
        override fun dismiss() {
            if (!stack.remove(this)) return
            gone()
            if (stack.isEmpty()) linger(this)
        }
        internal fun gone() { onDismiss(this); Openhouse.settingsChanged() }
        override fun cancel() = dismiss()
        override fun isShowing() = this in stack
    }
}
