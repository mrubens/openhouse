package dev.openhouse.ui

// The weather: its card on the home screen (tap it for the full view), the full view, and the drawn sky.

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.*
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.zIndex
import androidx.compose.material.icons.filled.Delete
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.gestures.calculateRotation
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.scale
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ParentDataModifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Density
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

/** The sky behind the weather: day, night, cloud, rain, snow. */
fun skyOf(code: Int, isDay: Boolean): List<Color> {
    val wet = code in 51..67 || code in 80..82 || code >= 95
    return when {
        !isDay -> listOf(Color(0xFF0B1A3B), Color(0xFF283A6B))
        code in 71..86 -> listOf(Color(0xFF7D93AC), Color(0xFFB5C3D2))
        wet || code >= 3 -> listOf(Color(0xFF52657C), Color(0xFF8394A8))
        else -> listOf(Color(0xFF2F7BD6), Color(0xFF6DB1F2))
    }
}

/** The weather up close, like the phone's weather app: now, the next hours, the week, and the details. Tap to close. */
@Composable
fun WeatherFull(w: Weather, onClose: () -> Unit) {
    val white = Color.White; val soft = Color.White.copy(alpha = .72f)
    val panel = Modifier.clip(RoundedCornerShape(26.u)).background(Color.White.copy(alpha = .14f)).padding(horizontal = 26.u, vertical = 20.u)
    fun hourLabel(t: String, i: Int) = if (i == 0) "Now" else runCatching { val h = t.substring(11, 13).toInt(); "${if (h % 12 == 0) 12 else h % 12}${if (h < 12) "AM" else "PM"}" }.getOrDefault("")
    fun dayLabel(d: String, i: Int) = if (i == 0) "Today" else runCatching { java.time.LocalDate.parse(d).dayOfWeek.getDisplayName(java.time.format.TextStyle.SHORT, Locale.getDefault()) }.getOrDefault(d)
    fun clockOf(t: String?) = t?.let { runCatching { val h = it.substring(11, 13).toInt(); "${if (h % 12 == 0) 12 else h % 12}:${it.substring(14, 16)} ${if (h < 12) "AM" else "PM"}" }.getOrNull() }
    Box(Modifier.fillMaxSize().background(androidx.compose.ui.graphics.Brush.verticalGradient(skyOf(w.code, w.isDay))).clickable { onClose() }.padding(horizontal = 70.u, vertical = 40.u)) {
        Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(40.u)) {
            // now
            Column(Modifier.weight(0.9f).fillMaxHeight(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                Text(w.place, style = roundText(40, FontWeight.Bold, white))
                Text("${w.temp}°", style = roundText(170, FontWeight.Light, white, lineHeight = 1f))
                Text(w.condition, style = roundText(30, FontWeight.Bold, soft))
                Text("H:${w.high}°  L:${w.low}°", style = roundText(30, FontWeight.Bold, white))
                Spacer(Modifier.height(30.u))
                // the details, sharing the width evenly so nothing wraps
                val tile = Modifier.clip(RoundedCornerShape(26.u)).background(Color.White.copy(alpha = .14f)).padding(horizontal = 22.u, vertical = 18.u)
                @Composable fun Tiles(items: List<Pair<String, String>>) = Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(16.u)) {
                    items.forEach { (k, v) -> Column(tile.weight(1f)) { Text(k, style = roundText(17, FontWeight.Bold, soft), maxLines = 1); Text(v, style = roundText(32, FontWeight.Bold, white), maxLines = 1, softWrap = false) } }
                }
                Tiles(listOfNotNull(w.feels?.let { "Feels like" to "$it°" }, w.humidity?.let { "Humidity" to "$it%" }, w.wind?.let { "Wind" to "$it mph" }))
                Spacer(Modifier.height(16.u))
                Tiles(listOfNotNull(clockOf(w.sunrise)?.let { "Sunrise" to it }, clockOf(w.sunset)?.let { "Sunset" to it }))
            }
            // the next hours, and the week
            Column(Modifier.weight(1.1f).fillMaxHeight(), verticalArrangement = Arrangement.spacedBy(20.u, Alignment.CenterVertically)) {
                Row(panel.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    w.hours.filterIndexed { i, _ -> i % 2 == 0 }.take(8).forEachIndexed { i, h ->
                        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.u)) {
                            Text(hourLabel(h.time, i * 2), style = roundText(18, FontWeight.Bold, soft))
                            SkyGlyph(h.code, h.isDay, Modifier.size(34.u))
                            Text("${h.temp}°", style = roundText(24, FontWeight.Bold, white))
                        }
                    }
                }
                val lo = w.days.minOfOrNull { it.low } ?: 0; val hi = w.days.maxOfOrNull { it.high } ?: 1
                Column(panel.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.u)) {
                    w.days.forEachIndexed { i, d ->
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.u)) {
                            Text(dayLabel(d.date, i), style = roundText(24, FontWeight.Bold, white), modifier = Modifier.width(90.u))
                            SkyGlyph(d.code, true, Modifier.size(30.u))
                            Text(d.rain?.takeIf { it >= 20 }?.let { "$it%" } ?: "", style = roundText(17, FontWeight.Bold, Color(0xFF9FD3FF)), modifier = Modifier.width(50.u))
                            Text("${d.low}°", style = roundText(24, FontWeight.Bold, soft), modifier = Modifier.width(56.u))
                            // the day's range on the week's scale, like the phone's
                            androidx.compose.foundation.Canvas(Modifier.weight(1f).height(10.u)) {
                                val span = (hi - lo).coerceAtLeast(1).toFloat()
                                drawRoundRect(Color.White.copy(alpha = .2f), cornerRadius = androidx.compose.ui.geometry.CornerRadius(size.height / 2))
                                val a = (d.low - lo) / span * size.width; val b = (d.high - lo) / span * size.width
                                drawRoundRect(androidx.compose.ui.graphics.Brush.horizontalGradient(listOf(Color(0xFF7FD0E8), Color(0xFFF6C35B))), topLeft = Offset(a, 0f),
                                    size = androidx.compose.ui.geometry.Size((b - a).coerceAtLeast(size.height), size.height), cornerRadius = androidx.compose.ui.geometry.CornerRadius(size.height / 2))
                            }
                            Text("${d.high}°", style = roundText(24, FontWeight.Bold, white), modifier = Modifier.width(56.u))
                        }
                    }
                }
            }
        }
    }
}

