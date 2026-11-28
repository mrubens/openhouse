package dev.openhouse.ui

// The family's own things, kept by the bridge (bridge/house.js), for the starting apps (Calendar, Chores, Lists,
// Meals, Photos) and anything else the family's assistant builds: the lists, chores with checkmarks, the meal plan,
// the calendar, photos. The apps only draw them, so an app can be rewritten or deleted without losing any of it,
// and the assistant changes the same data with its tools ("add milk", "Leo fed the cat").
//
//   House.start()                     once, in the app's create(); then read House.lists etc. (Compose state, live)
//   House.addItem("Groceries", "Milk") House.check(list, item, true)  House.removeItem  House.clearChecked
//   House.choreDone(chore, true)       House.addChore(who, task)      House.removeChore(chore)
//   House.setMeal("2026-11-20", "dinner", "Tacos")
//   House.addEvent(title, start, end, allDay, who, repeat)   House.removeEvent(id, date)  (events added here; synced ones are read-only)
//   House.stars["Leo"]  House.rewards  House.redeem(who, reward)  House.addReward(title, stars, who)   (someone says yes)
//   House.checklists (routines: morning, bedtime; .now while on)  House.checkStep(c, step, who, done)  House.addChecklist(...)
//   House.favorites (meals they have often, pinned first)  House.favorite(text, pinned)  House.addIngredients(date, meal)
//   House.removePhoto(name)  House.night / House.isNight() / House.setNight(from, to)  (no photos on the idle screen at night)
//   House.color(who)                   that person's color (the same as everywhere on the display)
//   HousePhoto(name, modifier)         one of the family's photos;  PhotoSlideshow(modifier)  all of them, one at a time
//   StepPicture(pic, modifier)         a routine step's picture ("teeth", "shoes"... House.PICS)

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Handler
import android.os.Looper
import android.util.LruCache
import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.focusRequester
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.graphics.drawscope.withTransform
import kotlinx.coroutines.*
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

data class HouseItem(val id: String, val text: String, val done: Boolean, val who: String?)
data class HouseList(val id: String, val name: String, val items: List<HouseItem>)
/** A chore: [today] whether it's due today, [done] ticked today, [week] days done in the past week (stars). */
data class HouseChore(val who: String, val task: String, val today: Boolean, val done: Boolean, val week: Int, val days: List<String>)
/** [local]: added on this display (it can be removed here); otherwise from a synced calendar. Times in ms. */
data class HouseEvent(val id: String?, val title: String, val start: Long, val end: Long?, val allDay: Boolean, val who: String?, val place: String?, val local: Boolean,
    /** For a repeating one added here: "daily", "weekdays", "weekly", "biweekly", "monthly", "yearly"; [date] this time's day. */
    val repeat: String? = null, val date: String? = null)
/** Something a kid saves stars for; [who] null: for anyone. */
data class HouseReward(val id: String, val title: String, val stars: Int, val who: String?)
/** A reward asked for, waiting for a yes. [manual]: this display has no "Is this OK?" card, so the app asks. */
data class HouseAsk(val id: String, val who: String, val reward: String, val title: String, val stars: Int, val manual: Boolean)
/** A reward given (newest first in [House.got]). */
data class HouseGot(val who: String, val title: String, val stars: Int)
data class HouseStep(val text: String, val pic: String)
/** A routine: a picture checklist shown from [from] to [to] ("HH:MM"); [who] empty: every kid; [now]: on right now; [done]: "step|who" (lowercase who) today. */
data class HouseChecklist(val id: String, val name: String, val who: List<String>, val from: String, val to: String, val days: List<String>, val steps: List<HouseStep>, val now: Boolean, val done: Set<String>) {
    fun isDone(step: HouseStep, who: String) = "${step.text}|${who.lowercase()}" in done
}
data class HouseFavorite(val text: String, val pinned: Boolean)
/** The assistant working out a meal's groceries: [state] "working", "done" ([added]) or "error" ([text]). */
data class MealWork(val state: String, val added: List<String>, val text: String?)
/** A reminder due now ("Swim in 15 minutes"): up until a few minutes after [start], or until someone puts it away. */
data class HouseReminder(val key: String, val title: String, val start: Long, val who: String?, val place: String?)

object House {
    var loaded by mutableStateOf(false); private set
    /** Today on the display, "YYYY-MM-DD". */
    var today by mutableStateOf(""); private set
    var family by mutableStateOf(listOf<Person>()); private set
    var lists by mutableStateOf(listOf<HouseList>()); private set
    var chores by mutableStateOf(listOf<HouseChore>()); private set
    /** "YYYY-MM-DD" -> meal ("dinner", "lunch"...) -> what's planned. */
    var meals by mutableStateOf(mapOf<String, Map<String, String>>()); private set
    /** The next two weeks, from the family's synced calendars plus events added here, soonest first. */
    var events by mutableStateOf(listOf<HouseEvent>()); private set
    /** How many calendar links the family added (0: only events added on the display). */
    var calendars by mutableStateOf(0); private set
    /** The family's photos (file names), newest first. */
    var photos by mutableStateOf(listOf<String>()); private set
    /** Stars each person has to spend (one per chore done). */
    var stars by mutableStateOf(mapOf<String, Int>()); private set
    var rewards by mutableStateOf(listOf<HouseReward>()); private set
    var asks by mutableStateOf(listOf<HouseAsk>()); private set
    /** The last few rewards given. */
    var got by mutableStateOf(listOf<HouseGot>()); private set
    var checklists by mutableStateOf(listOf<HouseChecklist>()); private set
    var favorites by mutableStateOf(listOf<HouseFavorite>()); private set
    /** "date|meal" -> the assistant adding that meal's groceries. */
    var mealWork by mutableStateOf(mapOf<String, MealWork>()); private set
    /** Night hours ("21:30" to "06:30") when the idle screen shows no photos; null: photos all night. */
    var night by mutableStateOf<Pair<String, String>?>("21:30" to "06:30"); private set
    /** Minutes before the resting screen starts (Settings → Screen → Resting screen, the household's); 0: never by day. */
    var restAfter by mutableStateOf(8); private set
    /** An assistant is set up (what needs one, like a meal's groceries, can be offered). */
    var ai by mutableStateOf(false); private set
    /** Reminders due now (the overlay shows them over everything); [remindAloud]: the family wants them said too. */
    var reminders by mutableStateOf(listOf<HouseReminder>()); private set
    var remindAloud by mutableStateOf(false); private set
    /** The Calendar app asks for the PIN before changes (Settings). */
    var calendarLock by mutableStateOf(false); private set
    /** Put a reminder away, on every screen. */
    fun putAway(key: String) { reminders = reminders.filter { it.key != key }; send("/house/remind", JSONObject().put("done", key)) }

