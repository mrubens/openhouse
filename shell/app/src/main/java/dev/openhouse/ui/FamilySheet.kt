package dev.openhouse.ui

// Setting up the household: who lives here, where, calendars and chores; and the text fields the sheets share.

import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.rememberScrollState

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.*
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow

// --- family setup -------------------------------------------------------------------------------

/** One editable row of two fields (a person and a note, a calendar link and whose it is, a chore). */
private class Pair2(a: String, b: String, c: String = "") { var a by mutableStateOf(a); var b by mutableStateOf(b); var c by mutableStateOf(c) }

/** The colors a person can have (the first six are the order the family is listed in, as /house gives them). */
internal val PERSON_COLORS = listOf("#ffc247", "#56d6a0", "#ff8566", "#74acff", "#c3a0ff", "#ff9ec4", "#5fa3a8", "#c9708f", "#8a9a5b", "#9a8478")
private fun hexColor(h: String) = runCatching { Color(android.graphics.Color.parseColor(h)) }.getOrDefault(Color.Gray)

/**
 * Setting up the household: who lives here, where (for weather), their calendar links and
 * chores. Opens by itself the first time; later from the gear. Saved to the bridge.
 */
@Composable
internal fun FamilySheet() {
    val o = Openhouse
    var loaded by remember { mutableStateOf(false) }
    val people = remember { mutableStateListOf<Pair2>() }
    val chores = remember { mutableStateListOf<Pair2>() }
    var place by remember { mutableStateOf("") }
    LaunchedEffect(Unit) {
        val h = o.loadHousehold()
        if (h != null) {
            h.optJSONArray("family")?.let { a -> for (i in 0 until a.length()) a.optJSONObject(i)?.let { people += Pair2(it.optString("name"), it.optString("note"), it.optString("color").ifBlank { PERSON_COLORS[i % 6] }) } }
            h.optJSONArray("chores")?.let { a -> for (i in 0 until a.length()) a.optJSONObject(i)?.let { chores += Pair2(it.optString("who"), it.optString("task")) } }
            place = h.optString("location")
        }
        if (people.isEmpty()) people += Pair2("", "")
        loaded = true
    }
    fun save() {
        val h = org.json.JSONObject()
            .put("family", org.json.JSONArray(people.filter { it.a.isNotBlank() }.map { org.json.JSONObject().put("name", it.a.trim()).put("note", it.b.trim()).apply { if (it.c.isNotBlank()) put("color", it.c) } }))
            .put("location", place.trim())
            .put("chores", org.json.JSONArray(chores.filter { it.b.isNotBlank() }.map { org.json.JSONObject().put("who", it.a.trim()).put("task", it.b.trim()) }))
        o.saveHousehold(h)
        o.showFamily = false
    }
    val names = people.map { it.a.trim() }.filter { it.isNotEmpty() }
    CompositionLocalProvider(LocalPalette provides quietPalette()) {
        // Above Android's on-screen keyboard when it's up: the card shrinks to what's left (its columns scroll), so the
        // field being typed in and Save stay in sight.
        Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = .3f)).clickable(enabled = false) {}.imePadding().padding(vertical = 20.u), contentAlignment = Alignment.Center) {
            QuietCard(Modifier.width(1380.u).heightIn(max = 880.u).fillMaxHeight(), padding = PaddingValues(horizontal = 44.u, vertical = 30.u)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.u)) {
                    SettingsBack()
                    Column(Modifier.weight(1f)) {
                        Text(if (o.householdSetUp) "Your family" else "Welcome! Who lives here?", style = quietText(30, FontWeight.SemiBold))
                        // Telling Opie instead is a quiet line, not a third button (docs/ux.md).
                        Text("Or just tell Opie", style = quietText(17, FontWeight.Medium, PaperLook.inkSoft),
                            modifier = Modifier.clip(RoundedCornerShape(8.u)).clickable { o.startOnboarding() }.padding(vertical = 4.u))
                    }
                    // The ‹ (opened from Settings) or the edge swipe goes back without saving; otherwise a word for it.
                    if (!Openhouse.showSettings) Chip(if (o.householdSetUp) "Cancel" else "Later") { o.showFamily = false }
                    Pill("Save") { save() }
                }
                Spacer(Modifier.height(16.u))
                if (!loaded) { Dots(); return@QuietCard }
                Row(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(40.u)) {
                    Column(Modifier.weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.u)) {
                        Section("Who lives here")
                        people.forEachIndexed { i, p -> Row(horizontalArrangement = Arrangement.spacedBy(10.u), verticalAlignment = Alignment.CenterVertically) {
                            // Their color everywhere (the calendar, chores): tap for the next one.
                            if (p.c.isBlank()) p.c = PERSON_COLORS[i % 6]
                            Box(Modifier.size(40.u).clip(CircleShape).background(hexColor(p.c)).clickable { p.c = PERSON_COLORS[(PERSON_COLORS.indexOf(p.c) + 1) % PERSON_COLORS.size] })
                            Field(p.a, { p.a = it }, "Name", Modifier.weight(1f)); Field(p.b, { p.b = it }, "Age 9, or Mom", Modifier.weight(1f)); Remove { people.remove(p) } } }
                        if (people.size > 0) Text("Tap a color to change it.", style = quietText(15, color = PaperLook.inkSoft))
                        AddLink("Add someone") { people += Pair2("", "", PERSON_COLORS[people.size % 6]) }
                        Section("Where you live")
                        Field(place, { place = it }, "Zip code or town, for the weather")
                    }
                    Column(Modifier.weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.u)) {
                        Section("Chores")
                        chores.forEach { c -> Row(horizontalArrangement = Arrangement.spacedBy(10.u), verticalAlignment = Alignment.CenterVertically) {
                            Field(c.a, { c.a = it }, "Who", Modifier.width(170.u)); Field(c.b, { c.b = it }, "Feed the cat", Modifier.weight(1f)); Remove { chores.remove(c) } } }
                        AddLink("Add a chore") { chores += Pair2(names.firstOrNull() ?: "", "") }
                    }
                }
            }
        }
    }
}