/** The weather, like the phone widget: the place, a big temperature, a small drawn sky, the condition and the day's
 *  high and low, on a sky that matches (day, night, cloud, rain, snow). Nothing else. */
@Composable
fun WeatherCard(w: Weather) {
    val wet = w.code in 51..67 || w.code in 80..82 || w.code >= 95
    val cloudy = w.code in 2..48 || wet
    val sky = skyOf(w.code, w.isDay)
    val shape = RoundedCornerShape(30.u)
    Column(Modifier.width(300.u).shadow(10.u, shape).clip(shape).background(androidx.compose.ui.graphics.Brush.verticalGradient(sky)).padding(horizontal = 26.u, vertical = 20.u)) {
        Text(w.place, style = roundText(22, FontWeight.Bold, Color.White), maxLines = 1)
        Text("${w.temp}°", style = roundText(84, FontWeight.Medium, Color.White, lineHeight = 1f), maxLines = 1)
        Spacer(Modifier.height(10.u))
        SkyGlyph(w.code, w.isDay, Modifier.size(28.u))
        Text(w.condition, style = roundText(20, FontWeight.Bold, Color.White), maxLines = 1)
        Text("H:${w.high}°  L:${w.low}°", style = roundText(20, FontWeight.Bold, Color.White), maxLines = 1)
    }
}

/** A small drawn sky: sun or moon, a cloud, rain or snow, in white. */
@Composable
fun SkyGlyph(code: Int, isDay: Boolean, modifier: Modifier) = androidx.compose.foundation.Canvas(modifier) {
    val w = object { val code = code; val isDay = isDay }
    val s = size.minDimension; val white = Color.White
    val wet = w.code in 51..67 || w.code in 80..82 || w.code >= 95; val snow = w.code in 71..86
    val cloud = w.code >= 2
    if (w.code <= 2) { // the sun or the moon, peeking when partly cloudy
        val c = if (cloud) Offset(s * .68f, s * .32f) else Offset(s / 2, s / 2); val r = s * (if (cloud) .2f else .26f)
        if (w.isDay) { drawCircle(Color(0xFFFFD84D), r, c); if (!cloud) for (i in 0 until 8) { val a = i * Math.PI / 4; drawLine(Color(0xFFFFD84D), Offset(c.x + (r * 1.35f * kotlin.math.cos(a)).toFloat(), c.y + (r * 1.35f * kotlin.math.sin(a)).toFloat()), Offset(c.x + (r * 1.8f * kotlin.math.cos(a)).toFloat(), c.y + (r * 1.8f * kotlin.math.sin(a)).toFloat()), s * .07f, androidx.compose.ui.graphics.StrokeCap.Round) } }
        else { drawCircle(white, r, c); drawCircle(Color(0xFF1B2B55), r * .85f, Offset(c.x + r * .45f, c.y - r * .3f)) }
    }
    if (cloud) {
        val y = if (wet || snow) s * .45f else s * .58f
        drawCircle(white, s * .2f, Offset(s * .34f, y)); drawCircle(white, s * .25f, Offset(s * .55f, y - s * .08f))
        drawRoundRect(white, Offset(s * .14f, y - s * .02f), androidx.compose.ui.geometry.Size(s * .7f, s * .22f), androidx.compose.ui.geometry.CornerRadius(s * .11f))
    }
    if (wet) for (i in 0..2) drawLine(white, Offset(s * (.3f + i * .2f), s * .78f), Offset(s * (.26f + i * .2f), s * .95f), s * .07f, androidx.compose.ui.graphics.StrokeCap.Round)
    if (snow) for (i in 0..2) drawCircle(white, s * .05f, Offset(s * (.3f + i * .2f), s * .86f))
}
