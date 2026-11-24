package dev.openhouse.ui

// The paper look: the family's things, stuck on. Papers held by magnets or tape, notes in
// handwriting, apps the kids made as die-cut stickers. Shared by the shell's built-in board and the
// board the family's agent edits (import dev.openhouse.ui.*).

import android.content.res.AssetManager
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign

object PaperLook {
    val surface = Color(0xFFD5DBD4)
    val ink = Color(0xFF24282A)
    val inkSoft = Color(0xFF5E6466)
    val paper = Color(0xFFFBF8F0)
    val lines = Color(0xFFC9D6E6)
    val margin = Color(0xFFE9A3A0)
    val sticky = Color(0xFFF7DE79)
    val stickyPink = Color(0xFFF6C5C9)
    val stickyBlue = Color(0xFFBFDDF4)
    val stickyGreen = Color(0xFFCDE9C4)
    val stickyOrange = Color(0xFFF8CFA0)
    val card = Color(0xFFFFFFFF)
    val tile = Color(0xFF2A2D31)
    val tape = Color(0xBFFFF8D6)
    /** Magnet colors (also each person's color on the home screen). */
    val magnets = listOf(Color(0xFFD9543F), Color(0xFF3F74D9), Color(0xFF4FA87A), Color(0xFFE2A93B), Color(0xFF8B5CC9), Color(0xFF2FA3A8))

    /** Handwriting (Caveat) and a rounded sans (Nunito). Bundled with the shell; set at startup. */
    var hand: FontFamily = FontFamily.Cursive; private set
    var round: FontFamily = FontFamily.SansSerif; private set
    /** The home screen's own type (Inter): the assistant's words over it. */
    var quiet: FontFamily = FontFamily.SansSerif; private set
    fun loadFonts(assets: AssetManager) {
        fun family(file: String, vararg weights: Int) = FontFamily(weights.map { w ->
            Font("fonts/$file", assets, FontWeight(w), variationSettings = FontVariation.Settings(FontVariation.weight(w)))
        })
        runCatching { hand = family("Caveat.ttf", 500, 700) }
        runCatching { round = family("Nunito.ttf", 500, 700, 800, 900) }
        runCatching { quiet = family("Inter.ttf", 400, 500, 600) }
    }
}

/** Generated UI on paper: ink, light cards, the home screen's type. */
fun paperPalette() = Palette(
    text = PaperLook.ink, muted = PaperLook.inkSoft, card = Color(0xFFF5F2EA), card2 = Color(0xFFECE8DE), line = Color(0x2224282A),
    accent = Color(0xFFE2A93B), accentInk = PaperLook.ink, ok = Color(0xFF4FA87A), tipBg = Color(0xFFE6F1E2), warnBg = Color(0xFFFBE1DB),
    timerBg = Color(0xFFFFF1C9), timerLine = Color(0xFFE2C77A), timerOnBg = Color(0xFFDDF0E3), panel = Color(0xFFECE8DE), font = PaperLook.round,
)

/** Handwriting, e.g. a note: `Text("Feed Biscuit", style = handText(40))`. */
@Composable fun handText(size: Number, color: Color = PaperLook.ink, weight: FontWeight = FontWeight.Medium, lineHeight: Float = 1.15f) =
    TextStyle(fontFamily = PaperLook.hand, fontSize = fontU(size), fontWeight = weight, color = color, lineHeight = fontU(size.toFloat() * lineHeight))

/** The home screen's type (Inter), for the assistant's words over it. */
@Composable fun quietText(size: Number, weight: FontWeight = FontWeight.Normal, color: Color = PaperLook.ink, lineHeight: Float = 1.4f) =
    TextStyle(fontFamily = PaperLook.quiet, fontSize = fontU(size), fontWeight = weight, color = color, lineHeight = fontU(size.toFloat() * lineHeight))

/** The home screen's print type (Nunito). */
@Composable fun roundText(size: Number, weight: FontWeight = FontWeight.Bold, color: Color = PaperLook.ink, lineHeight: Float = 1.3f) =
    TextStyle(fontFamily = PaperLook.round, fontSize = fontU(size), fontWeight = weight, color = color, lineHeight = fontU(size.toFloat() * lineHeight))

