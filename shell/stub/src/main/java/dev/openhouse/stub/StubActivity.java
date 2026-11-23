package dev.openhouse.stub;

import android.app.Activity;
import android.content.Context;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.Bundle;
import android.view.Gravity;
import android.widget.TextView;

/**
 * One family app, installed as its own Android app (own icon, task and back gesture). Everything
 * it does lives in the display's code: it loads dev.openhouse.shell's classes and hands itself to
 * AppWindow, which hot-reloads the app's latest build (Kotlin dex or the dev server's web page).
 */
public class StubActivity extends Activity {
    /** The display's package: the app's code is compiled against its resources (Compose's R ids are its), so serve those. */
    private Context shell;
    @Override public android.content.res.Resources getResources() { return shell != null ? shell.getResources() : super.getResources(); }
    @Override public android.content.res.AssetManager getAssets() { return shell != null ? shell.getAssets() : super.getAssets(); }

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        try {
            String id = getPackageManager().getApplicationInfo(getPackageName(), PackageManager.GET_META_DATA).metaData.getString("openhouse.app");
            shell = createPackageContext(BuildConfig.DISPLAY_PKG, Context.CONTEXT_INCLUDE_CODE | Context.CONTEXT_IGNORE_SECURITY);
            shell.getClassLoader().loadClass("dev.openhouse.shell.AppWindow")
                .getMethod("attach", Activity.class, Context.class, String.class).invoke(null, this, shell, id);
        } catch (Throwable t) {
            shell = null;
            TextView v = new TextView(this);
            v.setText("This app needs the openhouse display.\n" + t);
            v.setTextColor(Color.WHITE); v.setBackgroundColor(Color.BLACK); v.setTextSize(22); v.setGravity(Gravity.CENTER);
            setContentView(v);
        }
    }
}
