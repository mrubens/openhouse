package dev.openhouse.ui

import org.json.JSONArray
import org.json.JSONObject

/**
 * Answers are prose plus ```spec fences of JSONL patches (json-render's format: RFC 6902 ops on
 * {root, elements, state}). While an answer streams, the last fence may be unfinished: compile
 * the complete lines so far so the UI fills in as it arrives.
 */
sealed class Segment {
    data class Prose(val text: String) : Segment()
    data class Ui(val src: String, val done: Boolean) : Segment()
}

class Element(val id: String, val type: String, val props: JSONObject, val children: List<String>, val on: JSONObject?, val show: String? = null)

/** How the assistant asked for its answer to sit on the door (a root `Note` element), if it did. */
data class NoteStyle(val size: String?, val paper: String?, val color: String?)
class Spec(val root: String, val elements: Map<String, Element>)

object Answers {
    private val fence = Regex("```spec[^\\n]*\\n([\\s\\S]*?)(```|$)")
    private val buildLineRe = Regex("(?m)^BUILD:.*$")

    fun segments(text: String): List<Segment> {
        val out = mutableListOf<Segment>()
        var at = 0
        for (m in fence.findAll(text)) {
            if (m.range.first > at) out += Segment.Prose(text.substring(at, m.range.first))
            out += Segment.Ui(m.groupValues[1], m.groupValues[2] == "```")
            at = m.range.last + 1
            if (m.groupValues[2].isEmpty()) break
        }
        if (at < text.length) out += Segment.Prose(text.substring(at))
        // UI lines that lost their fence never show as raw text.
        return out.mapNotNull { s -> if (s is Segment.Prose) s.text.replace(buildLineRe, "").lines().filterNot { it.trimStart().startsWith("{\"op\"") }.joinToString("\n").trim().takeIf { it.isNotEmpty() }?.let { Segment.Prose(it) } else s }
    }

    fun hasUi(text: String?) = text?.contains("```spec") == true

    /** The picture, if a note is nothing but one picture (then it fills the note, edge to edge). */
    fun soloImage(text: String?): String? {
        val ui = text?.let { segments(it) }?.filterIsInstance<Segment.Ui>()?.singleOrNull() ?: return null
        val spec = compile(ui.src, ui.done) ?: return null
        var e = spec.elements[spec.root] ?: return null
        // What shows on the door (elements marked "show": "full" are only up close).
        fun onDoor(x: Element) = x.children.mapNotNull { spec.elements[it] }.filter { it.show != "full" }
        while (e.type in setOf("Stack", "Note", "Card") && onDoor(e).size == 1) e = onDoor(e)[0]
        return if (e.type == "Image") e.props.optString("url").ifEmpty { null } else null
    }

    /** The answer's `Note` (its size, paper and color on the door), from the first UI block. */
    fun note(text: String?): NoteStyle? {
        val ui = text?.let { segments(it) }?.filterIsInstance<Segment.Ui>()?.firstOrNull() ?: return null
        val spec = compile(ui.src, ui.done) ?: return null
        val r = spec.elements[spec.root]?.takeIf { it.type == "Note" } ?: return null
        return NoteStyle(r.props.optString("size").ifEmpty { null }, r.props.optString("paper").ifEmpty { null }, r.props.optString("color").ifEmpty { null })
    }
    fun buildLine(text: String) = Regex("(?m)^BUILD:\\s*(.+)$").find(text)?.groupValues?.get(1)?.trim()

    private val abbrev = setOf("mr", "mrs", "ms", "dr", "st", "vs", "etc", "no", "approx", "min", "hr", "tbsp", "tsp", "oz", "lb")

    /**
     * Whole sentences, for speaking them one at a time as an answer streams in. A sentence ends at
     * . ! or ? followed by a space and a capital (or the end of the text, once [final]), so "2:35 p.m.",
     * "e.g. this", "2.5 cups" and "Dr. Lee" stay whole. Without [final], the unfinished tail is left out.
     */
    fun sentences(text: String, final: Boolean): List<String> {
        val out = mutableListOf<String>(); var start = 0; var i = 0
        val t = text
        while (i < t.length) {
            if (t[i] in ".!?") {
                var j = i + 1
                while (j < t.length && (t[j] in ".!?\"”’)")) j++
                val atEnd = j >= t.length
                val next = t.substring(j).trimStart()
                val spaced = !atEnd && t[j].isWhitespace()
                val word = t.substring(start, i).trimEnd().substringAfterLast(' ').lowercase()
                val isAbbrev = t[i] == '.' && (word.trimEnd('.') in abbrev || (word.contains('.') && next.firstOrNull()?.isLowerCase() == true) || (word.length == 1 && word[0].isLetter()))
                val ends = when {
                    atEnd -> final
                    !spaced -> false
                    next.isEmpty() -> final
                    else -> !isAbbrev && (next[0].isUpperCase() || next[0].isDigit() || next[0] in "\"“‘(")
                }
                if (ends) { t.substring(start, j).trim().takeIf { it.isNotEmpty() }?.let { out += it }; start = j }
                i = j
            } else i++
        }
        if (final) t.substring(start).trim().takeIf { it.isNotEmpty() }?.let { out += it }
        return out
    }

