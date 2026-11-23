package dev.harbor.rigcaller;

import android.app.Activity;
import android.app.ActivityOptions;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.widget.TextView;

/** The test caller's one screen. Started with the extra `link` (a harbor:// link), it opens that
 *  link as Capacitor's Bridge does for `window.location.href = link`: `new Intent(ACTION_VIEW,
 *  uri)` and startActivity from this Activity, no ActivityOptions; with the extra `share` true,
 *  Android 14's ActivityOptions.setShareIdentityEnabled(true) as well. Logs "RIGCALLER resumed"
 *  whenever it comes to the front (Harbor stepped back to it). */
public class Open extends Activity {
    static final String TAG = "harbor-rigcaller";

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        TextView t = new TextView(this);
        t.setText("Shift Planner (a test app)");
        t.setTextSize(22);
        t.setPadding(48, 160, 48, 48);
        setContentView(t);
        go(getIntent());
    }

    @Override
    protected void onNewIntent(Intent i) {
        super.onNewIntent(i);
        go(i);
    }

    @Override
    protected void onResume() {
        super.onResume();
        Log.i(TAG, "RIGCALLER resumed");
    }

    private void go(Intent i) {
        String link = i.getStringExtra("link");
        if (link == null) return;
        boolean share = i.getBooleanExtra("share", false);
        Intent v = new Intent(Intent.ACTION_VIEW, Uri.parse(link));
        Log.i(TAG, "RIGCALLER opens " + link + (share ? " sharing its identity" : " (plain startActivity)"));
        if (share && Build.VERSION.SDK_INT >= 34) startActivity(v, ActivityOptions.makeBasic().setShareIdentityEnabled(true).toBundle());
        else startActivity(v);
    }
}