@Composable private fun Section(t: String) { Text(t, style = quietText(20, FontWeight.SemiBold), modifier = Modifier.padding(top = 10.u)) }

@Composable
internal fun Field(value: String, onChange: (String) -> Unit, hint: String, modifier: Modifier = Modifier.fillMaxWidth(), focus: FocusRequester? = null) {
    Box(modifier.clip(RoundedCornerShape(12.u)).background(Color(0xFFF1EEE6)).border(1.u, Color(0xFFDAD5CA), RoundedCornerShape(12.u)).padding(horizontal = 14.u, vertical = 11.u)) {
        if (value.isEmpty()) Text(hint, style = quietText(18, color = PaperLook.inkSoft.copy(alpha = .6f)), maxLines = 1)
        val cover = coverAttached()
        BasicTextField(value, onChange, Modifier.fillMaxWidth().let { m -> if (focus != null) m.focusRequester(focus) else m }.onPreviewKeyEvent { e -> cover && coverKey(e, value, onChange, null) }, readOnly = cover, singleLine = true, keyboardOptions = NoSuggestions, textStyle = quietText(18), cursorBrush = SolidColor(PaperLook.ink))
    }
}

@Composable private fun Remove(onClick: () -> Unit) {
    Box(Modifier.size(40.u).clip(CircleShape).clickable(onClick = onClick), contentAlignment = Alignment.Center) { Icon(Icons.Default.Close, "Remove", tint = PaperLook.inkSoft, modifier = Modifier.size(20.u)) }
}

@Composable private fun AddLink(t: String, onClick: () -> Unit) {
    Text("+ $t", style = quietText(17, FontWeight.Medium, Color(0xFFB5562F)), modifier = Modifier.clip(RoundedCornerShape(8.u)).clickable(onClick = onClick).padding(vertical = 6.u, horizontal = 4.u))
}

/** No suggestion bar or autocorrect: people type on the keyboard cover, and the bar just gets in the way.
 *  (The password type is what makes keyboards like Samsung's and Gboard hide suggestions; the text still shows.) */
internal val NoSuggestions = KeyboardOptions(keyboardType = androidx.compose.ui.text.input.KeyboardType.Password, autoCorrectEnabled = false)

/** The keyboard cover is attached (its keys type; no on-screen keyboard wanted). */
@Composable
internal fun coverAttached(): Boolean {
    val c = androidx.compose.ui.platform.LocalConfiguration.current
    return c.keyboard == android.content.res.Configuration.KEYBOARD_QWERTY && c.hardKeyboardHidden == android.content.res.Configuration.HARDKEYBOARDHIDDEN_NO
}

/**
 * Typing from the keyboard cover into a field without an input connection: Samsung's keyboard puts its
 * toolbar (a black F1-F6 bar) over the display whenever a field takes keys through it, so with the
 * cover the field is read-only and takes the keys itself: letters, space, backspace, Enter.
 */
internal fun coverKey(e: androidx.compose.ui.input.key.KeyEvent, text: String, onText: (String) -> Unit, onEnter: (() -> Unit)?): Boolean {
    val k = e.nativeKeyEvent
    val down = k.action == android.view.KeyEvent.ACTION_DOWN
    when (k.keyCode) {
        android.view.KeyEvent.KEYCODE_DEL -> { if (down) onText(if (k.isCtrlPressed || k.isAltPressed) text.trimEnd().substringBeforeLast(' ', "") else text.dropLast(1)); return true }
        android.view.KeyEvent.KEYCODE_ENTER, android.view.KeyEvent.KEYCODE_NUMPAD_ENTER -> { if (down) onEnter?.invoke(); return true }
    }
    if (k.isCtrlPressed || k.isMetaPressed) return false
    val ch = k.unicodeChar
    if (ch <= 0) return false
    if (down) onText(text + ch.toChar())
    return true
}
