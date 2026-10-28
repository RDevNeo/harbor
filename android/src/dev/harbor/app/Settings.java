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
    private LinearLayout autoRow, whyRow;
    private long available;
    private boolean installing;

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
        LinearLayout updateRow = Ui.cardRow(this, Ui.I_DOWNLOAD, "Update", "Checking…", Ui.FG, v -> checkUpdates());
        updateNote = (TextView) ((LinearLayout) updateRow.getChildAt(1)).getChildAt(1);
        updateBtn = Ui.button(this, "Update", true, v -> update());
        updateBtn.setVisibility(View.GONE);
        updateRow.addView(updateBtn);
        Ui.wrapSub(updateRow, 3);
        app.addView(updateRow, Ui.fill());
        // Why the last automatic install didn't go in: Android's whole message (INSTALL_FAILED_…).
        whyRow = Ui.col(this);
        app.addView(whyRow, Ui.fill());
        app.addView(Ui.gap(this));
        autoRow = Ui.col(this);
        autoRows();
        app.addView(autoRow, Ui.fill());
        app.addView(Ui.gap(this));
        app.addView(Ui.cardRow(this, Ui.I_PHONE, "Harbor for Android", myName(this) + " (" + myCode(this) + ")", Ui.FG, null), Ui.fill());
        app.addView(Ui.gap(this));
        app.addView(Ui.cardRow(this, Ui.I_GAUGE, "Usage", "Tokens and cost by project and day", Ui.FG, v -> usage()), Ui.fill());

        LinearLayout here = card(col);
        here.addView(Ui.cardRow(this, Ui.I_GLOBE, "Address", hub.host + ":" + hub.port, Ui.FG, null), Ui.fill());
        here.addView(Ui.gap(this));
        // The keys this connection is encrypted with (compare the PC's with Settings › Devices there).
        String keys = (hub.fp.isEmpty() ? "PC key not known yet" : "PC " + shortFp(hub.fp)) + " · this phone " + shortFp(Net.myFp());
        here.addView(Ui.cardRow(this, Ui.I_LOCK, "Encrypted with", keys, Ui.FG, null), Ui.fill());
        here.addView(Ui.gap(this));
        // How this phone signs in to the PC: the factors the pairing has.
        int f = hub.factors();
        boolean lock = Presence.secureLock();
        String fs = f == 3 ? (lock ? "3 factors: this phone's key, the pairing secret and its screen lock"
                        : "3 factors, but the screen lock was removed: tap to go on with two")
                : f == 2 ? (lock ? "2 factors: the screen lock is added the next time Harbor connects"
                        : "2 factors: this phone has no screen lock. Set one (tap) to add the third.")
                : "Paired before three factors: upgrade it when the PC asks";
        boolean warn = f == 2 || (f == 3 && !lock);
        View.OnClickListener tap = f == 2 && !lock ? v -> Pair.openLockSettings(this) : f == 3 && !lock ? v -> Pair.offerLock(this, hub) : null;
        LinearLayout sign = Ui.cardRow(this, warn ? Ui.I_LOCK_OPEN : Ui.I_LOCK, "Sign-in", fs, warn ? Ui.AMBER : Ui.FG, tap);
        Ui.wrapSub(sign, 3);
        if (tap != null) sign.addView(Ui.chevron(this));
        here.addView(sign, Ui.fill());
        here.addView(Ui.gap(this));
        LinearLayout ver = Ui.cardRow(this, Ui.I_MONITOR, "Harbor on the PC", "…", Ui.FG, null);
        hubVersion = (TextView) ((LinearLayout) ver.getChildAt(1)).getChildAt(1);
        here.addView(ver, Ui.fill());
        here.addView(Ui.gap(this));
        LinearLayout rn = Ui.cardRow(this, Ui.I_PEN, "Rename", "on this phone only", Ui.FG, v -> rename());
        rn.addView(Ui.chevron(this));
        here.addView(rn, Ui.fill());

        // Who is who across the PCs, and whose instructions a chat run on another PC uses
        // (GET/PATCH /v1/people, hubs from 0.44; hidden on older ones).
        LinearLayout people = card(col);
        people.setVisibility(View.GONE);
        LinearLayout pr = Ui.cardRow(this, Ui.I_USERS, "People and memory", "Who is who, and your instructions on other PCs", Ui.FG, v -> people());
        pr.addView(Ui.chevron(this));
        people.addView(pr, Ui.fill());
        if (getIntent().getBooleanExtra("people", false)) people();
        // The "Harbor X is ready: tap to install" notification (Update.offer): the install, in
        // front, where Play Protect can ask to scan it.
        long install = getIntent().getLongExtra("install", 0);
        if (b == null && install > Settings.myCode(this)) {
            available = install;
            Ui.main.post(this::update);
        }
        Ui.pool.execute(() -> {
            try {
                hub.get("/v1/people");
                runOnUiThread(() -> people.setVisibility(View.VISIBLE));
            } catch (Exception e) { /* an older hub: no such call */ }
        });

        LinearLayout look = card(col);
        LinearLayout cm = Ui.cardRow(this, Ui.I_MOON, "Color mode", Ui.modeLabel(this), Ui.FG, v -> colorMode());
        cm.addView(Ui.chevron(this));
        look.addView(cm, Ui.fill());
        look.addView(Ui.gap(this));
        LinearLayout dn = Ui.cardRow(this, Ui.I_LAYERS, "Density", Ui.compact ? "Compact" : "Comfortable", Ui.FG, v -> density());
        dn.addView(Ui.chevron(this));
        look.addView(dn, Ui.fill());

        // While the agent works, the send button steers or queues (as the desktop's Settings ›
        // General); long-press does the other for one message (Chat.sendMenu).
        LinearLayout chat = card(col);
        LinearLayout fu = Ui.cardRow(this, Ui.I_STEER, "While the agent is running", Chat.followLabel(this), Ui.FG, v -> followUp());
        fu.addView(Ui.chevron(this));
        chat.addView(fu, Ui.fill());

        // Dictation in the composer (Voice): the language it listens for (on this phone), the
        // hub's cleanup (GET /v1/voice, PUT /v1/voice/settings; hidden on hubs without them) and
        // this phone's offline model (Asr).
        LinearLayout dict = card(col);
        LinearLayout dl = Ui.cardRow(this, Ui.I_GLOBE, "Dictation language", Voice.langLabel(this), Ui.FG, v -> voiceLang());
        dl.addView(Ui.chevron(this));
        dict.addView(dl, Ui.fill());
        cleanRow = Ui.col(this);
        cleanRow.setVisibility(View.GONE);
        dict.addView(cleanRow, Ui.fill());
        modelRow = Ui.col(this);
        dict.addView(modelRow, Ui.fill());
        modelRows();
        Ui.pool.execute(() -> {
            try {
                org.json.JSONObject v = hub.call("GET", "/v1/voice", null, 8000);
                runOnUiThread(() -> { cleanup = v.optBoolean("cleanup"); voiceHost = v.optString("host", hub.label()); cleanRows(); });
            } catch (Exception e) { /* an older hub: no such call */ }
        });

        // Notifications (Notes): what the PCs tell this phone about, and when.
        LinearLayout nt = card(col);
        notifyRows(nt);

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

    /** "Update automatically": like the PCs until chosen here (Update.auto). */
    private void autoRows() {
        autoRow.removeAllViews();
        boolean on = Update.auto(this), allowed = getPackageManager().canRequestPackageInstalls();
        String sub = !on ? "Off: tap Update when a new version is ready"
                : allowed ? "On: new versions install while the screen is off, and Harbor opens again on the chat you had"
                : "On, but Android doesn't let Harbor install apps yet: tap to allow it";
        if (Update.autoChoice(this) == null) sub += " (as your PCs: Settings › Updates there)";
        LinearLayout r = Ui.cardRow(this, Ui.I_REFRESH, "Update automatically", sub, on && !allowed ? Ui.AMBER : Ui.FG, v -> toggleAuto());
        Ui.wrapSub(r, 3);
        // On without the permission: the tap asks for it; a long press turns it off.
        if (on && !allowed) r.setOnLongClickListener(v -> { Update.setAuto(this, false); autoRows(); return true; });
        autoRow.addView(r, Ui.fill());
        // Play Protect refused a background install: new versions come as a notification.
        if (on && Update.blocked(this)) {
            autoRow.addView(Ui.gap(this));
            LinearLayout pp = Ui.cardRow(this, Ui.I_ALERT, "Play Protect stops background updates",
                    "New versions come as a notification: tap it, then Scan app. To let them install by themselves, turn on "
                            + "Play Store › your picture › Play Protect › ⚙ › Improve harmful app detection, then tap here to try again.",
                    Ui.AMBER, v -> {
                        Update.unblock(this);
                        autoRows();
                        Ui.toast(this, "The next version tries the background again");
                    });
            Ui.wrapSub(pp, 6);
            autoRow.addView(pp, Ui.fill());
        }
    }

    /** "Why it didn't install": the whole reason, wrapped; a tap shows it to copy. */
    private void whyRows(String reason) {
        whyRow.removeAllViews();
        if (reason.isEmpty()) return;
        whyRow.addView(Ui.gap(this));
        LinearLayout r = Ui.cardRow(this, Ui.I_ALERT, "Why it didn't install", reason, Ui.AMBER,
                v -> Ui.dialog(this).setTitle("Why it didn't install").setMessage(reason)
                        .setNegativeButton("Copy", (d, w) -> Ui.copy(this, reason))
                        .setPositiveButton("Close", null).show());
        Ui.wrapSub(r, 8);
        whyRow.addView(r, Ui.fill());
    }

    private void toggleAuto() {
        boolean on = Update.auto(this);
        if (on && !getPackageManager().canRequestPackageInstalls()) { allowInstalls(); return; }
        Update.setAuto(this, !on);
        autoRows();
        if (!on && !getPackageManager().canRequestPackageInstalls()) allowInstalls();
    }

    /** Android's "Install unknown apps" for Harbor: asked once, for every update after it. */
    private void allowInstalls() {
        Ui.dialog(this).setTitle("Allow Harbor to install updates")
                .setMessage("Android asks once: turn on “Allow from this source” for Harbor, then come back.")
                .setNegativeButton("Cancel", null)
                .setPositiveButton("Open settings", (d, w) -> startActivity(new Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + getPackageName()))))
                .show();
    }

    private void notifyRows(LinearLayout nt) {
        nt.removeAllViews();
        if (!Notes.allowed(this)) {
            LinearLayout al = Ui.cardRow(this, Ui.I_BELL_OFF, "Allow notifications", "Android blocks Harbor's notifications: tap to allow them", Ui.AMBER, v -> {
                if (Build.VERSION.SDK_INT >= 33) requestPermissions(new String[] { "android.permission.POST_NOTIFICATIONS" }, 42);
                else startActivity(new Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, getPackageName()));
            });
            Ui.wrapSub(al, 3);
            al.addView(Ui.chevron(this));
            nt.addView(al, Ui.fill());
            nt.addView(Ui.gap(this));
        }
        int on = 0;
        for (String k : Notes.KINDS) if (Notes.on(this, k)) on++;
        LinearLayout kinds = Ui.cardRow(this, Ui.I_BELL, "Notify me when", on + " of " + Notes.KINDS.length + " on", Ui.FG, v -> pickKinds(nt));
        kinds.addView(Ui.chevron(this));
        nt.addView(kinds, Ui.fill());
        nt.addView(Ui.gap(this));
        LinearLayout away = Ui.cardRow(this, Ui.I_MONITOR, "Only when I'm away from the PC", Notes.awayOnly(this) ? "On: not while you're using Harbor on that PC" : "Off", Ui.FG, v -> {
            Notes.prefs(this).edit().putBoolean("away", !Notes.awayOnly(this)).apply();
            notifyRows(nt);
        });
        Ui.wrapSub(away, 3);
        nt.addView(away, Ui.fill());
        nt.addView(Ui.gap(this));
        int qa = Notes.quietFrom(this), qb = Notes.quietTo(this);
        LinearLayout quiet = Ui.cardRow(this, Ui.I_MOON, "Quiet hours", qa < 0 ? "Off" : Notes.hm(qa) + " – " + Notes.hm(qb), Ui.FG, v -> pickQuiet(nt));
        quiet.addView(Ui.chevron(this));
        nt.addView(quiet, Ui.fill());
        nt.addView(Ui.gap(this));
        boolean inst = Notes.instant(this);
        nt.addView(Ui.cardRow(this, Ui.I_ACTIVITY, "Instant notifications", inst
                ? "On: within seconds, with a silent notification while it listens (a little more battery)"
                : "Off: within about 15 minutes, and within a minute for a while after you leave the app", Ui.FG, v -> toggleInstant(nt)), Ui.fill());
    }

    private void pickKinds(LinearLayout nt) {
        boolean[] on = new boolean[Notes.KINDS.length];
        for (int i = 0; i < on.length; i++) on[i] = Notes.on(this, Notes.KINDS[i]);
        Ui.dialog(this).setTitle("Notify me when")
                .setMultiChoiceItems(Notes.LABELS, on, (d, i, v) -> on[i] = v)
                .setNegativeButton("Cancel", null)
                .setPositiveButton("OK", (d, w) -> {
                    for (int i = 0; i < on.length; i++) Notes.set(this, Notes.KINDS[i], on[i]);
                    notifyRows(nt);
                }).show();
    }

    private void pickQuiet(LinearLayout nt) {
        Ui.dialog(this).setTitle("Quiet hours").setItems(new String[] { "Off", "Set the hours…" }, (d, w) -> {
            if (w == 0) {
                Notes.prefs(this).edit().putInt("qfrom", -1).putInt("qto", -1).apply();
                notifyRows(nt);
                return;
            }
            int a = Notes.quietFrom(this) < 0 ? 22 * 60 : Notes.quietFrom(this), b = Notes.quietTo(this) < 0 ? 7 * 60 : Notes.quietTo(this);
            new android.app.TimePickerDialog(this, (t1, h1, m1) -> new android.app.TimePickerDialog(this, (t2, h2, m2) -> {
                Notes.prefs(this).edit().putInt("qfrom", h1 * 60 + m1).putInt("qto", h2 * 60 + m2).apply();
                notifyRows(nt);
            }, b / 60, b % 60, true) { { setTitle("Until"); } }.show(), a / 60, a % 60, true) { { setTitle("Quiet from"); } }.show();
        }).show();
    }

    private void toggleInstant(LinearLayout nt) {
        if (Notes.instant(this)) {
            Notes.prefs(this).edit().putBoolean("instant", false).apply();
            Listen.apply(this);
            notifyRows(nt);
            return;
        }
        Ui.dialog(this).setTitle("Instant notifications")
                .setMessage("Harbor keeps one connection open to your PC, so notifications arrive within seconds even with the app closed. "
                        + "Android shows a silent notification while it listens, and it uses a little more battery (a wake-up every few minutes).\n\n"
                        + "If your phone still delays it, set Harbor's battery use to Unrestricted in Android's app settings.\n\n"
                        + "Without it, notifications come within about 15 minutes (later when the phone sleeps deeply), "
                        + "and within a minute for a while after you leave the app.")
                .setNegativeButton("Cancel", null)
                .setPositiveButton("Turn on", (d, w) -> {
                    Notes.prefs(this).edit().putBoolean("instant", true).apply();
                    Listen.apply(this);
                    notifyRows(nt);
                }).show();
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] res) {
        super.onRequestPermissionsResult(code, perms, res);
        if (code == 42) recreate();
    }

    /** "ab12 cd34 ef56 7890": the first 64 bits, as the PC shows a key. */
    static String shortFp(String fp) {
        if (fp == null || fp.length() < 16) return "?";
        return fp.substring(0, 4) + " " + fp.substring(4, 8) + " " + fp.substring(8, 12) + " " + fp.substring(12, 16);
    }

    /** The desktop's Settings › Usage breakdown (GET /v1/usage): by project, by day, by account.
     *  A tap on a row shows its whole split. */
    private void usage() {
        Ui.bg(this, () -> hub.get("/v1/usage"), r -> {
            Sheet s = new Sheet(this, "Usage");
            String[][] parts = {{"projects", "By project"}, {"days", "By day"}, {"accounts", "By account"}};
            boolean any = false;
            for (String[] p : parts) {
                org.json.JSONArray rows = r.optJSONArray(p[0]);
                if (rows == null || rows.length() == 0) continue;
                any = true;
                TextView h = Ui.text(this, p[1], 13, Ui.G700);
                h.setPadding(Ui.dp(6), Ui.dp(4), Ui.dp(6), Ui.dp(6));
                s.body.addView(h);
                LinearLayout c = s.card();
                for (int i = 0; i < rows.length(); i++) {
                    org.json.JSONObject o = rows.optJSONObject(i);
                    if (o == null) continue;
                    if (c.getChildCount() > 0) c.addView(Ui.gap(this));
                    String name = o.optString("name"), detail = o.optString("detail");
                    c.addView(Ui.cardRow(this, null, name, o.optString("label"), Ui.FG,
                            v -> Ui.dialog(this).setTitle(name).setMessage(detail).setPositiveButton("Close", null).show()), Ui.fill());
                }
            }
            if (!any) s.body.addView(Ui.text(this, "No turns yet.", 14, Ui.G700));
            s.show();
        });
    }

    private Sheet peopleSheet;

    /** The desktop's Settings › Devices › People and memory: this PC's owner, GitHub login and
     *  whether their instructions and memory go with their chats on other PCs, then every PC. */
    private void people() {
        Ui.bg(this, () -> hub.get("/v1/people"), this::showPeople);
    }

    private void showPeople(JSONObject r) {
        if (peopleSheet != null) peopleSheet.dialog.dismiss();
        Sheet s = new Sheet(this, "People and memory");
        peopleSheet = s;
        JSONObject me = r.optJSONObject("me");
        if (me == null) me = new JSONObject();
        final JSONObject m = me;
        // Hubs from 0.47 detect the owner (src/profile.rs): ask to confirm until the user has.
        boolean detects = m.has("confirmed");
        boolean confirmed = m.optBoolean("confirmed", true);
        String owner = m.optString("owner"), gh = m.optString("github");
        String shownOwner = m.optString("owner_hint"), shownGh = m.optString("github_hint");
        JSONObject sug = m.optJSONObject("suggested");
        if (detects && !confirmed && !shownOwner.isEmpty()) {
            LinearLayout d = s.card();
            d.setPadding(Ui.dp(18), Ui.dp(14), Ui.dp(16), Ui.dp(14));
            d.addView(Ui.bold(this, "Detected, confirm?", 17, Ui.FG));
            String why = sug == null ? "" : sug.optString("why");
            String who = shownOwner + (shownGh.isEmpty() ? "" : " · GitHub " + shownGh);
            d.addView(Ui.text(this, who + "." + (why.isEmpty() ? "" : " " + why.replaceAll("\\.$", "") + ".") + " Agents and your other PCs see it as this PC's owner.", 14, Ui.G700),
                    Ui.margins(Ui.fill(), 0, 4, 0, 12));
            LinearLayout btns = Ui.row(this);
            btns.addView(Ui.button(this, "Confirm", true, v -> patchPeople("op", "confirm")), Ui.margins(Ui.wrap(), 0, 0, 8, 0));
            btns.addView(Ui.button(this, "Edit", false, v -> editProfile(shownOwner, shownGh)), Ui.wrap());
            d.addView(btns);
        }
        LinearLayout you = s.card();
        String unconf = detects && !confirmed ? " (detected, not confirmed)" : "";
        you.addView(Ui.cardRow(this, Ui.I_USER, "Your name", owner.isEmpty()
                        ? (shownOwner.isEmpty() ? "Not set" : shownOwner + (detects ? unconf : " (from the PC's account)")) : owner, Ui.FG,
                v -> editPerson("Your name", "owner", owner, shownOwner)), Ui.fill());
        you.addView(Ui.gap(this));
        you.addView(Ui.cardRow(this, Ui.I_GLOBE, "Your GitHub login", gh.isEmpty() ? (shownGh.isEmpty() ? "Not set" : shownGh + (detects ? unconf : " (Harbor's sign-in)")) : gh, Ui.FG,
                v -> editPerson("Your GitHub login", "github", gh, shownGh)), Ui.fill());
        if (detects) {
            you.addView(Ui.gap(this));
            boolean busy = m.optBoolean("detecting");
            String last = sug == null ? "Not run yet" : "rules".equals(sug.optString("by")) ? "Last run used rules only (no Claude account to ask)" : "Last run asked " + sug.optString("by");
            LinearLayout dr = Ui.cardRow(this, Ui.I_REFRESH, busy ? "Detecting…" : "Detect again",
                    last + ". Reads names and logins on the PC (git, gh, accounts, phones, SSH hosts and key comments; never keys or tokens). A name you typed stays.",
                    Ui.FG, busy ? null : v -> detectAgain());
            Ui.wrapSub(dr, 4);
            you.addView(dr, Ui.fill());
        }
        you.addView(Ui.gap(this));
        boolean send = m.optBoolean("send_context", true);
        you.addView(Ui.cardRow(this, Ui.I_BRAIN, "Send my instructions and memory", send
                ? "On: a chat you drive from this PC that runs on another PC uses your CLAUDE.md, memory and language there, and what it learns comes back"
                : "Off: such chats run with no user instructions or memory", Ui.FG, v -> patchPeople("send_context", !send)), Ui.fill());
        if (m.has("share_github")) {
            boolean ghOut = m.optBoolean("share_github", true);
            you.addView(Ui.gap(this));
            you.addView(Ui.cardRow(this, Ui.I_GLOBE, "My chats on other PCs may use my GitHub here", ghOut
                    ? "On: they can run gh on this PC with Harbor's GitHub sign-in, so their issues and PRs are yours"
                    : "Off: only PCs allowed everything get it", Ui.FG, v -> patchPeople("share_github", !ghOut)), Ui.fill());
        }
        org.json.JSONArray pcs = r.optJSONArray("pcs");
        if (pcs != null && pcs.length() > 1) {
            TextView h = Ui.text(this, "Who is who", 13, Ui.G700);
            h.setPadding(Ui.dp(6), Ui.dp(10), Ui.dp(6), Ui.dp(6));
            s.body.addView(h);
            LinearLayout c = s.card();
            for (int i = 0; i < pcs.length(); i++) {
                JSONObject p = pcs.optJSONObject(i);
                if (p == null) continue;
                if (c.getChildCount() > 0) c.addView(Ui.gap(this));
                String title = p.optString("name") + (p.optBoolean("self") ? " (this PC)" : "");
                // Other PCs (hubs from 0.45): what their chats may do with this PC's files; tap to change.
                String share = p.optString("share", "");
                String why = p.optString("why");
                String sub = p.optString("line") + (why.isEmpty() ? "" : "\n" + why) + (share.isEmpty() ? "" : "\nIts chats here: " + p.optString("share_label"));
                View.OnClickListener tap = share.isEmpty() ? null : v -> pickShare(p.optString("id"), p.optString("name"), share, r.optJSONArray("levels"));
                LinearLayout row = Ui.cardRow(this, Ui.I_MONITOR, title, sub, p.optBoolean("online", true) ? Ui.FG : Ui.G700, tap);
                if (tap != null) row.addView(Ui.chevron(this));
                c.addView(row, Ui.fill());
            }
        }
        s.show();
    }

    private void pickShare(String pc, String name, String now, org.json.JSONArray levels) {
        if (levels == null) return;
        java.util.List<Sheet.Option> o = new java.util.ArrayList<>();
        for (int i = 0; i < levels.length(); i++) {
            JSONObject l = levels.optJSONObject(i);
            if (l != null) o.add(new Sheet.Option(l.optString("id"), l.optString("label"), l.optString("about"), true));
        }
        Sheet.pick(this, "Chats from " + name + " may", "What an agent in a chat that runs on " + name + " may do with this PC's files, shell and GitHub.", o, now, l -> {
            Ui.bg(this, () -> {
                JSONObject s = new JSONObject();
                s.put("pc", pc);
                s.put("level", l);
                JSONObject b = new JSONObject();
                b.put("share", s);
                return hub.call("PATCH", "/v1/people", b);
            }, this::showPeople);
        });
    }

    /** Edit the detected profile: both fields at once, filled with what was detected. */
    private void editProfile(String owner, String gh) {
        LinearLayout f = Ui.col(this);
        f.setPadding(Ui.dp(20), Ui.dp(8), Ui.dp(20), 0);
        EditText name = Ui.input(this, "Your name", false);
        name.setText(owner);
        EditText login = Ui.input(this, "GitHub login", false);
        login.setText(gh);
        f.addView(name, Ui.fill());
        f.addView(login, Ui.margins(Ui.fill(), 0, 8, 0, 0));
        Ui.dialog(this).setTitle("This PC's owner").setView(f).setNegativeButton("Cancel", null)
                .setPositiveButton("Save", (d, w) -> Ui.bg(this, () -> {
                    JSONObject b = new JSONObject();
                    b.put("owner", name.getText().toString().trim());
                    b.put("github", login.getText().toString().trim());
                    return hub.call("PATCH", "/v1/people", b);
                }, this::showPeople)).show();
    }

    /** "Detect again": the hub runs it in the background; ask until it's done (at most ~2 min). */
    private void detectAgain() {
        Ui.bg(this, () -> {
            JSONObject b = new JSONObject();
            b.put("op", "detect");
            JSONObject r = hub.call("PATCH", "/v1/people", b);
            for (int i = 0; i < 40 && r.optJSONObject("me") != null && r.optJSONObject("me").optBoolean("detecting"); i++) {
                Thread.sleep(3000);
                r = hub.get("/v1/people");
            }
            return r;
        }, this::showPeople);
        Ui.toast(this, "Detecting who is who…");
    }

    private void editPerson(String title, String key, String now, String hint) {
        EditText in = Ui.input(this, hint.isEmpty() ? "" : hint, false);
        in.setText(now);
        Ui.dialog(this).setTitle(title).setView(in).setNegativeButton("Cancel", null)
                .setPositiveButton("Save", (d, w) -> patchPeople(key, in.getText().toString().trim())).show();
    }

    private void patchPeople(String key, Object value) {
        Ui.bg(this, () -> {
            JSONObject b = new JSONObject();
            b.put(key, value);
            return hub.call("PATCH", "/v1/people", b);
        }, this::showPeople);
    }

    private LinearLayout card(LinearLayout col) {
        LinearLayout c = Ui.card(this);
        col.addView(c, Ui.margins(Ui.fill(), 0, 0, 0, 14));
        return c;
    }

    private LinearLayout cleanRow, modelRow;
    private Boolean cleanup;
    private String voiceHost;

    /** "Clean up dictation": the hub's setting, mirrored. */
    private void cleanRows() {
        cleanRow.removeAllViews();
        if (cleanup == null) return;
        cleanRow.setVisibility(View.VISIBLE);
        cleanRow.addView(Ui.gap(this));
        LinearLayout r = Ui.cardRow(this, Ui.I_SPARKLES, "Clean up dictation", cleanup
                ? "On: when you stop, " + voiceHost + " tidies the words (punctuation, filler words)"
                : "Off: the words go in as heard", Ui.FG, v -> toggleCleanup());
        Ui.wrapSub(r, 2);
        cleanRow.addView(r, Ui.fill());
    }

    private void toggleCleanup() {
        boolean want = !cleanup;
        Ui.pool.execute(() -> {
            try {
                hub.call("PUT", "/v1/voice/settings", new org.json.JSONObject().put("cleanup", want));
                runOnUiThread(() -> { cleanup = want; cleanRows(); });
            } catch (Exception e) {
                runOnUiThread(() -> Ui.toast(this, Hub.why(e)));
            }
        });
    }

    /** "Offline dictation": the phone's own model (Asr), refreshed while it downloads. */
    private void modelRows() {
        modelRow.removeAllViews();
        if (!Asr.available()) return;
        Asr.Model m = Asr.pick(this);
        modelRow.addView(Ui.gap(this));
        LinearLayout r = Ui.cardRow(this, Ui.I_DOWNLOAD, "Offline dictation", m.name + " · " + m.mb() + " · " + Asr.state(this), Ui.FG, v -> model());
        Ui.wrapSub(r, 3);
        modelRow.addView(r, Ui.fill());
        if (Asr.progress >= 0 || Asr.wanted(this) && !Asr.ready(this)) modelRow.postDelayed(() -> { if (!isFinishing()) modelRows(); }, 1000);
    }

    private void model() {
        Asr.Model m = Asr.pick(this);
        boolean ready = Asr.ready(this), wanted = Asr.wanted(this);
        android.app.AlertDialog.Builder d = Ui.dialog(this).setTitle("Offline dictation")
                .setMessage("When the PC can't transcribe (no network, or it doesn't answer), this phone does it with "
                        + m.name + " (" + m.mb() + ", picked for this phone's memory). It downloads on Wi-Fi only, and takes memory only while you dictate.")
                .setNegativeButton("Close", null);
        if (ready || wanted) d.setPositiveButton(ready ? "Remove" : "Stop download", (x, w) -> { Asr.remove(this); modelRows(); });
        else d.setPositiveButton("Download on Wi-Fi", (x, w) -> { Asr.want(this); modelRows(); });
        d.show();
    }

    private void voiceLang() {
        java.util.List<Sheet.Option> o = new java.util.ArrayList<>();
        for (String[] l : Voice.LANGS) o.add(new Sheet.Option(l[0], l[1], "auto".equals(l[0]) ? "found from what you say" : "", true));
        Sheet.pick(this, "Dictation language", "The mic in the composer listens for it. The PC transcribes what you say, or this phone's offline model when the PC can't.", o, Voice.lang(this), l -> {
            Ui.prefs(this).edit().putString("voice_lang", l).apply();
            recreate();
        });
    }

    private void followUp() {
        java.util.List<Sheet.Option> o = new java.util.ArrayList<>();
        o.add(new Sheet.Option("queue", "Queue", "Your message waits and runs after the current turn finishes.", true));
        o.add(new Sheet.Option("steer", "Steer", "Your message reaches the agent right away, changing what it is working on.", true));
        Sheet.pick(this, "While the agent is running", "Long-press the send button to use the other option for a single message. Agents that can't be steered always queue.", o, Chat.followUp(this), m -> {
            Ui.prefs(this).edit().putString("follow_up", m).apply();
            recreate();
        });
    }

    private void density() {
        java.util.List<Sheet.Option> o = new java.util.ArrayList<>();
        o.add(new Sheet.Option("comfortable", "Comfortable", "", true));
        o.add(new Sheet.Option("compact", "Compact", "shorter rows in lists and settings", true));
        Sheet.pick(this, "Density", "On this phone only, like the desktop's Settings › Appearance › Density.", o, Ui.compact ? "compact" : "comfortable", d -> {
            Ui.prefs(this).edit().putString("density", d).apply();
            Ui.themeGen++;
            recreate();
        });
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
        autoRows(); // back from Android's "Install unknown apps"
        checkUpdates();
        // An install that fails after its download (Android or Play Protect refused it).
        Update.changed = () -> { if (!isFinishing()) { autoRows(); checkUpdates(); } };
    }

    @Override
    protected void onPause() {
        super.onPause();
        Update.changed = null;
    }

    /** The PC's version, and the newest app any PC offers (tap the Update row to ask again). */
    private void checkUpdates() {
        updateNote.setText("Checking every PC…");
        Ui.pool.execute(() -> {
            String info, note, version = ""; long code = 0;
            try {
                JSONObject st = hub.state();
                version = st.optString("version");
                info = "Harbor " + version;
            } catch (Exception e) {
                info = Hub.why(e);
            }
            // Every PC of every pairing: the one this phone talks to may run an older Harbor.
            code = Update.check(getApplicationContext(), true);
            long mine = myCode(this);
            String where = Update.bestHub == null ? "" : pcName(Update.bestHub, Update.bestPc);
            String failed = code > mine ? Update.failure(getApplicationContext(), code) : "";
            note = code <= 0 ? "No PC answered with an app to offer"
                    : code > mine ? "Version " + name(code) + " is ready" + (where.isEmpty() ? "" : " on " + where)
                        + (!failed.isEmpty() || Update.blocked(getApplicationContext()) ? ". Tap Update to install it"
                        : Update.silent(getApplicationContext(), code) ? ". It installs by itself the next time the screen is off" : "")
                    : "Up to date (" + name(mine) + ")";
            final String fi = info, fn = note, fv = version, ff = failed; final long fc = code;
            Ui.main.post(() -> {
                if (isFinishing()) return;
                hubVersion.setText(fi);
                whyRows(ff);
                if (!installing) updateNote.setText(fn); // else its progress stays on the line
                badge.setText(fv);
                badge.setVisibility(fv.isEmpty() ? View.GONE : View.VISIBLE);
                available = fc;
                updateBtn.setVisibility(fc > myCode(this) ? View.VISIBLE : View.GONE);
            });
        });
    }

    /** The name of PC v of pairing id ("" = the paired PC). */
    private String pcName(String id, String v) {
        Hub h = Hub.get(this, id);
        return h == null ? "" : h.labelOn(v);
    }

    /** 7001 -> 0.7.1 (android/build.sh: major*1000000 + minor*1000 + patch). */
    static String name(long code) {
        return (code / 1000000) + "." + (code / 1000 % 1000) + "." + (code % 1000);
    }

    private void update() {
        if (!getPackageManager().canRequestPackageInstalls()) {
            allowInstalls();
            return;
        }
        updateBtn.setEnabled(false);
        updateBtn.setAlpha(0.5f);
        updateNote.setText("Downloading…");
        installing = true;
        Ui.pool.execute(() -> {
            String err = null;
            try {
                Update.install(getApplicationContext(), hub, (done, total) -> {
                    int pct = (int) (done * 100 / total);
                    Ui.main.post(() -> updateNote.setText("Downloading… " + pct + "%"));
                }, false);
            } catch (Exception e) {
                err = Hub.why(e);
            }
            final String fe = err;
            Ui.main.post(() -> {
                installing = false;
                updateBtn.setEnabled(true);
                updateBtn.setAlpha(1f);
                updateNote.setText(fe == null ? "Installing " + name(available) + "… Harbor closes when it's done: open it again and it's back on your chat." : "Update failed: " + fe);
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
