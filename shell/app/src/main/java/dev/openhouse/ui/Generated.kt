package dev.openhouse.ui

import android.graphics.BitmapFactory
import android.util.LruCache
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.URL

private val pal: Palette @Composable @androidx.compose.runtime.ReadOnlyComposable get() = LocalPalette.current

/** What generated UI can do. The board (or conversation) provides these. */
interface AnswerActions {
    fun ask(text: String) {}
    fun startTimer(label: String, seconds: Int) {}
    fun makeApp(request: String) {}
    fun playVideo(url: String, title: String) {}
}
val LocalAnswerActions = staticCompositionLocalOf<AnswerActions> { object : AnswerActions {} }

/** Where an answer is shown: "door" (a note that fits its space) or "full" (up close, full screen, or in the conversation). Elements with `show` appear in only one. */
val LocalView = staticCompositionLocalOf { "full" }
/** Whether there is room to lay an answer out in two columns (a note opened full screen). */
val LocalTwoColumns = staticCompositionLocalOf { false }

/** An answer as prose + native UI. `prose = false` shows only the UI (board cards). */
@Composable
fun AnswerView(text: String, done: Boolean = true, prose: Boolean = true, modifier: Modifier = Modifier) {
    val segs = remember(text) { Answers.segments(text) }
    Column(modifier, verticalArrangement = Arrangement.spacedBy(16.u)) {
        for (s in segs) when (s) {
            is Segment.Prose -> if (prose) Prose(s.text)
            is Segment.Ui -> SpecView(s.src, done || s.done)
        }
    }
}

@Composable
fun SpecView(src: String, done: Boolean) {
    val spec = remember(src, done) { Answers.compile(src, done) }
    if (spec == null) { if (!done) Text("Building the answer…", style = ohText(18, color = pal.muted)); return }
    val root = spec.elements[spec.root]
    // Up close (a note opened full screen) there's width to spare: the answer's parts go in two
    // columns, what you look at on the left (pictures, overview, numbers, video) and what you work
    // through on the right (lists, steps), instead of one tall column that has to shrink.
    if (LocalView.current == "full" && LocalTwoColumns.current && root != null && root.type in setOf("Stack", "Note") && root.props.optString("direction") != "horizontal" && root.children.size >= 3) {
        val work = setOf("Checklist", "Steps", "List", "Suggestions")
        val kids = root.children.mapNotNull { spec.elements[it] }.filter { it.show == null || it.show == "full" }
        val (right, left) = kids.partition { it.type in work || (it.type == "Card" && it.children.any { c -> spec.elements[c]?.type in work }) }
        if (left.isNotEmpty() && right.isNotEmpty()) {
            Row(horizontalArrangement = Arrangement.spacedBy(36.u)) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(16.u)) { left.forEach { Node(spec, it.id) } }
                Column(Modifier.weight(1.15f), verticalArrangement = Arrangement.spacedBy(16.u)) { right.forEach { Node(spec, it.id) } }
            }
            return
        }
    }
    Box(Modifier.animateContentSize()) { Node(spec, spec.root) }
}

// --- prose: **bold**, *italic*, "- " bullets, [links](url) shown as their text ---------------

fun markdown(text: String): AnnotatedString = buildAnnotatedString {
    val lines = text.replace(Regex("\\[([^\\]]+)\\]\\((https?:[^)]+)\\)"), "$1").split('\n')
    lines.forEachIndexed { i, raw ->
        val line = raw.replace(Regex("^[-•] "), "•  ")
        val re = Regex("\\*\\*(.+?)\\*\\*|(?<![*\\w])\\*(?!\\s)(.+?)\\*(?![*\\w])")
        var at = 0
        for (m in re.findAll(line)) {
            append(line.substring(at, m.range.first))
            if (m.groupValues[1].isNotEmpty()) withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(m.groupValues[1]) }
            else withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { append(m.groupValues[2]) }
            at = m.range.last + 1
        }
        append(line.substring(at))
        if (i < lines.size - 1) append('\n')
    }
}

@Composable fun Prose(text: String, size: Int = 22) = Text(markdown(text), style = ohText(size, lineHeight = 1.45f))

// --- components ---------------------------------------------------------------------------

private fun JSONObject.str(k: String) = optString(k).takeIf { has(k) && !isNull(k) && it.isNotEmpty() }
private fun JSONObject.strings(k: String) = optJSONArray(k)?.let { a -> (0 until a.length()).map { a.optString(it) } } ?: emptyList()

