package dev.openhouse.ui

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF

/**
 * An app's own icon, drawn by the agent as a small SVG (apps/<id>/icon.svg): a square viewBox with
 * <path d>, <circle>, <ellipse> and <rect> shapes, each with fill and/or stroke. Enough for a clean
 * flat icon; anything fancier (gradients, text, transforms) is ignored.
 */
class SvgIcon private constructor(private val box: RectF, private val parts: List<Part>) {
    private class Part(val path: Path, val fill: Int?, val stroke: Int?, val strokeWidth: Float)

    /** Draw it into the square [size] at ([x], [y]). */
    fun draw(c: Canvas, x: Float, y: Float, size: Float) {
        val s = size / maxOf(box.width(), box.height())
        c.save(); c.translate(x, y); c.scale(s, s); c.translate(-box.left, -box.top)
        val p = Paint(Paint.ANTI_ALIAS_FLAG)
        for (part in parts) {
            part.fill?.let { p.style = Paint.Style.FILL; p.color = it; c.drawPath(part.path, p) }
            part.stroke?.let { p.style = Paint.Style.STROKE; p.color = it; p.strokeWidth = part.strokeWidth; p.strokeCap = Paint.Cap.ROUND; p.strokeJoin = Paint.Join.ROUND; c.drawPath(part.path, p) }
        }
        c.restore()
    }

    companion object {
        private val cache = HashMap<String, SvgIcon?>()
        fun parse(svg: String?): SvgIcon? = if (svg.isNullOrBlank()) null else synchronized(cache) { cache.getOrPut(svg) { runCatching { read(svg) }.getOrNull() } }

        private fun attrs(tag: String): Map<String, String> =
            Regex("""([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')""").findAll(tag).associate { it.groupValues[1] to (it.groupValues[3].ifEmpty { it.groupValues[4] }) }

        private fun read(svg: String): SvgIcon? {
            val root = Regex("<svg\\b[^>]*>", RegexOption.IGNORE_CASE).find(svg)?.value ?: return null
            val ra = attrs(root)
            val vb = ra["viewBox"]?.trim()?.split(Regex("[\\s,]+"))?.mapNotNull { it.toFloatOrNull() }
            val box = if (vb != null && vb.size == 4) RectF(vb[0], vb[1], vb[0] + vb[2], vb[1] + vb[3])
                else RectF(0f, 0f, ra["width"]?.toFloatOrNull() ?: 24f, ra["height"]?.toFloatOrNull() ?: 24f)
            val inheritFill = ra["fill"]; val inheritStroke = ra["stroke"]; val inheritWidth = ra["stroke-width"]
            val parts = mutableListOf<Part>()
            for (m in Regex("<(path|circle|ellipse|rect)\\b[^>]*>", RegexOption.IGNORE_CASE).findAll(svg)) {
                val a = attrs(m.value)
                val path = when (m.groupValues[1].lowercase()) {
                    "path" -> androidx.core.graphics.PathParser.createPathFromPathData(a["d"] ?: continue)
                    "circle" -> Path().apply { addCircle(f(a["cx"]), f(a["cy"]), f(a["r"]), Path.Direction.CW) }
                    "ellipse" -> Path().apply { addOval(RectF(f(a["cx"]) - f(a["rx"]), f(a["cy"]) - f(a["ry"]), f(a["cx"]) + f(a["rx"]), f(a["cy"]) + f(a["ry"])), Path.Direction.CW) }
                    else -> Path().apply { val r = RectF(f(a["x"]), f(a["y"]), f(a["x"]) + f(a["width"]), f(a["y"]) + f(a["height"])); val rx = f(a["rx"] ?: a["ry"]); addRoundRect(r, rx, rx, Path.Direction.CW) }
                }
                val style = a["style"]?.split(';')?.mapNotNull { kv -> kv.split(':', limit = 2).takeIf { it.size == 2 }?.let { it[0].trim() to it[1].trim() } }?.toMap() ?: emptyMap()
                val fill = color(style["fill"] ?: a["fill"] ?: inheritFill ?: "#000")
                val stroke = color(style["stroke"] ?: a["stroke"] ?: inheritStroke ?: "none")
                parts += Part(path, fill, stroke, (style["stroke-width"] ?: a["stroke-width"] ?: inheritWidth)?.removeSuffix("px")?.toFloatOrNull() ?: 1f)
            }
            return if (parts.isEmpty()) null else SvgIcon(box, parts)
        }

        private fun f(s: String?) = s?.removeSuffix("px")?.toFloatOrNull() ?: 0f

        private fun color(s: String): Int? {
            val v = s.trim().lowercase()
            if (v == "none" || v == "transparent" || v.isEmpty()) return null
            if (v.startsWith("#")) {
                val h = v.drop(1)
                val full = when (h.length) { 3 -> h.map { "$it$it" }.joinToString(""); 6 -> h; 8 -> h.substring(0, 6); else -> return null }
                return (0xFF000000 or full.toLong(16)).toInt()
            }
            Regex("""rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)""").find(v)?.let { m -> val (r, g, b) = m.destructured; return android.graphics.Color.rgb(r.toInt(), g.toInt(), b.toInt()) }
            return runCatching { android.graphics.Color.parseColor(v) }.getOrNull()
        }
    }
}