    /** The pictures a routine step can have. */
    val PICS = listOf("sun", "moon", "shirt", "teeth", "shoes", "backpack", "bed", "bath", "book", "plate", "hands", "hair", "toys", "cup", "coat", "pet", "star")

    private val main = Handler(Looper.getMainLooper())
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var started = false
    private var v = 0

    /** Start following the family's things (idempotent). Call from create(). */
    fun start() {
        if (started) return; started = true
        scope.launch {
            while (true) {
                val j = runCatching { JSONObject(get(if (v == 0) "/house" else "/house/wait?v=$v&same=1")) }.getOrNull()
                if (j == null) { delay(3000); continue }
                v = j.optInt("v", v) // the bridge's own version now (after a restart it starts somewhere new)
                if (j.optBoolean("same")) continue // nothing changed: what it has is still so
                apply(j)
            }
        }
    }

    /** Whoever's color: their place in the family, the same color as on the home screen and in conversations. */
    fun color(who: String?): Color {
        if (who.isNullOrBlank()) return PaperLook.inkSoft
        val i = family.indexOfFirst { it.name.equals(who, ignoreCase = true) }
        return if (i < 0) PaperLook.inkSoft else Oh.people[i % Oh.people.size]
    }
    fun list(name: String) = lists.firstOrNull { it.name.equals(name, true) || it.id.equals(name, true) }

    // ---- changes (shown at once; the bridge's answer then confirms them) ----
    fun addItem(list: String, text: String, who: String? = null) {
        if (text.isBlank()) return
        lists = lists.map { l -> if (l.name == list || l.id == list) l.copy(items = l.items + HouseItem("new", text.trim(), false, who)) else l }
        send("/house/list", JSONObject().put("list", list).put("add", JSONArray().put(text.trim())).put("who", who))
    }
    fun check(list: String, item: HouseItem, done: Boolean) {
        lists = lists.map { l -> if (l.name == list || l.id == list) l.copy(items = l.items.map { if (it.id == item.id) it.copy(done = done) else it }) else l }
        send("/house/list", JSONObject().put("list", list).put(if (done) "check" else "uncheck", JSONArray().put(item.id)))
    }
    fun removeItem(list: String, item: HouseItem) {
        lists = lists.map { l -> if (l.name == list || l.id == list) l.copy(items = l.items.filter { it.id != item.id }) else l }
        send("/house/list", JSONObject().put("list", list).put("remove", JSONArray().put(item.id)))
    }
    fun clearChecked(list: String) {
        lists = lists.map { l -> if (l.name == list || l.id == list) l.copy(items = l.items.filter { !it.done }) else l }
        send("/house/list", JSONObject().put("list", list).put("clearChecked", true))
    }
    fun addList(name: String) { if (name.isNotBlank()) send("/house/list", JSONObject().put("list", name.trim()).put("create", true)) }
    fun deleteList(list: String) { lists = lists.filter { it.name != list && it.id != list }; send("/house/list", JSONObject().put("list", list).put("deleteList", true)) }

    fun choreDone(c: HouseChore, done: Boolean) {
        chores = chores.map { if (it == c) it.copy(done = done, week = (it.week + if (done) 1 else -1).coerceAtLeast(0)) else it }
        send("/house/chore", JSONObject().put("done", JSONObject().put("who", c.who).put("task", c.task)).put("value", done))
    }
    fun addChore(who: String, task: String, days: List<String> = emptyList()) {
        if (task.isBlank()) return
        chores = chores + HouseChore(who, task.trim(), true, false, 0, days)
        send("/house/chore", JSONObject().put("add", JSONObject().put("who", who).put("task", task.trim()).put("days", JSONArray(days))))
    }
    fun removeChore(c: HouseChore) {
        chores = chores.filter { it != c }
        send("/house/chore", JSONObject().put("remove", JSONObject().put("who", c.who).put("task", c.task)))
    }

    fun setMeal(date: String, meal: String, text: String) {
        meals = meals.toMutableMap().apply { val d = (get(date) ?: emptyMap()).toMutableMap(); if (text.isBlank()) d.remove(meal) else d[meal] = text.trim(); if (d.isEmpty()) remove(date) else put(date, d) }
        send("/house/meal", JSONObject().put("date", date).put("meal", meal).put("text", text.trim()))
    }

