package dev.openhouse.ui

// One web page over the screen (a recipe's own page, from its credit): the display otherwise never leaves for another
// site, so this is the only way out, and it's narrow: https only, no address bar, links that go to another site don't
// open, no new windows, no downloads, nothing of the household's reachable from it. Done closes it.

import android.annotation.SuppressLint
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.viewinterop.AndroidView

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun WebPage(url: String, onClose: () -> Unit) {
    val host = remember(url) { runCatching { java.net.URI(url).host.orEmpty().lowercase() }.getOrDefault("") }
    val site = host.removePrefix("www.")
    if (!url.startsWith("https://") || site.isEmpty()) { LaunchedEffect(Unit) { onClose() }; return }
    // the same site: its own host or one under it (www., m.)
    val sameSite = { u: String -> runCatching { java.net.URI(u).let { it.scheme == "https" && (it.host.orEmpty().lowercase().let { h -> h == site || h.endsWith(".$site") }) } }.getOrDefault(false) }
    var view by remember { mutableStateOf<WebView?>(null) }
    DisposableEffect(Unit) { onDispose { view?.apply { stopLoading(); destroy() } } }
    Column(Modifier.fillMaxSize().background(PaperLook.paper)) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 36.u, vertical = 20.u), verticalAlignment = Alignment.CenterVertically) {
            Text(site, style = roundText(26, FontWeight.SemiBold, PaperLook.inkSoft), modifier = Modifier.weight(1f))
            BigButton("Done") { onClose() }
        }
        AndroidView(modifier = Modifier.fillMaxWidth().weight(1f), factory = { ctx ->
            WebView(ctx).apply {
                settings.javaScriptEnabled = true // (recipe pages need it to show anything)
                settings.domStorageEnabled = true
                settings.allowFileAccess = false
                settings.allowContentAccess = false
                settings.setGeolocationEnabled(false)
                settings.setSupportMultipleWindows(false)
                settings.javaScriptCanOpenWindowsAutomatically = false
                webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(v: WebView, r: WebResourceRequest) = !sameSite(r.url.toString())
                    // Its renderer went (the app's one, shared with the home screen): answered, so the app lives on; the
                    // page closes (dev.openhouse.shell.RendererGone).
                    override fun onRenderProcessGone(v: WebView, d: android.webkit.RenderProcessGoneDetail?): Boolean {
                        android.util.Log.e("WebPage", "$site: the page's renderer went (${if (d?.didCrash() == true) "crashed" else "stopped by the system"})")
                        if (view === v) view = null
                        runCatching { (v.parent as? android.view.ViewGroup)?.removeView(v); v.destroy() }
                        onClose(); return true
                    }
                }
                setDownloadListener { _, _, _, _, _ -> } // (nothing downloads)
                loadUrl(url)
                view = this
            }
        })
    }
}