@Composable
private fun Node(spec: Spec, id: String) {
    val e = spec.elements[id] ?: return
    if (e.show != null && e.show != LocalView.current) return
    val p = e.props
    val kids: @Composable () -> Unit = { e.children.forEach { Node(spec, it) } }
    when (e.type) {
        "Note" -> Column(verticalArrangement = Arrangement.spacedBy(16.u)) { kids() }
        "Stack" -> {
            val gap = when (p.str("gap")) { "small" -> 8; "large" -> 26; else -> 16 }.u
            if (p.str("direction") == "horizontal") {
                @OptIn(ExperimentalLayoutApi::class)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(gap), verticalArrangement = Arrangement.spacedBy(gap), maxItemsInEachRow = 4) {
                    e.children.forEach { Box(Modifier.weight(1f).widthIn(min = 200.u)) { Node(spec, it) } }
                }
            } else Column(verticalArrangement = Arrangement.spacedBy(gap)) { kids() }
        }
        "Card" -> Panel {
            p.str("title")?.let { Text(it, style = ohText(24, FontWeight.SemiBold)) }
            p.str("subtitle")?.let { Text(it, style = ohText(18, color = pal.muted)) }
            kids()
        }
        "Heading" -> Text(p.optString("text"), style = ohText(when (p.str("level")) { "1" -> 36; "3" -> 23; else -> 28 }, FontWeight.SemiBold))
        "Text" -> Text(markdown(p.optString("text")), style = when (p.str("tone")) {
            "muted" -> ohText(21, color = pal.muted, lineHeight = 1.45f); "large" -> ohText(26, lineHeight = 1.4f); else -> ohText(21, lineHeight = 1.45f)
        })
        "List" -> Column(verticalArrangement = Arrangement.spacedBy(6.u)) {
            p.strings("items").forEachIndexed { i, s ->
                Row { Text(if (p.optBoolean("ordered")) "${i + 1}." else "•", style = ohText(21, color = pal.muted), modifier = Modifier.width(34.u)); Text(markdown(s), style = ohText(21, lineHeight = 1.45f)) }
            }
        }
        "Checklist" -> Checklist(p.str("title"), p.strings("items"))
        "Steps" -> Steps(p.str("title"), p.optJSONArray("steps")?.let { a -> (0 until a.length()).mapNotNull { a.optJSONObject(it) } } ?: emptyList())
        "Timer" -> TimerButton(p.optString("label", "Timer"), p.optInt("seconds", 60))
        "Video" -> VideoCard(p.optString("url"), p.optString("title"), p.str("channel"), p.str("why"))
        "Image" -> Column(verticalArrangement = Arrangement.spacedBy(8.u)) {
            // In a note, a picture takes at most ~40% of the note's height, so the words still fit.
            val fit = LocalFitHeight.current
            // A photo fills its space; a picture the assistant drew (often with words in it) is shown whole.
            val drawn = p.optString("url").startsWith("data:")
            if (fit != null) RemoteImage(p.optString("url"), Modifier.fillMaxWidth().height(minOf(420.u, fit * (if (drawn) 0.6f else 0.4f))).clip(RoundedCornerShape(16.u)), if (drawn) ContentScale.Fit else ContentScale.Crop)
            else RemoteImage(p.optString("url"), Modifier.heightIn(max = 420.u).clip(RoundedCornerShape(16.u)), ContentScale.Fit)
            p.str("caption")?.let { Text(it, style = ohText(17, color = pal.muted)) }
        }
        "Tip" -> Row(Modifier.fillMaxWidth().background(if (p.str("tone") == "warning") pal.warnBg else pal.tipBg, RoundedCornerShape(18.u)).padding(horizontal = 22.u, vertical = 16.u)) {
            Text(markdown(p.optString("text")), style = ohText(20, lineHeight = 1.4f))
        }
        "Stat" -> Panel(padding = PaddingValues(horizontal = 22.u, vertical = 16.u), gap = 4) {
            Text(p.optString("label"), style = ohText(16, color = pal.muted)); Text(p.optString("value"), style = ohText(28, FontWeight.SemiBold, lineHeight = 1.2f))
        }
        "Button" -> {
            val actions = LocalAnswerActions.current
            val primary = p.str("style") != "secondary"
            Pill(p.optString("label"), primary) { e.on?.optJSONObject("press")?.let { run(actions, it) } }
        }
        "Suggestions" -> {
            val actions = LocalAnswerActions.current
            @OptIn(ExperimentalLayoutApi::class)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(10.u), verticalArrangement = Arrangement.spacedBy(10.u)) {
                p.strings("items").forEach { s -> Chip(s) { actions.ask(s) } }
            }
        }
        else -> kids()
    }
}

