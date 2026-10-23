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

/** Settings, grouped in cards like the reference: this PC (switch PCs), the app and its
 *  update, the PC's address and version, color mode, pairing another PC, unpair. */
public class Settings extends Base {
    private TextView updateNote, hubVersion, badge;
    private View updateBtn;
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
        ScrollView sv = new ScrollView(this);
        LinearLayout col = Ui.col(this);
        col.setPadding(Ui.dp(14), Ui.dp(8), Ui.dp(14), Ui.dp(32));
        sv.addView(col);
        root.addView(sv, new LinearLayout.LayoutParams(-1, 0, 1));

        // This PC, with its Harbor version as a badge; tap to switch PCs.
        LinearLayout top = card(col);
        LinearLayout pc = Ui.cardRow(this, null, hub.label(), hub.host + ":" + hub.port, Ui.FG, v -> pcs());
        badge = Ui.bold(this, "", 13, Ui.ON_INK);
        badge.setPadding(Ui.dp(12), Ui.dp(5), Ui.dp(12), Ui.dp(5));
        badge.setBackground(Ui.round(Ui.INK, 0, 14));
        badge.setVisibility(View.GONE);
        pc.addView(badge, Ui.margins(Ui.wrap(), 8, 0, 4, 0));
        pc.addView(Ui.icon(this, Ui.I_DOWN, 20, Ui.FG), new LinearLayout.LayoutParams(Ui.dp(28), Ui.dp(28)));
        top.addView(pc, Ui.fill());

        LinearLayout app = card(col);
        LinearLayout updateRow = Ui.cardRow(this, Ui.I_DOWNLOAD, "Update", "Checking…", Ui.FG, null);
        updateNote = (TextView) ((LinearLayout) updateRow.getChildAt(1)).getChildAt(1);
        updateBtn = Ui.button(this, "Update", true, v -> update());
        updateBtn.setVisibility(View.GONE);
        updateRow.addView(updateBtn);
        app.addView(updateRow, Ui.fill());
        app.addView(Ui.gap(this));
        app.addView(Ui.cardRow(this, Ui.I_PHONE, "Harbor for Android", myName(this) + " (" + myCode(this) + ")", Ui.FG, null), Ui.fill());

        LinearLayout here = card(col);
        here.addView(Ui.cardRow(this, Ui.I_GLOBE, "Address", hub.host + ":" + hub.port, Ui.FG, null), Ui.fill());
        here.addView(Ui.gap(this));
        LinearLayout ver = Ui.cardRow(this, Ui.I_MONITOR, "Harbor on the PC", "…", Ui.FG, null);
        hubVersion = (TextView) ((LinearLayout) ver.getChildAt(1)).getChildAt(1);
        here.addView(ver, Ui.fill());
        here.addView(Ui.gap(this));
        LinearLayout rn = Ui.cardRow(this, Ui.I_PEN, "Rename", "on this phone only", Ui.FG, v -> rename());
        rn.addView(Ui.chevron(this));
        here.addView(rn, Ui.fill());

        LinearLayout look = card(col);
        LinearLayout cm = Ui.cardRow(this, Ui.I_MOON, "Color mode", Ui.modeLabel(this), Ui.FG, v -> colorMode());
        cm.addView(Ui.chevron(this));
        look.addView(cm, Ui.fill());

        LinearLayout more = card(col);
        LinearLayout pair = Ui.cardRow(this, Ui.I_PLUS, "Pair another PC", "Settings › Phones › Pair a phone on that PC", Ui.FG,
                v -> startActivity(new Intent(this, Hubs.class).putExtra("pair", true)));
        pair.addView(Ui.chevron(this));
        more.addView(pair, Ui.fill());

        LinearLayout bye = card(col);
        bye.addView(Ui.cardRow(this, Ui.I_PLUG, "Unpair", null, Ui.RED, v -> unpair()), Ui.fill());
        TextView note = Ui.text(this, "Unpairing forgets the token on this phone. Revoke it on the PC in Settings › Phones.", 13, Ui.G700);
        note.setPadding(Ui.dp(8), 0, Ui.dp(8), 0);
        col.addView(note);
    }

    private LinearLayout card(LinearLayout col) {
        LinearLayout c = Ui.card(this);
        col.addView(c, Ui.margins(Ui.fill(), 0, 0, 0, 14));
        return c;
    }

    private void colorMode() {
        java.util.List<Sheet.Option> o = new java.util.ArrayList<>();
        for (int i = 0; i < Ui.MODES.length; i++)
            o.add(new Sheet.Option(Ui.MODES[i], Ui.MODE_LABELS[i], i == 0 ? "follows the phone" : "", true));
        Sheet.pick(this, "Color mode", null, o, Ui.mode(this), m -> {
            Ui.prefs(this).edit().putString("color_mode", m).apply();
            Ui.themeGen++;
            recreate();
        });
    }

    private void pcs() {
        java.util.List<Sheet.Option> o = new java.util.ArrayList<>();
        for (Hub h : Hub.all(this)) o.add(new Sheet.Option(h.id, h.label(), h.host + ":" + h.port, true));
        Sheet.pick(this, "PCs", null, o, hub.id, id -> {
            if (id.equals(hub.id)) return;
            Hub.setLast(this, id);
            startActivity(new Intent(this, Hubs.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP));
            startActivity(new Intent(this, Chats.class).putExtra("hub", id));
            finish();
        });
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (hub == null) return;
        Ui.pool.execute(() -> {
            String info, note, version = ""; long code = 0;
            try {
                JSONObject st = hub.state();
                version = st.optString("version");
                info = "Harbor " + version;
                JSONObject app = hub.get("/v1/app");
                code = app.optLong("version_code");
                long mine = myCode(this);
                note = code <= 0 ? "This PC has no app build to offer"
                        : code > mine ? "Version " + name(code) + " is ready on this PC"
                        : "Up to date";
            } catch (Exception e) {
                info = Hub.why(e);
                note = "Can't check: " + Hub.why(e);
            }
            final String fi = info, fn = note, fv = version; final long fc = code;
            Ui.main.post(() -> {
                if (isFinishing()) return;
                hubVersion.setText(fi);
                updateNote.setText(fn);
                badge.setText(fv);
                badge.setVisibility(fv.isEmpty() ? View.GONE : View.VISIBLE);
                available = fc;
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
                updateNote.setText(fe == null ? "Installing " + name(available) + "… Harbor closes when it's done: open it again." : "Update failed: " + fe);
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
                    recreate();
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