    /** [start]/[end] in ms; for [allDay], any time that day. */
    fun addEvent(title: String, start: Long, end: Long? = null, allDay: Boolean = false, who: String? = null) {
        if (title.isBlank()) return
        val iso = java.text.SimpleDateFormat(if (allDay) "yyyy-MM-dd" else "yyyy-MM-dd'T'HH:mm:ss", java.util.Locale.US)
        send("/house/event", JSONObject().put("add", JSONObject().put("title", title.trim()).put("start", iso.format(java.util.Date(start)))
            .put("allDay", allDay).put("who", who).apply { if (end != null && !allDay) put("end", iso.format(java.util.Date(end))) }))
    }
    fun addEvent(title: String, start: Long, end: Long?, allDay: Boolean, who: String?, repeat: String?) {
        if (title.isBlank()) return
        val iso = java.text.SimpleDateFormat(if (allDay) "yyyy-MM-dd" else "yyyy-MM-dd'T'HH:mm:ss", java.util.Locale.US)
        send("/house/event", JSONObject().put("add", JSONObject().put("title", title.trim()).put("start", iso.format(java.util.Date(start)))
            .put("allDay", allDay).put("who", who).put("repeat", repeat).apply { if (end != null && !allDay) put("end", iso.format(java.util.Date(end))) }))
    }
    /** With [date], only that day of a repeating event. */
    fun removeEvent(id: String, date: String? = null) {
        events = events.filter { it.id != id || (date != null && it.date != date) }
        send("/house/event", JSONObject().put("remove", id).put("date", date))
    }

    // rewards
    fun addReward(title: String, stars: Int, who: String? = null) { if (title.isNotBlank()) send("/house/reward", JSONObject().put("add", JSONObject().put("title", title.trim()).put("stars", stars).put("who", who))) }
    fun removeReward(r: HouseReward) { rewards = rewards.filter { it != r }; send("/house/reward", JSONObject().put("remove", r.id)) }
    /** A kid asks for a reward: someone says yes on the display's "Is this OK?" card (with the PIN). */
    fun redeem(who: String, r: HouseReward) {
        asks = asks + HouseAsk("new", who, r.id, r.title, r.stars, false)
        send("/house/reward", JSONObject().put("redeem", JSONObject().put("who", who).put("id", r.id)))
    }
    /** Only for an ask with [HouseAsk.manual] (no card on this display). */
    fun answer(a: HouseAsk, yes: Boolean) { asks = asks.filter { it != a }; send("/house/reward", JSONObject().put("answer", JSONObject().put("id", a.id).put("yes", yes))) }

    // routines
    fun addChecklist(name: String, steps: List<HouseStep>, from: String, to: String, who: List<String> = emptyList()) =
        send("/house/checklist", JSONObject().put("add", JSONObject().put("name", name).put("from", from).put("to", to).put("who", JSONArray(who))
            .put("steps", JSONArray(steps.map { JSONObject().put("text", it.text).put("pic", it.pic) }))))
    fun updateChecklist(c: HouseChecklist, steps: List<HouseStep> = c.steps, from: String = c.from, to: String = c.to, who: List<String> = c.who) =
        send("/house/checklist", JSONObject().put("update", JSONObject().put("id", c.id).put("from", from).put("to", to).put("who", JSONArray(who))
            .put("steps", JSONArray(steps.map { JSONObject().put("text", it.text).put("pic", it.pic) }))))
    fun removeChecklist(c: HouseChecklist) { checklists = checklists.filter { it.id != c.id }; send("/house/checklist", JSONObject().put("remove", c.id)) }
    fun checkStep(c: HouseChecklist, step: HouseStep, who: String, done: Boolean) {
        val k = "${step.text}|${who.lowercase()}"
        checklists = checklists.map { if (it.id == c.id) it.copy(done = if (done) it.done + k else it.done - k) else it }
        send("/house/checklist", JSONObject().put("check", JSONObject().put("id", c.id).put("step", step.text).put("who", who).put("done", done)))
    }

    // meals
    /** Pin a meal as a favorite, or (false) take it off the choices. */
    fun favorite(text: String, pinned: Boolean = true) {
        favorites = if (pinned) listOf(HouseFavorite(text, true)) + favorites.filter { !it.text.equals(text, true) } else favorites.filter { !it.text.equals(text, true) }
        send("/house/meal", JSONObject().put("favorite", text).put("value", pinned))
    }
    /** The assistant puts what that meal needs on Groceries (see [mealWork]). */
    fun addIngredients(date: String, meal: String = "dinner") {
        mealWork = mealWork + ("$date|$meal" to MealWork("working", emptyList(), null))
        send("/house/meal/ingredients", JSONObject().put("date", date).put("meal", meal))
    }

