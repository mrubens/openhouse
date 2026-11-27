package dev.openhouse.ui

// What the home board shows: plain data. Openhouse holds the current values; read them in Compose and the board
// updates by itself.

import androidx.compose.ui.graphics.Color

data class Person(val name: String, val note: String, val color: Color)
data class CalEvent(val who: String, val title: String, val start: Long, val bring: String?)
data class Chore(val who: String, val task: String)
/** [screensaver]: its app.json says `"screensaver": true` (Photos): when nobody's around, the home screen shows the family's photos. */
data class AppInfo(val id: String, val name: String, val emoji: String, val icon: String? = null, val screensaver: Boolean = false)
data class TimerInfo(val id: Int, val label: String, val total: Int, val endAt: Long, val ringing: Boolean)
data class BoardData(
    val headline: String?, val weather: String?, val updatedAt: Long?, val curating: Boolean, val error: String?,
    val family: List<Person>, val events: List<CalEvent>, val chores: List<Chore>,
)
/** The answer being asked or just answered. `text` is prose + generated UI; show it with AnswerView. */
data class Answer(
    val question: String, val who: String?, val text: String = "", val live: Boolean = true, val status: String = "",
    val startedAt: Long = System.currentTimeMillis(), val ok: Boolean = false, val convo: String? = null, val at: Long = 0, val voice: Boolean = false,
    /** Notes on the home screen this answer put up or changed. */
    val notes: List<String> = emptyList(),
    /** Which turn this is (a newer conversation can take the screen while an older one finishes in the background). */
    val turnId: Long = System.nanoTime(),
    /** Stays up until it's tapped away or someone asks something else (a typed request's build that didn't work). */
    val stays: Boolean = false,
)

/** A note on the home screen: its shape on the home screen's grid ([size]: "2x1", cells across x down) and where it is. */
data class HomeNote(
    val id: String, val title: String, val content: String, val size: String, val paper: String?, val color: String?, val forWho: String?,
    val keep: Boolean, val until: Long?, val by: String, val conversation: String?, val at: Long,
    /** Where it is: its page (from 0) and its top-left cell (null: not placed yet). */
    val page: Int? = null, val col: Int? = null, val row: Int? = null,
    /** The assistant is refitting what's on it (after a resize). */
    val refitting: Boolean = false,
)
data class HomeCell(val x: Int, val y: Int, val w: Int, val h: Int, val what: String)
data class HomeData(val cols: Int, val rows: Int, val reserved: List<HomeCell>, val notes: List<HomeNote>, val v: Int,
    /** Where the family moved the clock ("clock"), the weather, the gear, app post-its ("app:<id>") and the home app's things ("own:<key>"), in u. */
    val places: Map<String, Place> = emptyMap(),
    /** Notes the family dragged to the trash (newest first): they can be put back. */
    val trash: List<TrashedNote> = emptyList(),
    /** Apps the display draws a widget for from the house's data, and the shape each starts at ("calendar" to "2x2"). */
    val nativeWidgets: Map<String, String> = emptyMap(),
    /** Widgets the assistant keeps for apps the family made, by app id. */
    val widgets: Map<String, AppWidget> = emptyMap())
/** An app's widget from its assistant: a layout like a note's, for every shape, or its own for some ([shapes], by "4x2"). */
data class AppWidget(val content: String?, val shapes: Map<String, String> = emptyMap())
/** A note in the trash, by its id and title. */
data class TrashedNote(val id: String, val title: String)
/** Something it's working on for someone, on screen or in the background: what they asked, and its own latest words. */
data class InFlight(val id: Long, val question: String, val who: String?, val status: String = "", val startedAt: Long = System.currentTimeMillis(), val convo: String? = null)
data class Weather(val place: String, val temp: Int, val code: Int, val condition: String, val isDay: Boolean, val high: Int, val low: Int,
    val feels: Int? = null, val humidity: Int? = null, val wind: Int? = null, val sunrise: String? = null, val sunset: String? = null,
    val hours: List<WeatherHour> = emptyList(), val days: List<WeatherDay> = emptyList())
data class WeatherHour(val time: String, val temp: Int, val code: Int, val isDay: Boolean, val rain: Int?)
data class WeatherDay(val date: String, val high: Int, val low: Int, val code: Int, val condition: String, val rain: Int?)
/** Where something that isn't a note sits on the home screen's grid (page from 0, its top-left cell, cells across and down; null: not yet), and whether it's in the trash. */
data class Place(val page: Int = 0, val col: Int? = null, val row: Int? = null, val w: Int? = null, val h: Int? = null, val hidden: Boolean = false)
/** The agent making or changing something: its steps as they happen, then what it did. */
data class Build(
    val request: String, val who: String?, val startedAt: Long, val stage: String = "Starting", val plan: String? = null,
    val steps: List<String> = emptyList(), val live: String? = null, val done: Boolean = false, val ok: Boolean = true,
    val summary: String? = null, val endedAt: Long = 0, val app: String? = null,
    /** Made, and open to try with its bar to keep it or not (nothing more is being made). */
    val waiting: Boolean = false,
)
data class Turn(val role: String, val text: String, val who: String? = null, val live: Boolean = false, val status: String = "", val ok: Boolean = true, val notes: List<TurnNote> = emptyList())
/** A note an answer put on the home screen, as it was then (it may have changed or come down since). */
data class TurnNote(val id: String, val title: String, val content: String)
data class Conversation(val id: String?, val turns: List<Turn>)
data class ConversationInfo(val id: String, val title: String, val updated: Long, val who: String?)
data class Heard(val who: String?, val text: String, val at: Long)
data class VoiceStatus(val ready: Boolean, val listening: Boolean, val error: String?, val wake: List<String> = listOf("hey opie"), val wakeOn: Boolean = false)
/** A voice the display can speak with: the engine's name for it, and what the picker calls it ("American 2"). */
data class SpeechVoice(val name: String, val label: String)
