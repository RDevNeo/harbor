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

/** Settings in titled sections, like the desktop's pages: the workspace (switch with ▾), the
 *  account, the workspace's members (owners invite by email) and PCs, the PCs' apps, general,
 *  voice, notifications, this app and its updates, sign out. Settings that were dropped keep
 *  a fixed value in code: updates install by themselves (Update), web links open in the
 *  built-in browser, dictation detects the language and takes spoken commands (Voice), the
 *  offline model downloads after the first dictation (Asr), and notifications are instant
 *  (Listen) and come only while you're away from that PC (Notes). */
public class Settings extends Base {
    private TextView updateNote, gmailSub, discordSub, appsHead;
    private LinearLayout gmailCard, gmailRowBox, discordBox, warnRow, whyRow, voiceCard;
    private TextView voiceHead;
    private View discordGap;
    private View updateBtn;
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

        // The workspace these settings are for; tap to switch.
        LinearLayout top = card(col);
        LinearLayout pc = Ui.cardRow(this, Ui.I_USERS, hub.label(), null, Ui.FG, v -> pcs());
        pc.addView(Ui.icon(this, Ui.I_DOWN, 20, Ui.FG), new LinearLayout.LayoutParams(Ui.dp(28), Ui.dp(28)));
        top.addView(pc, Ui.fill());

        // The account, invitations to other workspaces, this workspace's members and PCs.
        wsBox = Ui.col(this);
        col.addView(wsBox, Ui.fill());
        workspaceRows();