    // photos
    /** A photo's bytes (a JPEG) into the family's photos; blocking (call off the main thread). */
    fun addPhoto(bytes: ByteArray, name: String = "phone.jpg"): Boolean = runCatching {
        BridgeClient.open(bridge() + "/house/photo?name=" + URLEncoder.encode(name, "UTF-8")).run {
            requestMethod = "POST"; doOutput = true; connectTimeout = 3000; readTimeout = 20000
            setRequestProperty("content-type", "application/octet-stream"); setFixedLengthStreamingMode(bytes.size)
            outputStream.use { it.write(bytes) }; responseCode in 200..299
        }
    }.getOrDefault(false)
    /** A recipe's photo for a meal, for the assistant to type into the recipe box. */
    fun addRecipePhoto(bytes: ByteArray, meal: String): Boolean = runCatching {
        BridgeClient.open(bridge() + "/house/recipe-photo?meal=" + URLEncoder.encode(meal, "UTF-8")).run {
            requestMethod = "POST"; doOutput = true; connectTimeout = 3000; readTimeout = 20000
            setRequestProperty("content-type", "application/octet-stream"); setFixedLengthStreamingMode(bytes.size)
            outputStream.use { it.write(bytes) }; responseCode in 200..299
        }
    }.getOrDefault(false)
    /** One part of a video from the phone page (photos.html sends a video in parts: [Phone.videoPart]); the bridge
     *  puts them together and keeps it (/house/photo/part). */
    fun addVideoPart(id: String, n: Int, of: Int, name: String, bytes: ByteArray, off: Int): Boolean = runCatching {
        val q = "id=" + URLEncoder.encode(id, "UTF-8") + "&n=$n&of=$of&name=" + URLEncoder.encode(name, "UTF-8")
        BridgeClient.open(bridge() + "/house/photo/part?" + q).run {
            requestMethod = "POST"; doOutput = true; connectTimeout = 3000; readTimeout = 60000
            setRequestProperty("content-type", "application/octet-stream"); setFixedLengthStreamingMode(bytes.size - off)
            outputStream.use { it.write(bytes, off, bytes.size - off) }; responseCode in 200..299
        }
    }.getOrDefault(false)
    /** A flyer's photo, for the assistant to read into events (the bridge's /house/flyer). */
    fun addFlyer(bytes: ByteArray): Boolean = runCatching {
        BridgeClient.open(bridge() + "/house/flyer?name=flyer.jpg").run {
            requestMethod = "POST"; doOutput = true; connectTimeout = 3000; readTimeout = 20000
            setRequestProperty("content-type", "application/octet-stream"); setFixedLengthStreamingMode(bytes.size)
            outputStream.use { it.write(bytes) }; responseCode in 200..299
        }
    }.getOrDefault(false)
    /** A phone hand-off link through Android's share sheet (the shell opens it: an app's own package can't). */
    fun share(url: String) = send("/house/share", JSONObject().put("url", url))
    fun removePhoto(name: String) { photos = photos - name; send("/house/photo/remove", JSONObject().put("name", name)) }
    /** Night hours with no photos on the idle screen ("HH:MM"); null: photos all night. */
    fun setNight(from: String?, to: String?) {
        night = if (from == null || to == null) null else from to to
        send("/house/settings", JSONObject().put("night", if (from == null || to == null) false else JSONObject().put("from", from).put("to", to)))
    }
    /** The resting screen's settings ([part]: any of after, every, order, fit, show, calendar: bridge house/settings.js). */
    fun setResting(part: JSONObject) {
        if (part.has("after")) restAfter = part.optInt("after", restAfter)
        send("/house/settings", JSONObject().put("resting", part))
    }
    /** Whether an album's photos show on the resting screen. */
    fun albumOnRest(id: String, on: Boolean) = send("/house/photo/album", JSONObject().put("show", JSONObject().put("id", id).put("sleep", on)))
    /** The household's resting screen and albums now (GET /house: {resting, albums}); blocking, off the main thread. */
    fun restingNow(): JSONObject? = runCatching { JSONObject(get("/house")) }.getOrNull()
    /** Is it night now (by [night])? */
    fun isNight(now: Long = System.currentTimeMillis()): Boolean {
        val (a, b) = night ?: return false
        val c = java.util.Calendar.getInstance().apply { timeInMillis = now }
        val m = c.get(java.util.Calendar.HOUR_OF_DAY) * 60 + c.get(java.util.Calendar.MINUTE)
        fun min(s: String) = s.take(2).toIntOrNull()?.times(60)?.plus(s.takeLast(2).toIntOrNull() ?: 0) ?: 0
        val f = min(a); val t = min(b)
        return if (f <= t) m in f until t else m >= f || m < t
    }

    fun photoUrl(name: String) = bridge() + "/house/photo/" + URLEncoder.encode(name, "UTF-8").replace("+", "%20")

    // ---- plumbing ----
    /** A phone list page (a Handoff at base) reachable through the relay too, when the family turned that on
     *  (bridge/relay.js): {url, relay, token} for the page, or null. Blocking: call it off the main thread. */
    fun relayHandoff(base: String, minutes: Int): JSONObject? = runCatching {
        JSONObject(BridgeClient.post(bridge() + "/relay/handoff", JSONObject().put("base", base).put("minutes", minutes).toString(), 3000, 10000) ?: "{}")
    }.getOrNull()?.takeIf { it.has("token") && it.has("url") }

    private fun bridge(): String = runCatching { Openhouse.bridgeUrl }.getOrDefault("http://127.0.0.1:8787")
    private fun get(path: String): String = BridgeClient.open(bridge() + path).run {
        connectTimeout = 3000; readTimeout = 30000; inputStream.use { it.readBytes().toString(Charsets.UTF_8) }
    }
    private fun send(path: String, body: JSONObject) = scope.launch {
        val r = runCatching {
            BridgeClient.open(bridge() + path).run {
                requestMethod = "POST"; doOutput = true; connectTimeout = 3000; readTimeout = 15000
                setRequestProperty("content-type", "application/json")
                outputStream.use { it.write(body.toString().toByteArray()) }
                (if (responseCode < 400) inputStream else errorStream).use { it.readBytes().toString(Charsets.UTF_8) }
            }
        }.getOrNull()
        runCatching { JSONObject(r!!).optJSONObject("house") }.getOrNull()?.let { apply(it) }
    }

