package dev.openhouse.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.IntOffset

/**
 * Talk and Type from the home screen's rail (chat/src/home.jsx, its `h-tools`), floating in the same places on the
 * screen when an app is on top: a household app in the layer over the home (ShellOverlay), or an Android app, or a
 * household app in its own window (Buddy's windows over other apps). So someone can always start talking or typing
 * from the same spot. The page says where they are and in what colors whenever its layout changes
 * (HomeView.railTools); upright on a phone there's no rail (its tools are in More), so nothing floats there.
 *
 * Over an app they look as they do on the rail (its fill and ink), with a soft shadow for an edge, and a little
 * see-through: a game's or a video's corner still shows through them. No rule per app.
 */
object RailTools {
    /** A button's square on the screen, in pixels. */
    data class Spot(val x: Float, val y: Float, val size: Float)
    /** Where Talk and Type are, the icon's inset (of the size), and the rail's fill and ink. */
    data class Spots(val talk: Spot?, val type: Spot?, val inset: Float, val fill: Int, val ink: Int, val home: Spot? = null)

    var spots by mutableStateOf<Spots?>(null)

    /** Over an app, how much shows (the rest is the app under it). */
    const val OVER_APP = .8f
    const val TALK = 0; const val TYPE = 1; const val HOME = 2

    /**
     * The page's report: {dpr, talk: [x, y, w, h], type: [...], inset, fill: "#rrggbb", ink: "#rrggbb"} in CSS pixels
     * of the page, or {} with no rail. [left]/[top]: where the page's view is on the screen.
     */
    fun parse(json: String, left: Int, top: Int): Spots? = runCatching {
        val j = org.json.JSONObject(json)
        val dpr = j.optDouble("dpr", 1.0).toFloat().takeIf { it in .5f..8f } ?: return null
        fun spot(k: String) = j.optJSONArray(k)?.takeIf { it.length() == 4 }?.let { a ->
            val w = a.getDouble(2).toFloat() * dpr; val h = a.getDouble(3).toFloat() * dpr
            if (w < 8 || h < 8 || w > 600) null else Spot(left + a.getDouble(0).toFloat() * dpr, top + a.getDouble(1).toFloat() * dpr, minOf(w, h))
        }
        val talk = spot("talk"); val type = spot("type"); val home = spot("home")
        if (talk == null && type == null) return null
        fun color(k: String, or: Int) = j.optString(k).takeIf { Regex("#[0-9a-fA-F]{6}").matches(it) }?.let { android.graphics.Color.parseColor(it) } ?: or
        Spots(talk, type, j.optDouble("inset", .25).toFloat().coerceIn(0f, .45f), color("fill", Calm.PAPER), color("ink", Calm.INK), home)
    }.getOrNull()

    /** Something is up over the app (a sheet, a card, typing, the conversation, the setup), or the screen is dark. */
    fun stepAside(): Boolean {
        val o = Openhouse
        return o.dark || o.sleeping || o.typing != null || o.showConversation || o.showSettings || o.showFamily || Devices.open ||
            o.confirmDelete != null || o.showWeather || o.showJobs || o.phoneCard != null || o.fullNote != null || o.setupStep != null || o.showWelcome
    }
}

/** Both buttons, each at its place, in a layer the size of the screen (ShellOverlay, over the household app's layer). */
@Composable
fun RailToolsOverApp() {
    val s = RailTools.spots ?: return
    Box(Modifier.fillMaxSize()) {
        s.talk?.let { RailToolButton(RailTools.TALK, s, Modifier.offset { IntOffset(it.x.toInt(), it.y.toInt()) }) }
        s.type?.let { RailToolButton(RailTools.TYPE, s, Modifier.offset { IntOffset(it.x.toInt(), it.y.toInt()) }) }
        s.home?.let { RailToolButton(RailTools.HOME, s, Modifier.offset { IntOffset(it.x.toInt(), it.y.toInt()) }) }
    }
}

/** One of them: Talk, Type, or Opie's mark (back to Opie, in the rail's third place), the rail's size, fill and icon. */
@Composable
fun RailToolButton(kind: Int, s: RailTools.Spots, modifier: Modifier = Modifier) {
    val spot = (when (kind) { RailTools.TALK -> s.talk; RailTools.TYPE -> s.type; else -> s.home }) ?: return
    val d = with(LocalDensity.current) { spot.size.toDp() }
    val fill = Color(s.fill); val ink = Color(s.ink)
    Box(modifier.size(d).graphicsLayer { alpha = RailTools.OVER_APP; compositingStrategy = CompositingStrategy.ModulateAlpha }.shadow(d / 10, CircleShape).clip(CircleShape).background(fill)
        .clickable(remember { MutableInteractionSource() }, indication = null) { when (kind) { RailTools.TALK -> Openhouse.tapToTalk(); RailTools.TYPE -> Openhouse.openTyping(); else -> { Openhouse.host.closeApp(); dev.openhouse.shell.KioskApps.goHome() } } },
        contentAlignment = Alignment.Center) {
        Canvas(Modifier.size(d * (1 - 2 * s.inset))) { when (kind) { RailTools.TALK -> bars(ink); RailTools.TYPE -> keys(ink); else -> mark(ink) } }
    }
}

// The rail's own icons (home.jsx Bars and Keys), on their 24-unit box.
private val barsPath by lazy { PathParser().parsePathString("M5 10.5v3M9.67 7.5v9M14.33 6v12M19 9.5v5").toPath() }
/** Opie's mark (brand/mark.svg): the house outline, in a 24-unit box. */
private val markPath by lazy { PathParser().parsePathString("M4 11.5 12 4.3l8 7.2v7.7a1.3 1.3 0 0 1-1.3 1.3H5.3A1.3 1.3 0 0 1 4 19.2Z").toPath() }
private val keysPath by lazy { PathParser().parsePathString("M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8").toPath() }

private fun DrawScope.bars(ink: Color) = scale(size.width / 24f, size.height / 24f, Offset.Zero) {
    drawPath(barsPath, ink, style = Stroke(2.4f, cap = StrokeCap.Round))
}

private fun DrawScope.keys(ink: Color) = scale(size.width / 24f, size.height / 24f, Offset.Zero) {
    val line = Stroke(2f, cap = StrokeCap.Round, join = StrokeJoin.Round)
    drawRoundRect(ink, Offset(2.5f, 6f), Size(19f, 12f), CornerRadius(2f), style = line)
    drawPath(keysPath, ink, style = line)
}
private fun DrawScope.mark(ink: Color) = scale(size.width / 24f, size.height / 24f, Offset.Zero) {
    drawPath(markPath, ink, style = Stroke(2.2f, cap = StrokeCap.Round, join = StrokeJoin.Round))
}