        // Who is who across the PCs, and whose instructions a chat run on another PC uses
        // (GET/PATCH /v1/people, hubs from 0.44; hidden on older ones): with the account.
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
                runOnUiThread(() -> { hasPeople = true; workspaceRows(); });
            } catch (Exception e) { /* an older hub: no such call */ }
        });

        // Apps agents on this PC use (Gmail, 0.95: GET /v1/apps/gmail; hidden on older hubs).
        appsHead = section(col, "Apps");
        appsHead.setVisibility(View.GONE);
        LinearLayout apps = card(col);
        apps.setVisibility(View.GONE);
        LinearLayout gm = Ui.cardRow(this, Ui.I_PLUG, "Gmail", "…", Ui.FG, v -> {
            Gmail.changed = this::gmailRow;
            Gmail.show(this, hub);
        });
        gm.addView(Ui.chevron(this));
        Ui.wrapSub(gm, 2);
        apps.addView(gm, Ui.fill());
        gmailSub = (TextView) ((LinearLayout) gm.getChildAt(1)).getChildAt(1);
        gmailRowBox = gm;
        gm.setVisibility(View.GONE);
        gmailCard = apps;
        // Discord (GET /v1/apps/discord; hidden on hubs without it): the desktop card's line.
        discordBox = Ui.col(this);
        discordBox.setVisibility(View.GONE);
        LinearLayout dc = Ui.cardRow(this, Ui.I_PLUG, "Discord", "…", Ui.FG, v -> {
            Discord.changed = this::discordRow;
            Discord.show(this, hub, hub.via());
        });
        dc.addView(Ui.chevron(this));
        Ui.wrapSub(dc, 3);
        discordGap = Ui.gap(this);
        discordBox.addView(discordGap);
        discordBox.addView(dc, Ui.fill());
        apps.addView(discordBox, Ui.fill());
        discordSub = (TextView) ((LinearLayout) dc.getChildAt(1)).getChildAt(1);
        if (getIntent().getBooleanExtra("discord", false)) {
            Discord.changed = this::discordRow;
            Discord.show(this, hub, hub.via());
        }

        // While the agent works, the send button steers or queues (as the desktop's Settings ›
        // General); long-press does the other for one message (Chat.sendMenu). Then the look.
        section(col, "General");
        LinearLayout gen = card(col);
        LinearLayout fu = Ui.cardRow(this, Ui.I_STEER, "While the agent is running", Chat.followLabel(this), Ui.FG, v -> followUp());
        fu.addView(Ui.chevron(this));
        gen.addView(fu, Ui.fill());
        gen.addView(Ui.gap(this));
        LinearLayout cm = Ui.cardRow(this, Ui.I_MOON, "Color mode", Ui.modeLabel(this), Ui.FG, v -> colorMode());
        cm.addView(Ui.chevron(this));
        gen.addView(cm, Ui.fill());
        gen.addView(Ui.gap(this));
        LinearLayout dn = Ui.cardRow(this, Ui.I_LAYERS, "Density", Ui.compact ? "Compact" : "Comfortable", Ui.FG, v -> density());
        dn.addView(Ui.chevron(this));
        gen.addView(dn, Ui.fill());

        // Dictation in the composer (Voice): the PC's dictionary (GET /v1/voice, PUT
        // /v1/voice/settings; the section stays hidden on hubs without one).
        voiceHead = section(col, "Voice");
        voiceHead.setVisibility(View.GONE);
        voiceCard = card(col);
        voiceCard.setVisibility(View.GONE);
        Ui.pool.execute(() -> {
            try {
                org.json.JSONObject v = hub.call("GET", "/v1/voice", null, 8000);
                Voice.keepWords(this, v);
                runOnUiThread(() -> {
                    // Hubs before 0.76 have no dictionary: the section stays hidden.
                    words = v.has("dictionary") ? v.optJSONArray("dictionary") : null;
                    voiceRows();
                });
            } catch (Exception e) { /* an older hub: no such call */ }
        });

        // Notifications (Notes): what the PCs tell this phone about, and when.
        section(col, "Notifications");
        LinearLayout nt = card(col);
        notifyRows(nt);
        footnote(col, "They arrive within seconds, and only while you're away from that PC.");

        // This app: its version and update (any PC offers the newest it has), and what keeps
        // the automatic install from going in.
        section(col, "App");
        LinearLayout app = card(col);
        LinearLayout updateRow = Ui.cardRow(this, Ui.I_PHONE, "Harbor for Android", "Checking… · " + myName(this), Ui.FG, v -> checkUpdates());
        updateNote = (TextView) ((LinearLayout) updateRow.getChildAt(1)).getChildAt(1);
        updateBtn = Ui.button(this, "Update", true, v -> update());
        updateBtn.setVisibility(View.GONE);
        updateRow.addView(updateBtn);
        Ui.wrapSub(updateRow, 3);
        app.addView(updateRow, Ui.fill());
        warnRow = Ui.col(this);
        app.addView(warnRow, Ui.fill());
        // Why the last automatic install didn't go in: Android's whole message (INSTALL_FAILED_…).
        whyRow = Ui.col(this);
        app.addView(whyRow, Ui.fill());
        warnRows();

        LinearLayout bye = card(col);
        bye.addView(Ui.cardRow(this, Ui.I_PLUG, "Sign out", Account.email(this), Ui.RED, v -> signOut()), Ui.fill());
        TextView note = Ui.text(this, "Signing out forgets your PCs on this phone, and they stop taking it. Chats stay on the PCs.", 13, Ui.G700);
        note.setPadding(Ui.dp(8), 0, Ui.dp(8), 0);
        col.addView(note);
    }

    /** A section's title over its cards. */
    private TextView section(LinearLayout col, String title) {
        TextView t = Ui.bold(this, title, 14, Ui.G700);
        t.setPadding(Ui.dp(18), Ui.dp(10), Ui.dp(18), Ui.dp(8));
        col.addView(t, Ui.fill());
        return t;
    }

    /** A small note under a card. */
    private void footnote(LinearLayout col, String s) {
        TextView t = Ui.text(this, s, 13, Ui.G700);
        t.setPadding(Ui.dp(18), 0, Ui.dp(18), 0);
        LinearLayout.LayoutParams lp = Ui.fill();
        // Sits under the card it explains (cards keep 14 dp below them).
        lp.setMargins(0, -Ui.dp(6), 0, Ui.dp(16));
        col.addView(t, lp);
    }

    /** A round avatar with someone's initials, the size of a card row's icon disc. */
    private View avatar(String name) {
        String[] w = name.trim().split("[\\s@._-]+");
        String ini = w.length == 0 || w[0].isEmpty() ? "?" : (w[0].substring(0, 1) + (w.length > 1 && !w[1].isEmpty() ? w[1].substring(0, 1) : "")).toUpperCase();
        FrameLayout f = new FrameLayout(this);
        f.setBackground(Ui.round(Ui.G200, 0, 18));
        TextView t = Ui.bold(this, ini, 13, Ui.FG);
        t.setGravity(android.view.Gravity.CENTER);
        f.addView(t, new FrameLayout.LayoutParams(-1, -1));
        f.setLayoutParams(new LinearLayout.LayoutParams(Ui.dp(36), Ui.dp(36)));
        return f;
    }

    /** A trailing tag on a row ("Owner"). */
    private TextView tag(String s) {
        TextView t = Ui.text(this, s, 13, Ui.G700);
        t.setPadding(Ui.dp(10), Ui.dp(3), Ui.dp(10), Ui.dp(3));
        t.setBackground(Ui.round(Ui.G100, 0, 12));
        t.setLayoutParams(Ui.margins(Ui.wrap(), 8, 0, 0, 0));
        return t;
    }

    private LinearLayout wsBox;
    private boolean hasPeople;

    /** Account: signed in as…, People and memory, invitations to other workspaces. Members:
     *  this workspace's people (owners invite and remove; anyone leaves a workspace that isn't
     *  their own), its pending invitations. PCs: the workspace's PCs, who added each. */
    private void workspaceRows() {
        wsBox.removeAllViews();
        section(wsBox, "Account");
        LinearLayout acct = card(wsBox);
        acct.addView(Ui.cardRow(this, avatar(Account.name(this)), Account.name(this), Account.email(this) + " · Google", Ui.FG, null), Ui.fill());
        if (hasPeople) {
            acct.addView(Ui.gap(this));
            LinearLayout pr = Ui.cardRow(this, Ui.I_BRAIN, "People and memory", "Who is who, and your instructions on other PCs", Ui.FG, v -> people());
            pr.addView(Ui.chevron(this));
            acct.addView(pr, Ui.fill());
        }
        // Invitations to other workspaces: tap to accept or decline.
        org.json.JSONArray pend = Account.invites(this);
        for (int i = 0; i < pend.length(); i++) {
            JSONObject x = pend.optJSONObject(i);
            if (x == null) continue;
            String wsn = x.optString("ws_name").isEmpty() ? "a workspace" : x.optString("ws_name");
            String iid = x.optString("id");
            acct.addView(Ui.gap(this));
            LinearLayout r = Ui.cardRow(this, Ui.I_USERS, "Invitation to " + wsn, (x.optString("inviter_name").isEmpty() ? "" : "From " + x.optString("inviter_name") + " · ") + "tap to accept or decline", Ui.BLUE,
                    v -> Ui.dialog(this).setTitle("Join " + wsn + "?").setMessage("You'd share all of its PCs and chats, on every device. Nothing on this phone or your PCs changes.")
                            .setNegativeButton("Decline", (d, w) -> act(() -> Account.answer(this, iid, false), null))
                            .setPositiveButton("Accept", (d, w) -> act(() -> Account.answer(this, iid, true), "Joined " + wsn)).show());
            r.addView(Ui.chevron(this));
            acct.addView(r, Ui.fill());
        }
        String ws = Account.wsOf(hub);
        JSONObject w = ws == null ? null : Account.workspace(this, ws);
        if (w == null) return;
        boolean owner = "owner".equals(w.optString("role"));
        boolean personal = w.optBoolean("personal");
        String me = Account.id(this), wsName = w.optString("name");

        section(wsBox, "Members");
        LinearLayout people = card(wsBox);
        // Owners first, then the others, each as the directory lists them.
        java.util.List<JSONObject> ms = new java.util.ArrayList<>();
        org.json.JSONArray ma = w.optJSONArray("members");
        for (int pass = 0; pass < 2; pass++)
            for (int i = 0; ma != null && i < ma.length(); i++) {
                JSONObject m = ma.optJSONObject(i);
                if (m != null && "owner".equals(m.optString("role")) == (pass == 0)) ms.add(m);
            }
        for (JSONObject m : ms) {
            String uid = m.optString("id"), nm = m.optString("name").isEmpty() ? m.optString("email") : m.optString("name");
            boolean self = uid.equals(me);
            View.OnClickListener tap = !self && owner ? v -> confirmRemove(ws, uid, false, nm) : null;
            if (people.getChildCount() > 0) people.addView(Ui.gap(this));
            LinearLayout r = Ui.cardRow(this, avatar(nm), nm + (self ? " (you)" : ""), m.optString("email"), Ui.FG, tap);
            if ("owner".equals(m.optString("role"))) r.addView(tag("Owner"));
            people.addView(r, Ui.fill());
        }
        org.json.JSONArray inv = w.optJSONArray("invites");
        if (inv != null) for (int i = 0; i < inv.length(); i++) {
            JSONObject x = inv.optJSONObject(i);
            if (x == null) continue;
            if (people.getChildCount() > 0) people.addView(Ui.gap(this));
            // Same note as the desktop (account.ts inviteNote): nobody can accept it as it is.
            String note = !x.optBoolean("no_account") ? "" : x.optString("near").isEmpty()
                    ? " · no Harbor account uses this address yet"
                    : " · no Harbor account uses this address: did you mean " + x.optString("near") + "?";
            LinearLayout r = Ui.cardRow(this, Ui.disc(this, Ui.I_CLOCK, 36), x.optString("email"), "Invited" + note, Ui.G700,
                    owner ? v -> cancelInvite(ws, x.optString("id"), x.optString("email")) : null);
            Ui.wrapSub(r, 2);
            people.addView(r, Ui.fill());
        }
        if (owner) {
            if (people.getChildCount() > 0) people.addView(Ui.gap(this));
            people.addView(Ui.cardRow(this, Ui.disc(this, Ui.I_PLUS, 36), "Invite someone", null, Ui.FG, v -> invite(ws)), Ui.fill());
        }
        if (!personal && !owner) {
            people.addView(Ui.gap(this));
            people.addView(Ui.cardRow(this, Ui.disc(this, Ui.I_X, 36), "Leave " + wsName, null, Ui.RED, v -> confirmRemove(ws, me, true, wsName)), Ui.fill());
        }
        footnote(wsBox, "Everyone in " + wsName + " controls all of its PCs and chats." + (owner ? " Tap someone to remove them." : ""));

        org.json.JSONArray pcs = w.optJSONArray("pcs");
        if (pcs == null || pcs.length() == 0) return;
        section(wsBox, "PCs");
        LinearLayout pcCard = card(wsBox);
        for (int i = 0; i < pcs.length(); i++) {
            JSONObject p = pcs.optJSONObject(i);
            if (p == null) continue;
            if (pcCard.getChildCount() > 0) pcCard.addView(Ui.gap(this));
            String by = p.optString("owner_name");
            boolean mine = p.optString("owner").equals(me);
            pcCard.addView(Ui.cardRow(this, Ui.disc(this, Ui.I_MONITOR, 36), p.optString("name"), mine ? "Added by you" : by.isEmpty() ? null : "Added by " + by, Ui.FG, null), Ui.fill());
        }
    }

    private void invite(String ws) {
        EditText e = Ui.input(this, "name@example.com", false);
        e.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS);
        FrameLayout f = new FrameLayout(this);
        f.setPadding(Ui.dp(20), Ui.dp(8), Ui.dp(20), 0);
        f.addView(e);
        Ui.dialog(this).setTitle("Invite to this workspace").setMessage("They'll see the invitation in Harbor when they sign in with that Google account (no email is sent). Once they accept, they control all of this workspace's PCs and chats.")
                .setView(f).setNegativeButton("Cancel", null)
                .setPositiveButton("Invite", (d, x) -> {
                    String m = e.getText().toString().trim();
                    if (!m.contains("@")) { Ui.toast(this, "Type an email address"); return; }
                    act(() -> Account.invite(this, ws, m), "Invited " + m + ": they'll see it in Harbor when they sign in with that Google account.");
                }).show();
    }

    private void cancelInvite(String ws, String id, String email) {
        Ui.dialog(this).setTitle("Cancel the invitation?").setMessage(email)
                .setNegativeButton("Keep", null)
                .setPositiveButton("Cancel it", (d, x) -> act(() -> Account.cancelInvite(this, ws, id), null)).show();
    }

    private void confirmRemove(String ws, String user, boolean self, String name) {
        Ui.dialog(this).setTitle(self ? "Leave " + name + "?" : "Remove " + name + "?")
                .setMessage(self ? "You lose its PCs and chats until someone invites you again." : "They lose this workspace's PCs and chats on every device, within a few minutes.")
                .setNegativeButton("Cancel", null)
                .setPositiveButton(self ? "Leave" : "Remove", (d, x) -> act(() -> Account.removeMember(this, ws, user), null)).show();
    }

    interface Act { void run() throws Exception; }

    /** A workspace action off the UI thread, then the rows again. */
    private void act(Act a, String done) {
        Ui.pool.execute(() -> {
            String err = null;
            try { a.run(); } catch (Exception e) { err = Hub.why(e); }
            final String fe = err;
            runOnUiThread(() -> {
                if (isFinishing()) return;
                if (fe != null) Ui.toast(this, fe); else if (done != null) Ui.toast(this, done);
                if (Hub.get(this, hub.id) == null) { startActivity(new Intent(this, Hubs.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP)); finish(); return; }
                workspaceRows();
            });
        });
    }

    /** What keeps updates from installing by themselves: Android's "Install unknown apps" not
     *  allowed yet, or Play Protect refusing background installs. */
    private void warnRows() {
        warnRow.removeAllViews();
        if (!getPackageManager().canRequestPackageInstalls()) {
            warnRow.addView(Ui.gap(this));
            LinearLayout r = Ui.cardRow(this, Ui.I_ALERT, "Allow Harbor to install updates",
                    "Android doesn't let Harbor install them yet: tap to allow it, once", Ui.AMBER, v -> allowInstalls());
            Ui.wrapSub(r, 3);
            r.addView(Ui.chevron(this));
            warnRow.addView(r, Ui.fill());
        } else if (Update.blocked(this)) {
            // Play Protect refused a background install: new versions come as a notification.
            warnRow.addView(Ui.gap(this));
            LinearLayout pp = Ui.cardRow(this, Ui.I_ALERT, "Play Protect stops background updates",
                    "New versions come as a notification: tap it, then Scan app. To let them install by themselves, turn on "
                            + "Play Store › your picture › Play Protect › ⚙ › Improve harmful app detection, then tap here to try again.",
                    Ui.AMBER, v -> {
                        Update.unblock(this);
                        warnRows();
                        Ui.toast(this, "The next version tries the background again");
                    });
            Ui.wrapSub(pp, 6);
            warnRow.addView(pp, Ui.fill());
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
        int qa = Notes.quietFrom(this), qb = Notes.quietTo(this);
        LinearLayout quiet = Ui.cardRow(this, Ui.I_MOON, "Quiet hours", qa < 0 ? "Off" : Notes.hm(qa) + " – " + Notes.hm(qb), Ui.FG, v -> pickQuiet(nt));
        quiet.addView(Ui.chevron(this));
        nt.addView(quiet, Ui.fill());
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

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] res) {
        super.onRequestPermissionsResult(code, perms, res);
        if (code == 42) recreate();
    }

    private Sheet peopleSheet;

    /** The desktop's Settings › Workspace › People and memory: this PC's owner, GitHub login and
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

    /** The hub's dictionary (GET /v1/voice `dictionary`, 0.76); null on older hubs. */
    private org.json.JSONArray words;

    /** Voice: the dictionary, kept on the PC (hubs from 0.76; else the section stays hidden). */
    private void voiceRows() {
        voiceCard.removeAllViews();
        boolean on = words != null;
        voiceHead.setVisibility(on ? View.VISIBLE : View.GONE);
        voiceCard.setVisibility(on ? View.VISIBLE : View.GONE);
        if (!on) return;
        int n = words.length();
        LinearLayout d = Ui.cardRow(this, Ui.I_FILE_TEXT, "Dictionary", n == 0 ? "Names and terms to spell exactly, like SpokPay"
                : n + (n == 1 ? " word" : " words") + " · " + termsPreview(), Ui.FG, v -> dictionary());
        Ui.wrapSub(d, 2);
        d.addView(Ui.chevron(this));
        voiceCard.addView(d, Ui.fill());
    }

    private String termsPreview() {
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < words.length() && b.length() < 60; i++) {
            if (b.length() > 0) b.append(", ");
            b.append(words.optJSONObject(i) == null ? "" : words.optJSONObject(i).optString("term"));
        }
        return b.toString();
    }

    /** A hub voice setting (PUT /v1/voice/settings); the rows follow its answer. */
    private void putVoice(String key, Object value) {
        Ui.pool.execute(() -> {
            try {
                org.json.JSONObject v = hub.call("PUT", "/v1/voice/settings", new org.json.JSONObject().put(key, value));
                Voice.keepWords(this, v);
                runOnUiThread(() -> {
                    if (v.has("dictionary")) words = v.optJSONArray("dictionary");
                    voiceRows();
                });
            } catch (Exception e) {
                runOnUiThread(() -> Ui.toast(this, Hub.why(e)));
            }
        });
    }

    /** The dictionary: its words (tap one to edit or remove it), and Add. Kept on the PC, which
     *  spells them in everything it transcribes for this phone and for itself. */
    private void dictionary() {
        int n = words.length();
        String[] items = new String[n + 1];
        for (int i = 0; i < n; i++) {
            org.json.JSONObject e = words.optJSONObject(i);
            org.json.JSONArray snd = e == null ? null : e.optJSONArray("sounds");
            items[i] = (e == null ? "" : e.optString("term")) + (snd != null && snd.length() > 0 ? "  ·  sounds like " + join(snd) : "");
        }
        items[n] = "+ Add a word";
        Ui.dialog(this).setTitle("Dictionary")
                .setItems(items, (x, i) -> editWord(i < n ? i : -1))
                .setNegativeButton("Close", null).show();
    }

    private static String join(org.json.JSONArray a) {
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < a.length(); i++) { if (i > 0) b.append(", "); b.append(a.optString(i)); }
        return b.toString();
    }

    /** Add (`at` -1) or edit a word: its exact spelling and, optionally, how it comes out wrong. */
    private void editWord(int at) {
        org.json.JSONObject cur = at >= 0 ? words.optJSONObject(at) : null;
        LinearLayout box = Ui.col(this);
        box.setPadding(Ui.dp(20), Ui.dp(8), Ui.dp(20), 0);
        android.widget.EditText term = Ui.input(this, "Word or name, as it's spelled", false);
        android.widget.EditText sounds = Ui.input(this, "Sounds like (optional, commas)", false);
        if (cur != null) {
            term.setText(cur.optString("term"));
            org.json.JSONArray snd = cur.optJSONArray("sounds");
            if (snd != null) sounds.setText(join(snd));
        }
        box.addView(term, Ui.fill());
        box.addView(sounds, Ui.margins(Ui.fill(), 0, 10, 0, 0));
        android.app.AlertDialog.Builder d = Ui.dialog(this).setTitle(at >= 0 ? "Edit word" : "Add a word").setView(box)
                .setNegativeButton("Cancel", null)
                .setPositiveButton("Save", (x, w) -> {
                    String t = term.getText().toString().trim();
                    if (t.isEmpty()) return;
                    try {
                        org.json.JSONObject e = new org.json.JSONObject().put("term", t);
                        org.json.JSONArray sa = new org.json.JSONArray();
                        for (String p : sounds.getText().toString().split(",")) if (!p.trim().isEmpty()) sa.put(p.trim());
                        e.put("sounds", sa);
                        org.json.JSONArray next = new org.json.JSONArray(words.toString());
                        if (at >= 0) next.put(at, e); else next.put(e);
                        putVoice("dictionary", next);
                    } catch (org.json.JSONException ignored) { }
                });
        if (at >= 0) d.setNeutralButton("Remove", (x, w) -> {
            org.json.JSONArray next = new org.json.JSONArray();
            for (int i = 0; i < words.length(); i++) if (i != at) next.put(words.opt(i));
            putVoice("dictionary", next);
        });
        d.show();
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
        for (Hub h : Hub.all(this)) o.add(new Sheet.Option(h.id, h.label(), pcCount(h), true));
        Sheet.pick(this, "Workspaces", null, o, hub.id, id -> {
            if (id.equals(hub.id)) return;
            Hub.setLast(this, id);
            startActivity(new Intent(this, Hubs.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP));
            startActivity(new Intent(this, Chats.class).putExtra("hub", id));
            finish();
        });
    }

    /** "2 PCs": a workspace's PCs, from the directory ("" when it isn't known). */
    private String pcCount(Hub h) {
        String ws = Account.wsOf(h);
        JSONObject w = ws == null ? null : Account.workspace(this, ws);
        int n = w == null || w.optJSONArray("pcs") == null ? 0 : w.optJSONArray("pcs").length();
        return n == 0 ? "" : n + (n == 1 ? " PC" : " PCs");
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (hub == null) return;
        warnRows(); // back from Android's "Install unknown apps"
        checkUpdates();
        gmailRow(); // back from Google's page or the account sheet
        discordRow();
        // An install that fails after its download (Android or Play Protect refused it).
        Update.changed = () -> { if (!isFinishing()) { warnRows(); checkUpdates(); } };
    }

    @Override
    protected void onPause() {
        super.onPause();
        Update.changed = null;
    }

    /** The Apps card's Gmail row: the PC's accounts; the card stays hidden on hubs before 0.95. */
    private void gmailRow() {
        if (gmailCard == null) return;
        Ui.pool.execute(() -> {
            try {
                JSONObject r = hub.get("/v1/apps/gmail");
                runOnUiThread(() -> {
                    gmailSub.setText(Gmail.summary(r));
                    gmailRowBox.setVisibility(View.VISIBLE);
                    gmailCard.setVisibility(View.VISIBLE);
                    appsHead.setVisibility(View.VISIBLE);
                    discordGap.setVisibility(View.VISIBLE);
                });
            } catch (Exception e) { /* an older hub: no such call */ }
        });
    }

    /** The Apps card's Discord row: `card.text` as the desktop shows it, coloured by its tone;
     *  hidden on hubs without the Discord app. */
    private void discordRow() {
        if (discordBox == null) return;
        String pc = hub.via();
        Ui.pool.execute(() -> {
            try {
                JSONObject r = hub.callOn(pc, "GET", "/v1/apps/discord", null);
                runOnUiThread(() -> {
                    discordSub.setText(Discord.summary(r));
                    discordSub.setTextColor(Discord.toneColor(Discord.tone(r)));
                    discordGap.setVisibility(gmailRowBox.getVisibility() == View.VISIBLE ? View.VISIBLE : View.GONE);
                    discordBox.setVisibility(View.VISIBLE);
                    gmailCard.setVisibility(View.VISIBLE);
                    appsHead.setVisibility(View.VISIBLE);
                });
            } catch (Exception e) { /* an older hub: no such call */ }
        });
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (Gmail.result(this, req, res, data)) gmailRow();
    }

    /** The newest app any PC offers (tap the row to ask again). */
    private void checkUpdates() {
        if (!installing) updateNote.setText("Checking every PC… · " + myName(this));
        Ui.pool.execute(() -> {
            // Every PC of every workspace: the one this phone talks to may offer an older app.
            long code = Update.check(getApplicationContext(), true);
            long mine = myCode(this);
            String where = Update.bestHub == null ? "" : pcName(Update.bestHub, Update.bestPc);
            String failed = code > mine ? Update.failure(getApplicationContext(), code) : "";
            String note = code <= 0 ? myName(this) + " · no PC answered to check for updates"
                    : code > mine ? "Version " + name(code) + " is ready" + (where.isEmpty() ? "" : " on " + where)
                        + (!failed.isEmpty() || Update.blocked(getApplicationContext()) ? ". Tap Update to install it"
                        : Update.silent(getApplicationContext(), code) ? ". It installs by itself the next time the screen is off" : "")
                    : "Up to date · " + name(mine);
            final String ff = failed; final long fc = code;
            Ui.main.post(() -> {
                if (isFinishing()) return;
                whyRows(ff);
                if (!installing) updateNote.setText(note); // else its progress stays on the line
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

    private void signOut() {
        Ui.dialog(this).setTitle("Sign out?")
                .setMessage("This phone forgets your PCs, and they stop taking it. Chats stay on the PCs.")
                .setNegativeButton("Cancel", null)
                .setPositiveButton("Sign out", (d, w) -> {
                    Account.signOut(this);
                    startActivity(new Intent(this, Hubs.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP));
                    finish();
                }).show();
    }
}