    private fun JSONObject.s(k: String) = optString(k).takeIf { has(k) && !isNull(k) && it.isNotEmpty() }
    private fun <T> JSONArray?.map(f: (JSONObject) -> T?): List<T> = this?.let { a -> (0 until a.length()).mapNotNull { a.optJSONObject(it)?.let(f) } } ?: emptyList()
    private fun JSONArray?.strings(): List<String> = this?.let { a -> (0 until a.length()).map { a.optString(it) } } ?: emptyList()
    private fun time(s: String?): Long? = s?.let { runCatching { java.time.Instant.parse(it).toEpochMilli() }.getOrNull() }

    private fun apply(j: JSONObject) {
        val nv = j.optInt("v")
        val fam = j.optJSONArray("family").map { it }.mapIndexed { i, p -> Person(p.optString("name"), p.optString("note"), Oh.people[i % Oh.people.size]) }
        val ls = j.optJSONArray("lists").map { l -> HouseList(l.optString("id"), l.optString("name"), l.optJSONArray("items").map { HouseItem(it.optString("id"), it.optString("text"), it.optBoolean("done"), it.s("who")) }) }
        val ch = j.optJSONArray("chores").map { HouseChore(it.optString("who"), it.optString("task"), it.optBoolean("today", true), it.optBoolean("done"), it.optInt("week"),
            it.optJSONArray("days")?.let { d -> (0 until d.length()).map { k -> d.optString(k) } } ?: emptyList()) }
        val ms = j.optJSONObject("meals")?.let { m -> m.keys().asSequence().associateWith { k -> m.optJSONObject(k)?.let { d -> d.keys().asSequence().associateWith { d.optString(it) } } ?: emptyMap() } } ?: emptyMap()
        val ev = j.optJSONArray("events").map { e -> time(e.s("start"))?.let { HouseEvent(e.s("id"), e.optString("title"), it, time(e.s("end")), e.optBoolean("allDay"), e.s("who"), e.s("place"), e.optBoolean("local"), e.s("repeat"), e.s("date")) } }
        val ph = j.optJSONArray("photos").strings()
        val st = j.optJSONObject("stars")?.let { o -> o.keys().asSequence().associateWith { o.optInt(it) } } ?: emptyMap()
        val rw = j.optJSONArray("rewards").map { HouseReward(it.optString("id"), it.optString("title"), it.optInt("stars"), it.s("who")) }
        val ak = j.optJSONArray("asks").map { HouseAsk(it.optString("id"), it.optString("who"), it.optString("reward"), it.optString("title"), it.optInt("stars"), it.optBoolean("manual")) }
        val gt = j.optJSONArray("got").map { HouseGot(it.optString("who"), it.optString("title"), it.optInt("stars")) }
        val cl = j.optJSONArray("checklists").map { c -> HouseChecklist(c.optString("id"), c.optString("name"), c.optJSONArray("who").strings(), c.optString("from"), c.optString("to"),
            c.optJSONArray("days").strings(), c.optJSONArray("steps").map { HouseStep(it.optString("text"), it.optString("pic", "star")) }, c.optBoolean("now"), c.optJSONArray("done").strings().toSet()) }
        val fv = j.optJSONArray("favorites").map { HouseFavorite(it.optString("text"), it.optBoolean("pinned")) }
        val mw = j.optJSONObject("mealWork")?.let { o -> o.keys().asSequence().associateWith { k -> o.optJSONObject(k)!!.let { MealWork(it.optString("state"), it.optJSONArray("added").strings(), it.s("text")) } } } ?: emptyMap()
        val nt = j.optJSONObject("night")?.let { it.optString("from") to it.optString("to") }
        val ra = j.optJSONObject("resting")?.optInt("after", 8) ?: 8
        val rm = j.optJSONArray("reminders").map { r -> time(r.s("start"))?.let { HouseReminder(r.optString("key"), r.optString("title"), it, r.s("who"), r.s("place")) } }
        main.post {
            if (nv >= v) v = nv
            today = j.optString("today"); family = fam; lists = ls; chores = ch; meals = ms; events = ev; calendars = j.optInt("calendars"); photos = ph
            stars = st; rewards = rw; asks = ak; got = gt; checklists = cl; favorites = fv; mealWork = mw; night = nt; restAfter = ra; ai = j.optBoolean("ai"); loaded = true
            reminders = rm; remindAloud = j.optBoolean("remindAloud"); calendarLock = j.optBoolean("calendarLock"); Openhouse.reminded(rm)
        }
    }

    // ---- photos: decoded at about screen size (a phone photo is far bigger), a few kept ----
    private val bitmaps = LruCache<String, ImageBitmap>(4)
    internal suspend fun photo(name: String, maxPx: Int = 1600): ImageBitmap? = bitmaps.get(name) ?: withContext(Dispatchers.IO) {
        runCatching {
            val bytes = BridgeClient.open(photoUrl(name)).run { connectTimeout = 3000; readTimeout = 20000; inputStream.use { it.readBytes() } }
            val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }; BitmapFactory.decodeByteArray(bytes, 0, bytes.size, o)
            var sample = 1; while (o.outWidth / (sample * 2) >= maxPx || o.outHeight / (sample * 2) >= maxPx) sample *= 2
            var b = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample }) ?: return@runCatching null
            val turn = runCatching { when (android.media.ExifInterface(bytes.inputStream()).getAttributeInt(android.media.ExifInterface.TAG_ORIENTATION, 1)) { 6 -> 90f; 3 -> 180f; 8 -> 270f; else -> 0f } }.getOrDefault(0f)
            if (turn != 0f) b = Bitmap.createBitmap(b, 0, 0, b.width, b.height, android.graphics.Matrix().apply { postRotate(turn) }, true)
            b.asImageBitmap().also { bitmaps.put(name, it) }
        }.getOrNull()
    }
}