    /** The prose before the first UI, for speaking: no markdown, links, URLs or emoji. */
    fun speakable(t: String) = t.replace(Regex("\\*\\*?|__|`"), "").replace(Regex("\\[([^\\]]+)\\]\\([^)]+\\)"), "$1")
        .replace(Regex("https?:\\S+"), "").replace(Regex("(?m)^[-•]\\s+"), "")
        .replace(Regex("[\\x{1F300}-\\x{1FAFF}\\x{2600}-\\x{27BF}\\x{FE0F}]"), "").replace(Regex("\\s+"), " ").trim()

    fun compile(src: String, done: Boolean): Spec? {
        val lines = src.split('\n').let { if (done) it else it.dropLast(1) } // the last line may be half-written
        val doc = JSONObject().put("root", "").put("elements", JSONObject()).put("state", JSONObject())
        for (line in lines) {
            val l = line.trim(); if (!l.startsWith("{")) continue
            val op = runCatching { JSONObject(l) }.getOrNull() ?: continue
            runCatching { apply(doc, op) }
        }
        val root = doc.optString("root"); val els = doc.optJSONObject("elements") ?: return null
        if (root.isEmpty() || !els.has(root)) return null
        val state = doc.optJSONObject("state") ?: JSONObject()
        val map = mutableMapOf<String, Element>()
        for (id in els.keys()) {
            val e = els.optJSONObject(id) ?: continue
            val props = resolve(e.optJSONObject("props") ?: JSONObject(), state) as JSONObject
            val kids = e.optJSONArray("children")?.let { a -> (0 until a.length()).mapNotNull { a.opt(it) as? String } } ?: emptyList()
            map[id] = Element(id, e.optString("type"), props, kids, e.optJSONObject("on"), e.optString("show").takeIf { it == "door" || it == "full" })
        }
        return Spec(root, map)
    }

    /** Replace {"$state": "/pointer"} values with what's at that pointer in the spec's state. */
    private fun resolve(v: Any?, state: JSONObject): Any? = when (v) {
        is JSONObject -> if (v.length() == 1 && v.has("\$state")) pointer(state, v.optString("\$state")) ?: JSONObject.NULL
            else JSONObject().also { o -> v.keys().forEach { k -> o.put(k, resolve(v.opt(k), state)) } }
        is JSONArray -> JSONArray().also { a -> (0 until v.length()).forEach { a.put(resolve(v.opt(it), state)) } }
        else -> v
    }
    private fun pointer(root: Any, p: String): Any? {
        var node: Any? = root
        for (k in p.split('/').drop(1).map { it.replace("~1", "/").replace("~0", "~") }) node = when (node) {
            is JSONObject -> node.opt(k); is JSONArray -> k.toIntOrNull()?.let { node.opt(it) }; else -> null
        }
        return node
    }

    private fun apply(doc: JSONObject, op: JSONObject) {
        val path = op.optString("path").split('/').drop(1).map { it.replace("~1", "/").replace("~0", "~") }
        if (path.isEmpty()) return
        var node: Any = doc
        for (k in path.dropLast(1)) {
            node = when (node) {
                is JSONObject -> node.optJSONObject(k) ?: node.optJSONArray(k) ?: JSONObject().also { (node as JSONObject).put(k, it) }
                is JSONArray -> node.opt(k.toInt())!!
                else -> return
            }
        }
        val key = path.last()
        when (op.optString("op")) {
            "add", "replace" -> when (node) {
                is JSONObject -> node.put(key, op.opt("value"))
                is JSONArray -> if (key == "-") node.put(op.opt("value")) else if (op.optString("op") == "add") insert(node, key.toInt(), op.opt("value")) else node.put(key.toInt(), op.opt("value"))
            }
            "remove" -> when (node) { is JSONObject -> node.remove(key); is JSONArray -> node.remove(key.toInt()) }
        }
    }
    private fun insert(a: JSONArray, i: Int, v: Any?) {
        val items = (0 until a.length()).map { a.opt(it) }.toMutableList(); items.add(i.coerceIn(0, items.size), v)
        while (a.length() > 0) a.remove(a.length() - 1)
        items.forEach { a.put(it) }
    }
}