private fun run(a: AnswerActions, binding: JSONObject) {
    val params = binding.optJSONObject("params") ?: JSONObject()
    when (binding.optString("action")) {
        "ask" -> params.optString("text").takeIf { it.isNotBlank() }?.let { a.ask(it) }
        "startTimer" -> a.startTimer(params.optString("label", "Timer"), params.optInt("seconds", 60))
        "makeApp" -> a.makeApp(params.optString("request", "Make an app from this"))
    }
}

@Composable
fun Panel(modifier: Modifier = Modifier, padding: PaddingValues = PaddingValues(horizontal = 26.u, vertical = 22.u), gap: Int = 14, content: @Composable ColumnScope.() -> Unit) {
    Column(
        modifier.fillMaxWidth().clip(RoundedCornerShape(22.u)).background(pal.card).border(1.u, pal.line, RoundedCornerShape(22.u)).padding(padding),
        verticalArrangement = Arrangement.spacedBy(gap.u), content = content,
    )
}

@Composable
fun Pill(label: String, primary: Boolean = true, enabled: Boolean = true, onClick: () -> Unit) {
    Box(
        Modifier.height(62.u).clip(RoundedCornerShape(31.u)).background(if (primary) pal.accent else pal.line)
            .clickable(enabled = enabled, onClick = onClick).padding(horizontal = 34.u),
        contentAlignment = Alignment.Center,
    ) { Text(label, style = ohText(21, FontWeight.SemiBold, if (primary) pal.accentInk else pal.text).let { if (enabled) it else it.copy(color = it.color.copy(alpha = .35f)) }) }
}

@Composable
fun Chip(label: String, modifier: Modifier = Modifier, selected: Boolean = false, onClick: () -> Unit) {
    Box(
        modifier.clip(RoundedCornerShape(999.u)).background(if (selected) pal.accent else pal.card).border(1.u, if (selected) pal.accent else pal.line, RoundedCornerShape(999.u)).clickable(onClick = onClick).padding(horizontal = 20.u, vertical = 12.u),
    ) { Text(label, style = ohText(18, if (selected) FontWeight.SemiBold else FontWeight.Normal, if (selected) pal.accentInk else pal.text)) }
}

/**
 * Where you are in an answer's steps and what you've ticked, kept outside the composition: the same
 * answer on the home screen, up close, or re-laid-out to fit shares one place in the recipe.
 */
/** The height of the note an answer is fitted into (FitToBox), so pictures can take a share of it. */
val LocalFitHeight = staticCompositionLocalOf<androidx.compose.ui.unit.Dp?> { null }

object SpecMemory {
    val step = androidx.compose.runtime.mutableStateMapOf<Int, Int>()
    val ticks = androidx.compose.runtime.mutableStateMapOf<Int, Set<Int>>()
}

/**
 * Fits its content into the space it's given, like a note on the home screen: no scrolling. Too tall at
 * full size, everything is laid out again a little smaller (down to [minScale]), so text reflows
 * instead of being cut off. Content should still be written to fit; this absorbs the last bit.
 */
@Composable
fun FitToBox(modifier: Modifier = Modifier, minScale: Float = 0.62f, content: @Composable () -> Unit) {
    val u = LocalU.current
    androidx.compose.ui.layout.SubcomposeLayout(modifier.clipToBounds()) { c ->
        val loose = c.copy(minHeight = 0, maxHeight = androidx.compose.ui.unit.Constraints.Infinity)
        val maxH = if (c.hasBoundedHeight) c.maxHeight else Int.MAX_VALUE
        val fitH = if (c.hasBoundedHeight) maxH.toDp() else null
        fun measure(n: Int, sc: Float) = subcompose("fit$n") { CompositionLocalProvider(LocalU provides u * sc, LocalFitHeight provides fitH) { content() } }.map { it.measure(loose) }
        var sc = 1f; var n = 0
        var ps = measure(0, sc)
        while ((ps.maxOfOrNull { it.height } ?: 0) > maxH && sc > minScale && n < 4) {
            val h = ps.maxOf { it.height }
            sc = maxOf(minScale, sc * kotlin.math.sqrt(maxH.toFloat() / h) * .97f); n++
            ps = measure(n, sc)
        }
        val w = if (c.hasBoundedWidth) c.maxWidth else (ps.maxOfOrNull { it.width } ?: 0)
        layout(w, minOf(ps.maxOfOrNull { it.height } ?: 0, maxH)) { ps.forEach { it.place(0, 0) } }
    }
}