/** One of the family's photos. */
@Composable
fun HousePhoto(name: String, modifier: Modifier = Modifier, scale: ContentScale = ContentScale.Crop) {
    val img by produceState<ImageBitmap?>(null, name) { value = House.photo(name) }
    img?.let { Image(it, null, modifier, contentScale = scale) } ?: Box(modifier.background(Color(0xFF26241F)))
}

/** The family's photos one at a time, crossfading every [seconds] (newest first, then shuffled). [overlay] draws on top. */
@Composable
fun PhotoSlideshow(modifier: Modifier = Modifier, seconds: Int = 12, overlay: @Composable () -> Unit = {}) {
    LaunchedEffect(Unit) { House.start() }
    val all = House.photos
    var i by remember { mutableStateOf(0) }
    val order = remember(all) { all.take(1) + all.drop(1).shuffled() }
    LaunchedEffect(order) { while (order.size > 1) { delay(seconds * 1000L); House.photo(order[(i + 1) % order.size]); i = (i + 1) % order.size } }
    Box(modifier.background(Color.Black)) {
        Crossfade(order.getOrNull(i % maxOf(1, order.size)), animationSpec = tween(1200), label = "photo") { n ->
            if (n != null) HousePhoto(n, Modifier.fillMaxSize(), ContentScale.Crop)
        }
        overlay()
    }
}

/**
 * Asks for a few words with the on-screen keyboard (an item for a list, a chore, a meal), on a card over the app.
 * [extra]: more choices under the field (whose it is, which day). Done or the keyboard's Done key saves.
 */
@Composable
fun TextAsk(title: String, initial: String = "", hint: String = "", onCancel: () -> Unit, extra: @Composable () -> Unit = {}, onDone: (String) -> Unit) {
    var text by remember { mutableStateOf(androidx.compose.ui.text.input.TextFieldValue(initial, androidx.compose.ui.text.TextRange(initial.length))) }
    val focus = remember { androidx.compose.ui.focus.FocusRequester() }
    val keyboard = androidx.compose.ui.platform.LocalSoftwareKeyboardController.current
    LaunchedEffect(Unit) { delay(150); runCatching { focus.requestFocus() }; keyboard?.show() }
    val done = { keyboard?.hide(); onDone(text.text.trim()) }
    Box(Modifier.fillMaxSize().background(Color(0x99000000)).clickable(interactionSource = remember { androidx.compose.foundation.interaction.MutableInteractionSource() }, indication = null) { keyboard?.hide(); onCancel() },
        contentAlignment = androidx.compose.ui.Alignment.TopCenter) {
        androidx.compose.foundation.layout.Column(
            Modifier.padding(top = 70.u).width(fit(820.u)).clip(androidx.compose.foundation.shape.RoundedCornerShape(30.u)).background(PaperLook.paper)
                .clickable(interactionSource = remember { androidx.compose.foundation.interaction.MutableInteractionSource() }, indication = null) {}
                .padding(horizontal = 36.u, vertical = 30.u),
            verticalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(22.u),
        ) {
            androidx.compose.material3.Text(title, style = roundText(34, androidx.compose.ui.text.font.FontWeight.ExtraBold))
            Box(Modifier.fillMaxWidth().clip(androidx.compose.foundation.shape.RoundedCornerShape(18.u)).background(Color.White)
                .border(2.u, PaperLook.ink.copy(alpha = .15f), androidx.compose.foundation.shape.RoundedCornerShape(18.u)).padding(horizontal = 24.u, vertical = 18.u)) {
                if (text.text.isEmpty() && hint.isNotEmpty()) androidx.compose.material3.Text(hint, style = roundText(36, androidx.compose.ui.text.font.FontWeight.SemiBold, PaperLook.inkSoft.copy(alpha = .6f)))
                androidx.compose.foundation.text.BasicTextField(text, { text = it }, Modifier.fillMaxWidth().focusRequester(focus), singleLine = true,
                    textStyle = roundText(36, androidx.compose.ui.text.font.FontWeight.SemiBold),
                    keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(capitalization = androidx.compose.ui.text.input.KeyboardCapitalization.Sentences, imeAction = androidx.compose.ui.text.input.ImeAction.Done),
                    keyboardActions = androidx.compose.foundation.text.KeyboardActions(onDone = { done() }))
            }
            extra()
            androidx.compose.foundation.layout.Row(Modifier.fillMaxWidth(), horizontalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(16.u, androidx.compose.ui.Alignment.End)) {
                BigButton("Cancel", primary = false) { keyboard?.hide(); onCancel() }
                BigButton("Done", enabled = text.text.isNotBlank()) { done() }
            }
        }
    }
}

/** A big rounded button in the home screen's print type. */
@Composable
fun BigButton(label: String, modifier: Modifier = Modifier, primary: Boolean = true, enabled: Boolean = true, color: Color = PaperLook.ink, onClick: () -> Unit) {
    Box(modifier.height(84.u).clip(androidx.compose.foundation.shape.RoundedCornerShape(42.u)).background(if (primary) color.copy(alpha = if (enabled) 1f else .35f) else PaperLook.ink.copy(alpha = .08f))
        .clickable(enabled = enabled, onClick = onClick).padding(horizontal = 40.u), contentAlignment = androidx.compose.ui.Alignment.Center) {
        androidx.compose.material3.Text(label, style = roundText(28, androidx.compose.ui.text.font.FontWeight.ExtraBold, if (primary) Color.White else PaperLook.ink), maxLines = 1)
    }
}

