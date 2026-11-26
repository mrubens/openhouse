package dev.openhouse.shell

/**
 * The tablets this release was tested on: the models marked Works in docs/tablets.md, by the start of Android's model
 * name (Build.MODEL; a region's letter can follow, as in SM-X520N). On any other tablet Welcome and Settings → Advanced
 * say, quietly, that we haven't tested it. Nothing is ever blocked. Add a model here only when it moves to Works there.
 */
object Tablets {
    private val works = listOf(
        "SM-X520", // Samsung Galaxy Tab S10 FE, Wi-Fi
    )

    val model: String get() = android.os.Build.MODEL.orEmpty()

    val tested: Boolean get() = model.isNotBlank() && works.any { model.uppercase().startsWith(it) }
}