@Composable
private fun Checklist(title: String?, items: List<String>) {
    val key = (title + items.joinToString("\u0000")).hashCode()
    val on = SpecMemory.ticks[key] ?: emptySet()
    Column(verticalArrangement = Arrangement.spacedBy(6.u)) {
        title?.let { Text(it, style = ohText(24, FontWeight.SemiBold)) }
        items.forEachIndexed { i, s ->
            val checked = i in on
            Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.u)).clickable { SpecMemory.ticks[key] = if (checked) on - i else on + i }.padding(horizontal = 6.u, vertical = 10.u),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.u)) {
                Box(Modifier.size(34.u).clip(RoundedCornerShape(10.u)).background(if (checked) pal.ok else Color.Transparent)
                    .border(2.u, if (checked) pal.ok else pal.muted, RoundedCornerShape(10.u)), contentAlignment = Alignment.Center) {
                    if (checked) Icon(Icons.Default.Check, null, tint = pal.accentInk, modifier = Modifier.size(24.u))
                }
                Text(markdown(s), style = ohText(21, color = if (checked) pal.muted else pal.text).copy(textDecoration = if (checked) TextDecoration.LineThrough else null))
            }
        }
    }
}

@Composable
private fun Steps(title: String?, steps: List<JSONObject>) {
    if (steps.isEmpty()) return
    val key = steps.joinToString("\u0000") { it.optString("text") }.hashCode()
    val i = (SpecMemory.step[key] ?: 0).coerceIn(0, steps.size - 1)
    fun go(k: Int) { SpecMemory.step[key] = k.coerceIn(0, steps.size - 1) }
    val s = steps[i]
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(22.u)).background(pal.card).border(1.u, pal.line, RoundedCornerShape(22.u)).padding(horizontal = 30.u, vertical = 24.u),
        verticalArrangement = Arrangement.spacedBy(18.u)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text("${title?.let { "$it · " } ?: ""}Step ${i + 1} of ${steps.size}", style = ohText(18, color = pal.muted), modifier = Modifier.weight(1f))
            Row(horizontalArrangement = Arrangement.spacedBy(6.u)) {
                steps.indices.forEach { k ->
                    val w by animateDpAsState(if (k == i) 30.u else 14.u, label = "pip")
                    Box(Modifier.size(w, 14.u).clip(CircleShape).background(if (k == i) pal.accent else if (k < i) pal.muted else pal.line))
                }
            }
        }
        AnimatedContent(i, transitionSpec = { fadeIn() togetherWith fadeOut() }, label = "step") { k ->
            Column(verticalArrangement = Arrangement.spacedBy(14.u)) {
                Text(markdown(steps[k].optString("text")), style = ohText(34, FontWeight.Medium))
                // What this step needs, so the note shows only what matters right now.
                val need = steps[k].optJSONArray("need")?.let { a -> (0 until a.length()).map { a.optString(it) }.filter { it.isNotBlank() } } ?: emptyList()
                if (need.isNotEmpty()) @OptIn(ExperimentalLayoutApi::class) FlowRow(horizontalArrangement = Arrangement.spacedBy(8.u), verticalArrangement = Arrangement.spacedBy(8.u)) {
                    need.forEach { n -> Text(n, style = ohText(19, FontWeight.SemiBold), modifier = Modifier.clip(RoundedCornerShape(12.u)).background(pal.card2).border(1.u, pal.line, RoundedCornerShape(12.u)).padding(horizontal = 14.u, vertical = 6.u)) }
                }
            }
        }
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.weight(1f)) {
                if (s.has("timerSeconds") && !s.isNull("timerSeconds")) TimerButton(s.optString("timerLabel").ifEmpty { "Step ${i + 1}" }, s.optInt("timerSeconds"), compact = true)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(12.u)) {
                Pill("Back", primary = false, enabled = i > 0) { go(i - 1) }
                Pill(if (i == steps.size - 1) "Done" else "Next", enabled = i < steps.size - 1) { go(i + 1) }
            }
        }
    }
}

fun durationText(s: Int): String { val m = s / 60; val h = m / 60; return when { h > 0 && m % 60 > 0 -> "$h h ${m % 60} min"; h > 0 -> "$h h"; m > 0 && s % 60 > 0 -> "$m min ${s % 60} s"; m > 0 -> "$m min"; else -> "$s s" } }