/** A choice chip in the home screen's print type; [dot]: a person's color. */
@Composable
fun ChoiceChip(label: String, selected: Boolean, dot: Color? = null, onClick: () -> Unit) {
    androidx.compose.foundation.layout.Row(Modifier.height(70.u).clip(androidx.compose.foundation.shape.RoundedCornerShape(35.u))
        .background(if (selected) PaperLook.ink else PaperLook.ink.copy(alpha = .07f)).clickable(onClick = onClick).padding(horizontal = 26.u),
        verticalAlignment = androidx.compose.ui.Alignment.CenterVertically, horizontalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(12.u)) {
        if (dot != null) Box(Modifier.size(22.u).clip(androidx.compose.foundation.shape.CircleShape).background(dot))
        androidx.compose.material3.Text(label, style = roundText(24, androidx.compose.ui.text.font.FontWeight.Bold, if (selected) Color.White else PaperLook.ink), maxLines = 1)
    }
}

/**
 * A routine step's picture, drawn flat (no emoji, no words), so kids who can't read yet know the step:
 * "sun", "moon", "shirt", "teeth", "shoes", "backpack", "bed", "bath", "book", "plate", "hands", "hair", "toys", "cup", "coat", "pet", "star".
 */
@Composable
fun StepPicture(pic: String, modifier: Modifier = Modifier) {
    androidx.compose.foundation.Canvas(modifier) {
        val k = size.minDimension / 100f
        withTransform({ translate((size.width - 100 * k) / 2, (size.height - 100 * k) / 2); scale(k, k, androidx.compose.ui.geometry.Offset.Zero) }) { Pics.draw(this, pic) }
    }
}

private object Pics {
    private val ink = Color(0xFF2B2A28); private val blue = Color(0xFF5B8DEF); private val red = Color(0xFFE5604D); private val yellow = Color(0xFFF4C542)
    private val green = Color(0xFF5DBB7E); private val brown = Color(0xFFB07A4F); private val pink = Color(0xFFF29BB6); private val water = Color(0xFF9CCBF5)
    private val orange = Color(0xFFF2994A); private val white = Color.White
    private fun o(x: Float, y: Float) = androidx.compose.ui.geometry.Offset(x, y)
    private fun sz(w: Float, h: Float) = androidx.compose.ui.geometry.Size(w, h)
    private fun cr(r: Float) = androidx.compose.ui.geometry.CornerRadius(r, r)
    private fun line(vararg p: Float) = androidx.compose.ui.graphics.Path().apply { moveTo(p[0], p[1]); var i = 2; while (i < p.size) { lineTo(p[i], p[i + 1]); i += 2 }; close() }
    private val thin = androidx.compose.ui.graphics.drawscope.Stroke(4f, cap = androidx.compose.ui.graphics.StrokeCap.Round, join = androidx.compose.ui.graphics.StrokeJoin.Round)
    private fun androidx.compose.ui.graphics.drawscope.DrawScope.box(c: Color, x: Float, y: Float, w: Float, h: Float, r: Float = 6f, outline: Boolean = false) {
        drawRoundRect(c, o(x, y), sz(w, h), cr(r)); if (outline) drawRoundRect(ink, o(x, y), sz(w, h), cr(r), style = thin)
    }
    private fun androidx.compose.ui.graphics.drawscope.DrawScope.stroke(c: Color, x1: Float, y1: Float, x2: Float, y2: Float, w: Float = 5f) =
        drawLine(c, o(x1, y1), o(x2, y2), w, androidx.compose.ui.graphics.StrokeCap.Round)

