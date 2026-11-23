package dev.openhouse.ui

import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp

/**
 * openhouse's look, shared by the fixed parts of the shell and the board the family's agent edits.
 *
 * Sizes are in "u": one u is one pixel of a 1536-wide layout, scaled to the actual screen, so
 * the same design reads the same on any tablet and from across a room (`22.u`, `fontU(22)`).
 */
@Immutable
object Oh {
    val bg = Color(0xFF161513)
    val panel = Color(0xFF242320)
    val card = Color(0xFF2D2B28)
    val card2 = Color(0xFF24221F)
    val line = Color(0xFF3A3834)
    val text = Color(0xFFF3EFE6)
    val muted = Color(0xFFA59F93)
    val accent = Color(0xFFE9B949)
    val accentInk = Color(0xFF1D1C1A)
    val ok = Color(0xFF7FC8A9)
    val warn = Color(0xFFE76F51)
    val tipBg = Color(0xFF2F3A33)
    val warnBg = Color(0xFF432A24)
    val timerBg = Color(0xFF3B3423)
    val timerLine = Color(0xFF5C4F2C)
    val timerOnBg = Color(0xFF24392F)
    /** Each family member's color, in household order. */
    val people = listOf(Color(0xFFE9B949), Color(0xFF7CC6A4), Color(0xFFF08A6C), Color(0xFF8FB3FF), Color(0xFFD59BE6), Color(0xFFF3C98B))
}

/** Colors (and type) generated UI is drawn with: dark by default, paper and ink on the fridge door. */
@Immutable
data class Palette(
    val text: Color, val muted: Color, val card: Color, val card2: Color, val line: Color, val accent: Color, val accentInk: Color,
    val ok: Color, val tipBg: Color, val warnBg: Color, val timerBg: Color, val timerLine: Color, val timerOnBg: Color, val panel: Color,
    val font: androidx.compose.ui.text.font.FontFamily? = null,
)
val DarkPalette = Palette(Oh.text, Oh.muted, Oh.card, Oh.card2, Oh.line, Oh.accent, Oh.accentInk, Oh.ok, Oh.tipBg, Oh.warnBg, Oh.timerBg, Oh.timerLine, Oh.timerOnBg, Oh.panel)
val LocalPalette = staticCompositionLocalOf { DarkPalette }

/** dp per u (one pixel of the 1536-wide layout). */
val LocalU = staticCompositionLocalOf { 0.75f }

val Int.u: Dp @Composable get() = (this * LocalU.current).dp
val Float.u: Dp @Composable get() = (this * LocalU.current).dp

/** A font size in u, ignoring the system font scale (the layout is designed for a fixed width). */
@Composable fun fontU(v: Number): TextUnit = with(LocalDensity.current) { (v.toFloat() * LocalU.current).dp.toSp() }

@Composable fun ohText(size: Number, weight: FontWeight = FontWeight.Normal, color: Color = LocalPalette.current.text, lineHeight: Float = 1.35f) =
    TextStyle(fontSize = fontU(size), fontWeight = weight, color = color, lineHeight = fontU(size.toFloat() * lineHeight), fontFamily = LocalPalette.current.font)

/** Measures the screen and provides u for everything inside. Wrap whole screens in it. */
@Composable fun OhScreen(content: @Composable () -> Unit) {
    BoxWithConstraints {
        val u = maxWidth.value / 1536f
        CompositionLocalProvider(LocalU provides u) { content() }
    }
}