/** The surface everything sticks to, with a soft sheen. */
@Composable
fun PaperSurface(modifier: Modifier = Modifier, content: @Composable BoxScope.() -> Unit) {
    Box(
        Modifier.fillMaxSize().background(PaperLook.surface).then(modifier).drawBehind {
            drawRect(Brush.linearGradient(listOf(Color.White.copy(0f), Color.White.copy(.32f), Color.White.copy(0f)),
                start = Offset(size.width * .30f, 0f), end = Offset(size.width * .62f, size.height * .25f)))
        },
        content = content,
    )
}

enum class PaperKind { Sticky, Lined, Card, Plain }

/**
 * A paper on the home screen: a sticky note, lined notebook paper, a white card. Held by a magnet (its
 * color) or tape, tilted a little (`tilt` in degrees) so the home screen looks lived in.
 */
@Composable
fun Paper(
    modifier: Modifier = Modifier, kind: PaperKind = PaperKind.Card, tilt: Float = 0f, magnet: Color? = PaperLook.magnets[0], tape: Boolean = false,
    color: Color? = null, padding: PaddingValues = PaddingValues(horizontal = 26.u, vertical = 24.u),
    /** Fill the space it's given (a note in the home screen's grid), instead of wrapping its content. */
    fill: Boolean = false, content: @Composable ColumnScope.() -> Unit,
) {
    val bg = color ?: when (kind) { PaperKind.Sticky -> PaperLook.sticky; PaperKind.Lined -> PaperLook.paper; PaperKind.Plain -> PaperLook.paper; PaperKind.Card -> PaperLook.card }
    val lineGap = 44.u
    Box(modifier.rotate(tilt).padding(top = 14.u)) {
        Column(
            Modifier.then(if (fill) Modifier.fillMaxSize() else Modifier).shadow(10.u, RoundedCornerShape(3.u), ambientColor = Color(0x33203030), spotColor = Color(0x55203030))
                .background(bg, RoundedCornerShape(3.u))
                .then(if (kind == PaperKind.Lined) Modifier.drawBehind {
                    val g = lineGap.toPx(); var y = g * 1.6f
                    while (y < size.height) { drawLine(PaperLook.lines, Offset(0f, y), Offset(size.width, y), 1.5f); y += g }
                    drawLine(PaperLook.margin, Offset(54f, 0f), Offset(54f, size.height), 1.5f)
                } else Modifier)
                .padding(padding),
            content = content,
        )
        // (No pushpins: the family found them fussy. Notes just sit on the home screen; stickies keep their tape.)
        if (tape) Box(Modifier.align(Alignment.TopCenter).offset(y = (-10).u).rotate(-3f).size(120.u, 34.u).background(PaperLook.tape))
    }
}

/** A round magnet. */
@Composable
fun Magnet(color: Color, modifier: Modifier = Modifier, size: Int = 38) {
    Box(
        modifier.size(size.u).shadow(4.u, CircleShape).clip(CircleShape).background(color).drawBehind {
            drawCircle(Color.Black.copy(.15f), radius = this.size.minDimension / 2, center = Offset(this.size.width / 2, this.size.height / 2 + 4f), style = Stroke(5f))
            drawCircle(Color.White.copy(.35f), radius = this.size.minDimension * .18f, center = Offset(this.size.width * .36f, this.size.height * .32f))
        },
    )
}

/** The clock tile: a dark magnetic board with the time and one line under it. */
@Composable
fun ClockTile(time: String, line: String, modifier: Modifier = Modifier) {
    Column(modifier.shadow(8.u, RoundedCornerShape(26.u)).background(PaperLook.tile, RoundedCornerShape(26.u)).padding(horizontal = 30.u, vertical = 18.u)) {
        Text(time, style = roundText(104, FontWeight.Black, Color(0xFFF3EFE6), lineHeight = 1f))
        Text(line, style = roundText(24, FontWeight.Bold, Color(0xFFB9B5AC)))
    }
}

/** A round timer on the home screen: the time left and a ring that empties. */
@Composable
fun TimerDial(label: String, left: String, progress: Float, ringing: Boolean, modifier: Modifier = Modifier, onTap: () -> Unit = {}) {
    Box(modifier.size(150.u).shadow(8.u, CircleShape).clip(CircleShape).background(if (ringing) PaperLook.magnets[0] else PaperLook.tile).clickable(onClick = onTap), contentAlignment = Alignment.Center) {
        val accent = PaperLook.magnets[3]
        Canvas(Modifier.fillMaxSize().padding(10.u)) {
            val sw = size.minDimension * 0.07f
            drawArc(Color.White.copy(.12f), 0f, 360f, false, style = Stroke(sw), topLeft = Offset(sw / 2, sw / 2), size = Size(size.width - sw, size.height - sw))
            drawArc(accent, -90f, 360f * (1 - progress.coerceIn(0f, 1f)), false, style = Stroke(sw, cap = StrokeCap.Round), topLeft = Offset(sw / 2, sw / 2), size = Size(size.width - sw, size.height - sw))
        }
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(if (ringing) "Done!" else left, style = roundText(38, FontWeight.Black, Color(0xFFF3EFE6), lineHeight = 1f))
            Text(label, style = roundText(16, FontWeight.Bold, Color(0xFFB9B5AC)), maxLines = 1)
        }
    }
}