    fun draw(d: androidx.compose.ui.graphics.drawscope.DrawScope, pic: String) = with(d) {
        when (pic) {
            "sun" -> { for (i in 0 until 8) { val a = Math.toRadians(i * 45.0); stroke(orange, 50 + 30 * Math.cos(a).toFloat(), 50 + 30 * Math.sin(a).toFloat(), 50 + 42 * Math.cos(a).toFloat(), 50 + 42 * Math.sin(a).toFloat(), 7f) }
                drawCircle(yellow, 22f, o(50f, 50f)) }
            "moon" -> { val p = androidx.compose.ui.graphics.Path().apply { op(androidx.compose.ui.graphics.Path().apply { addOval(androidx.compose.ui.geometry.Rect(18f, 18f, 82f, 82f)) },
                    androidx.compose.ui.graphics.Path().apply { addOval(androidx.compose.ui.geometry.Rect(36f, 8f, 96f, 68f)) }, androidx.compose.ui.graphics.PathOperation.Difference) }
                drawPath(p, yellow); drawCircle(yellow, 4f, o(80f, 78f)); drawCircle(yellow, 3f, o(88f, 64f)) }
            "shirt", "coat" -> { val c = if (pic == "coat") orange else blue; val bottom = if (pic == "coat") 90f else 84f; val cuff = if (pic == "coat") 70f else 48f
                drawPath(line(30f, 20f, 42f, 16f, 50f, 24f, 58f, 16f, 70f, 20f, 90f, 36f, 80f, cuff, 70f, 42f, 70f, bottom, 30f, bottom, 30f, 42f, 20f, cuff, 10f, 36f), c)
                if (pic == "coat") { stroke(ink.copy(alpha = .5f), 50f, 26f, 50f, 90f, 3f); drawCircle(white, 3f, o(58f, 50f)); drawCircle(white, 3f, o(58f, 66f)) } }
            "teeth" -> { box(blue, 6f, 62f, 66f, 12f, 6f); box(blue, 60f, 56f, 34f, 18f, 7f) // handle and head
                box(white, 62f, 38f, 30f, 18f, 4f, outline = true); for (i in 0 until 4) stroke(water, 68f + i * 6f, 42f, 68f + i * 6f, 54f, 3f) // bristles
                drawPath(androidx.compose.ui.graphics.Path().apply { moveTo(60f, 34f); cubicTo(66f, 22f, 76f, 30f, 80f, 24f); cubicTo(86f, 30f, 92f, 26f, 96f, 34f); close() }, water) } // paste
            "shoes" -> { drawPath(line(14f, 66f, 14f, 38f, 34f, 38f, 52f, 54f, 84f, 58f, 90f, 66f), red); box(white, 10f, 64f, 82f, 12f, 6f, outline = true)
                for (i in 0 until 3) stroke(white, 30f + i * 7f, 44f + i * 4f, 38f + i * 7f, 44f + i * 4f, 3f) }
            "backpack" -> { drawArc(ink, 180f, 180f, false, o(36f, 14f), sz(28f, 24f), style = androidx.compose.ui.graphics.drawscope.Stroke(5f))
                box(green, 24f, 24f, 52f, 64f, 16f); box(Color(0xFF3F9A61), 33f, 56f, 34f, 24f, 8f); stroke(white, 40f, 62f, 60f, 62f, 3f) }
            "bed" -> { box(brown, 10f, 30f, 8f, 54f, 3f); box(brown, 84f, 50f, 8f, 34f, 3f); box(white, 16f, 54f, 72f, 14f, 4f, outline = true)
                box(blue, 40f, 46f, 50f, 22f, 6f); box(white, 20f, 42f, 22f, 12f, 6f, outline = true) }
            "bath" -> { for ((x, y, r) in listOf(Triple(34f, 34f, 8f), Triple(50f, 26f, 6f), Triple(62f, 36f, 9f), Triple(44f, 42f, 5f))) { drawCircle(water, r, o(x, y)); drawCircle(ink, r, o(x, y), style = thin) }
                box(water, 12f, 46f, 76f, 10f, 4f); box(white, 10f, 50f, 80f, 26f, 12f, outline = true); stroke(ink, 22f, 76f, 18f, 86f); stroke(ink, 78f, 76f, 82f, 86f) }
            "book" -> { drawPath(line(50f, 26f, 14f, 20f, 14f, 76f, 50f, 82f), blue); drawPath(line(50f, 26f, 86f, 20f, 86f, 76f, 50f, 82f), red)
                stroke(ink, 50f, 26f, 50f, 82f, 3f); for (i in 0 until 3) { stroke(white, 22f, 36f + i * 10f, 42f, 39f + i * 10f, 3f); stroke(white, 58f, 39f + i * 10f, 78f, 36f + i * 10f, 3f) } }
            "plate" -> { drawCircle(white, 30f, o(50f, 52f)); drawCircle(ink, 30f, o(50f, 52f), style = thin); drawCircle(ink.copy(alpha = .25f), 19f, o(50f, 52f), style = thin)
                stroke(ink, 10f, 40f, 10f, 84f, 4f); for (x in listOf(6f, 10f, 14f)) stroke(ink, x, 22f, x, 40f, 3f); box(ink, 86f, 22f, 6f, 62f, 3f) }
            "hands" -> { for ((x, y, r) in listOf(Triple(36f, 36f, 9f), Triple(56f, 28f, 7f), Triple(66f, 44f, 10f), Triple(46f, 48f, 6f))) { drawCircle(water, r, o(x, y)); drawCircle(ink, r, o(x, y), style = thin) }
                box(pink, 22f, 56f, 56f, 26f, 10f, outline = true); stroke(white, 32f, 64f, 52f, 64f, 4f) }
            "hair" -> { box(orange, 14f, 36f, 72f, 16f, 6f); for (i in 0 until 10) stroke(orange, 19f + i * 7f, 50f, 19f + i * 7f, 72f, 4f) }
            "toys" -> { drawCircle(red, 15f, o(36f, 38f)); box(blue, 52f, 26f, 26f, 26f, 4f); box(brown, 14f, 50f, 72f, 36f, 6f); box(Color(0xFF8E5D38), 14f, 50f, 72f, 8f, 4f) }
            "cup" -> { drawPath(line(30f, 44f, 70f, 44f, 66f, 86f, 34f, 86f), water); drawPath(line(26f, 18f, 74f, 18f, 66f, 86f, 34f, 86f), ink, style = thin) }
            "pet" -> { drawOval(brown, o(28f, 48f), sz(44f, 36f)); for ((x, y) in listOf(20f to 38f, 36f to 20f, 58f to 20f, 76f to 38f)) drawOval(brown, o(x - 9f, y - 11f), sz(18f, 22f)) }
            else -> { val p = androidx.compose.ui.graphics.Path().apply { for (i in 0 until 10) { val a = Math.toRadians(-90.0 + i * 36); val r = if (i % 2 == 0) 42f else 18f
                    val x = 50 + r * Math.cos(a).toFloat(); val y = 54 + r * Math.sin(a).toFloat(); if (i == 0) moveTo(x, y) else lineTo(x, y) }; close() }
                drawPath(p, yellow) }
        }
    }
}