@Composable
fun TimerButton(label: String, seconds: Int, compact: Boolean = false) {
    val actions = LocalAnswerActions.current
    var started by remember(label, seconds) { mutableStateOf(false) }
    Row(
        Modifier.clip(RoundedCornerShape(18.u)).background(if (started) pal.timerOnBg else pal.timerBg)
            .border(1.u, if (started) pal.ok else pal.timerLine, RoundedCornerShape(18.u))
            .clickable { actions.startTimer(label, seconds); started = true }
            .padding(start = 16.u, end = 24.u, top = if (compact) 10.u else 12.u, bottom = if (compact) 10.u else 12.u),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.u),
    ) {
        TimerGlyph(Modifier.size(30.u), if (started) pal.ok else pal.accent)
        Column {
            Text(if (started) "Timer started" else "Start ${durationText(seconds)}", style = ohText(20, FontWeight.SemiBold))
            Text(label, style = ohText(16, color = pal.muted))
        }
    }
}

/** A drawn stopwatch (no emoji). */
@Composable fun TimerGlyph(modifier: Modifier, color: Color) {
    androidx.compose.foundation.Canvas(modifier) {
        val sw = size.minDimension * 0.09f
        val r = size.minDimension * 0.38f
        val c = androidx.compose.ui.geometry.Offset(size.width / 2, size.height * 0.56f)
        drawCircle(color, r, c, style = androidx.compose.ui.graphics.drawscope.Stroke(sw))
        drawLine(color, c, androidx.compose.ui.geometry.Offset(c.x, c.y - r * 0.6f), sw, androidx.compose.ui.graphics.StrokeCap.Round)
        drawLine(color, androidx.compose.ui.geometry.Offset(c.x - r * 0.3f, c.y - r - sw * 1.4f), androidx.compose.ui.geometry.Offset(c.x + r * 0.3f, c.y - r - sw * 1.4f), sw, androidx.compose.ui.graphics.StrokeCap.Round)
    }
}

private fun youtubeId(url: String) = Regex("(?:v=|youtu\\.be/|shorts/|embed/)([\\w-]{11})").find(url)?.groupValues?.get(1)

@Composable
private fun VideoCard(url: String, title: String, channel: String?, why: String?) {
    val actions = LocalAnswerActions.current
    val id = youtubeId(url)
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(20.u)).background(pal.card).border(1.u, pal.line, RoundedCornerShape(20.u))
        .clickable { actions.playVideo(url, title) }.padding(12.u), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(18.u)) {
        Box(Modifier.width(260.u).aspectRatio(16f / 9f).clip(RoundedCornerShape(12.u)).background(Color.Black), contentAlignment = Alignment.Center) {
            if (id != null) RemoteImage("https://i.ytimg.com/vi/$id/hqdefault.jpg", Modifier.fillMaxSize(), ContentScale.Crop)
            Box(Modifier.size(64.u).clip(CircleShape).background(Color.Black.copy(alpha = .65f)), contentAlignment = Alignment.Center) {
                Icon(Icons.Default.PlayArrow, "Play", tint = Color.White, modifier = Modifier.size(40.u))
            }
        }
        Column(verticalArrangement = Arrangement.spacedBy(6.u)) {
            Text(title, style = ohText(21, FontWeight.SemiBold))
            channel?.let { Text(it, style = ohText(18, color = pal.muted)) }
            why?.let { Text(it, style = ohText(17, color = pal.muted)) }
        }
    }
}

// --- images from the web, cached ------------------------------------------------------------

private val images = LruCache<String, ImageBitmap>(48)

@Composable
fun RemoteImage(url: String, modifier: Modifier = Modifier, scale: ContentScale = ContentScale.Crop) {
    val img by produceState(images.get(url), url) {
        if (value == null) value = withContext(Dispatchers.IO) {
            runCatching {
                // A picture the assistant drew itself comes inline (data:image/png;base64,...).
                if (url.startsWith("data:image/")) android.util.Base64.decode(url.substringAfter(","), android.util.Base64.DEFAULT).let { b -> BitmapFactory.decodeByteArray(b, 0, b.size) }?.asImageBitmap()
                else BridgeClient.open(url).run { // a picture on the bridge needs its secret
                    connectTimeout = 8000; readTimeout = 15000; setRequestProperty("User-Agent", "openhouse")
                    inputStream.use { BitmapFactory.decodeStream(it) }
                }?.asImageBitmap()?.also { images.put(url, it) }
            }.getOrNull()
        }
    }
    img?.let { Image(it, null, modifier, contentScale = scale) }
}