/**
 * An app or game the family made, as a die-cut sticker: a shape with a thick white border, its
 * name and who made it in handwriting underneath.
 */
@Composable
fun Sticker(name: String, by: String?, color: Color, modifier: Modifier = Modifier, tilt: Float = 0f, dashed: Boolean = false, onClick: (() -> Unit)?, face: @Composable BoxScope.() -> Unit) {
    Column(modifier.rotate(tilt).width(170.u).then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier), horizontalAlignment = Alignment.CenterHorizontally) {
        if (dashed) Box(Modifier.size(118.u).drawBehind {
            drawCircle(PaperLook.inkSoft.copy(.55f), style = Stroke(4f, pathEffect = androidx.compose.ui.graphics.PathEffect.dashPathEffect(floatArrayOf(18f, 14f))))
        }, contentAlignment = Alignment.Center, content = face)
        else Box(Modifier.size(118.u).shadow(8.u, CircleShape).clip(CircleShape).background(Color.White).padding(8.u).clip(CircleShape).background(color), contentAlignment = Alignment.Center, content = face)
        Spacer(Modifier.height(6.u))
        Text(name, style = handText(30, weight = FontWeight.Bold).copy(textAlign = TextAlign.Center), maxLines = 2)
        if (by != null) Text(by, style = handText(22, PaperLook.inkSoft).copy(textAlign = TextAlign.Center), maxLines = 1)
    }
}

/** What someone said to the display, as a speech bubble with their initial. */
@Composable
fun SpeechBubble(who: String?, color: Color, text: String, modifier: Modifier = Modifier) {
    Row(modifier, verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(14.u)) {
        Box(Modifier.size(64.u).shadow(4.u, CircleShape).clip(CircleShape).background(color), contentAlignment = Alignment.Center) {
            Text((who ?: "?").take(1), style = roundText(30, FontWeight.Black, Color.White, lineHeight = 1f))
        }
        Column(Modifier.shadow(8.u, RoundedCornerShape(28.u)).background(PaperLook.card, RoundedCornerShape(topStart = 6.u, topEnd = 28.u, bottomEnd = 28.u, bottomStart = 28.u)).padding(horizontal = 26.u, vertical = 18.u)) {
            Text(((who?.uppercase() ?: "SOMEONE") + " SAID"), style = roundText(15, FontWeight.ExtraBold, PaperLook.inkSoft).copy(letterSpacing = fontU(1.5)))
            Text("“$text”", style = roundText(28, FontWeight.Bold))
        }
    }
}

/** A row of the home screen's checklists: a star that fills when done, and the item in handwriting. */
@Composable
fun StarItem(text: String, done: Boolean, color: Color = PaperLook.magnets[3], onToggle: () -> Unit) {
    Row(Modifier.clickable(onClick = onToggle).padding(vertical = 2.u), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.u)) {
        Canvas(Modifier.size(32.u)) {
            val path = androidx.compose.ui.graphics.Path()
            val cx = size.width / 2; val cy = size.height / 2; val r = size.minDimension / 2; val ri = r * .45f
            for (i in 0 until 10) {
                val a = Math.PI / 2 + i * Math.PI / 5; val rr = if (i % 2 == 0) r else ri
                val x = cx + (rr * Math.cos(a)).toFloat(); val y = cy - (rr * Math.sin(a)).toFloat()
                if (i == 0) path.moveTo(x, y) else path.lineTo(x, y)
            }
            path.close()
            if (done) drawPath(path, color) else drawPath(path, PaperLook.inkSoft.copy(.6f), style = Stroke(3f))
        }
        Text(text, style = handText(36, if (done) PaperLook.inkSoft else PaperLook.ink).copy(textDecoration = if (done) androidx.compose.ui.text.style.TextDecoration.LineThrough else null))
    }
}
