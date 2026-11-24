package dev.openhouse.ui

// Small pieces the overlay and its sheets share (the home screen itself is the bridge's web page now: HomeView).

import androidx.compose.animation.core.*
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

internal fun clock(t: Long) = SimpleDateFormat("h:mm", Locale.getDefault()).format(Date(t))

@Composable
fun Avatar(p: Person, size: Int) {
    Box(Modifier.size(size.u).clip(CircleShape).background(p.color), contentAlignment = Alignment.Center) {
        Text(p.name.take(1), style = ohText(size * 0.48f, FontWeight.Bold, Color(0xFF1B1A17), lineHeight = 1f))
    }
}

@Composable
fun Dots(color: Color? = null) {
    val t = rememberInfiniteTransition(label = "dots")
    Row(horizontalArrangement = Arrangement.spacedBy(5.u)) {
        repeat(3) { i ->
            val a by t.animateFloat(.25f, 1f, infiniteRepeatable(tween(600, delayMillis = i * 150), RepeatMode.Reverse), label = "dot")
            Box(Modifier.size(8.u).alpha(a).clip(CircleShape).background(color ?: Oh.accent))
        }
    }
}

