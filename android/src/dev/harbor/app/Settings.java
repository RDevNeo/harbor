package dev.harbor.app;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONObject;

/** One hub's page: this app's version and its Update button (when the hub serves a newer
 *  APK), the hub's address and version, rename and unpair. */
public class Settings extends Base {
    private TextView updateBtn, updateNote, hubInfo;
    private long available;

    static long myCode(Context c) {
        try {
            PackageInfo p = c.getPackageManager().getPackageInfo(c.getPackageName(), 0);
            return Build.VERSION.SDK_INT >= 28 ? p.getLongVersionCode() : p.versionCode;
        } catch (Exception e) {
            return 0;
        }
    }

    static String myName(Context c) {
        try { return c.getPackageManager().getPackageInfo(c.getPackageName(), 0).versionName; } catch (Exception e) { return "?"; }
    }

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        if (noHub()) return;
        LinearLayout root = frame("Settings", true);
        sub(hub.label(), Ui.G700);
        ScrollView sv = new ScrollView(this);
        LinearLayout col = Ui.col(this);
        col.setPadding(Ui.dp(16), 0, Ui.dp(16), Ui.dp(24));
        sv.addView(col);
        root.addView(sv, new LinearLayout.LayoutParams(-1, 0, 1));

        col.addView(head("App"));
        col.addView(Ui.text(this, "Harbor for Android " + myName(this) + " (" + myCode(this) + ")", 15, Ui.FG));
        updateNote = Ui.text(this, "Checking for updates…", 13, Ui.G700);
        col.addView(updateNote, Ui.margins(Ui.fill(), 0, 4, 0, 0));
        updateBtn = Ui.button(this, "Update", true, v -> update());
        updateBtn.setVisibility(View.GONE);
        col.addView(updateBtn, Ui.margins(Ui.fill(), 0, 12, 0, 0));

        col.addView(head("This PC"));
        hubInfo = Ui.text(this, hub.host + ":" + hub.port, 15, Ui.FG);
        col.addView(hubInfo);
        col.addView(Ui.button(this, "Rename", false, v -> rename()), Ui.margins(Ui.fill(), 0, 12, 0, 0));
        TextView unpair = Ui.button(this, "Unpair", false, v -> unpair());
        unpair.setTextColor(Ui.RED);
        col.addView(unpair, Ui.margins(Ui.fill(), 0, 8, 0, 0));
        col.addView(Ui.text(this, "Unpairing forgets the token here. Revoke it on the PC in Settings › Phones.", 12, Ui.G700),
                Ui.margins(Ui.fill(), 0, 6, 0, 0));
    }

    private TextView head(String s) {
        TextView t = Ui.bold(this, s, 13, Ui.G700);
        t.setPadding(0, Ui.dp(20), 0, Ui.dp(8));
        return t;
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (hub == null) return;
        Ui.pool.execute(() -> {
            String info, note; long code = 0;
            try {
                JSONObject st = hub.state();
                info = hub.host + ":" + hub.port + "\nHarbor " + st.optString("version");
                JSONObject app = hub.get("/v1/app");
                code = app.optLong("version_code");
                long mine = myCode(this);
                note = code <= 0 ? "This PC has no app build to offer."
                        : code > mine ? "Version " + name(code) + " is ready on this PC."
                        : "Up to date.";
            } catch (Exception e) {
                info = hub.host + ":" + hub.port + "\n" + Hub.why(e);
                note = "Can't check for updates: " + Hub.why(e);
            }
            final String fi = info, fn = note; final long fc = code;
            Ui.main.post(() -> {
                if (isFinishing()) return;
                hubInfo.setText(fi);
                updateNote.setText(fn);
                available = fc;
                updateBtn.setText("Update to " + name(fc));
                updateBtn.setVisibility(fc > myCode(this) ? View.VISIBLE : View.GONE);
            });
        });
    }

    /** 7001 -> 0.7.1 (android/build.sh: major*1000000 + minor*1000 + patch). */
    static String name(long code) {
        return (code / 1000000) + "." + (code / 1000 % 1000) + "." + (code % 1000);
    }

    private void update() {
        if (!getPackageManager().canRequestPackageInstalls()) {
            Ui.dialog(this).setTitle("Allow Harbor to install updates")
                    .setMessage("Android asks once: turn on “Allow from this source” for Harbor, then come back and tap Update.")
                    .setNegativeButton("Cancel", null)
                    .setPositiveButton("Open settings", (d, w) -> startActivity(new Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                            Uri.parse("package:" + getPackageName()))))
                    .show();
            return;
        }
        updateBtn.setEnabled(false);
        updateBtn.setAlpha(0.5f);
        updateNote.setText("Downloading…");
        Ui.pool.execute(() -> {
            String err = null;
            try {
                Update.install(getApplicationContext(), hub, (done, total) -> {
                    int pct = (int) (done * 100 / total);
                    Ui.main.post(() -> updateNote.setText("Downloading… " + pct + "%"));
                });
            } catch (Exception e) {
                err = Hub.why(e);
            }
            final String fe = err;
            Ui.main.post(() -> {
                updateBtn.setEnabled(true);
                updateBtn.setAlpha(1f);
                updateNote.setText(fe == null ? "Installing " + name(available) + "… Harbor restarts by itself." : "Update failed: " + fe);
            });
        });
    }

    private void rename() {
        EditText e = Ui.input(this, "Name", false);
        e.setText(hub.label());
        FrameLayout f = new FrameLayout(this);
        f.setPadding(Ui.dp(20), Ui.dp(8), Ui.dp(20), 0);
        f.addView(e);
        Ui.dialog(this).setTitle("Rename this PC").setView(f).setNegativeButton("Cancel", null)
                .setPositiveButton("Rename", (d, w) -> {
                    String n = e.getText().toString().trim();
                    if (n.isEmpty()) return;
                    hub.name = n;
                    Hub.put(this, hub);
                    sub(n, Ui.G700);
                }).show();
    }

    private void unpair() {
        Ui.dialog(this).setTitle("Unpair " + hub.label() + "?")
                .setMessage("This phone forgets the PC and its token. Chats stay on the PC.")
                .setNegativeButton("Cancel", null)
                .setPositiveButton("Unpair", (d, w) -> {
                    Hub.remove(this, hub.id);
                    startActivity(new Intent(this, Hubs.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP));
                    finish();
                }).show();
    }
}
