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
 *  account, the workspace's members (owners invite by email) and PCs (each with the machines it
 *  added over SSH), the PCs' apps, voice, notifications, this app and its updates, sign out.
 *  Light or dark is the drawer's sun/moon (Ui.flipTheme). Settings that were dropped keep a
 *  fixed value in code: rows are the comfortable ones (no Density), updates install by
 *  themselves (Update), sending while
 *  the agent works steers (Chat.FOLLOW_UP), web links open in the built-in browser, dictation
 *  detects the language and takes spoken commands (Voice), the PCs transcribe every dictation
 *  (Asr keeps no model), and notifications are instant (Listen) and come whether or not you're
 *  at that PC (Notes). */
public class Settings extends Base {
    private TextView updateNote, gmailSub, discordSub, whatsappSub, appsHead;
    private LinearLayout gmailCard, gmailRowBox, discordBox, whatsappBox, voiceCard;
    private TextView voiceHead;
    private TextView wtHead;
    private LinearLayout wtCard;
    private View discordGap;
    private View updateBtn;
    private long available;
    private boolean installing;
    /** Android's "Install unknown apps" was opened from Update: install once it's allowed. */
    private boolean installWhenAllowed;
    /** Why the version on offer didn't install by itself ("" none). */
    private String failedWhy = "";

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
        // The machines each PC added over SSH (GET /v1/hubs `devices`, hubs from 0.150), under it in PCs.
        Ui.pool.execute(() -> {
            try {
                org.json.JSONArray hs = hub.get("/v1/hubs").optJSONArray("hubs");
                if (hs == null) return;
                runOnUiThread(() -> { sshHubs = hs; workspaceRows(); });
            } catch (Exception e) { /* offline: the PCs alone */ }
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
        // WhatsApp (GET /v1/apps/whatsapp; hidden on hubs without it): the desktop card's line.
        whatsappBox = Ui.col(this);
        whatsappBox.setVisibility(View.GONE);
        LinearLayout wa = Ui.cardRow(this, Ui.I_PLUG, "WhatsApp", "…", Ui.FG, v -> {
            WhatsApp.changed = this::whatsappRow;
            WhatsApp.show(this, hub, hub.via());
        });
        wa.addView(Ui.chevron(this));
        Ui.wrapSub(wa, 3);
        whatsappBox.addView(Ui.gap(this));
        whatsappBox.addView(wa, Ui.fill());
        apps.addView(whatsappBox, Ui.fill());
        whatsappSub = (TextView) ((LinearLayout) wa.getChildAt(1)).getChildAt(1);
        if (getIntent().getBooleanExtra("whatsapp", false)) {
            WhatsApp.changed = this::whatsappRow;
            WhatsApp.show(this, hub, hub.via());
        }

        // Dictation in the composer (Voice): the PC's dictionary (GET /v1/voice, PUT
        // /v1/voice/settings; the section stays hidden on hubs without one).
        voiceHead = section(col, "Voice");
        voiceHead.setVisibility(View.GONE);
        voiceCard = card(col);
        voiceCard.setVisibility(View.GONE);
        Ui.pool.execute(() -> {
            try {
                org.json.JSONObject v = hub.call("GET", "/v1/voice", null, 8000);
                runOnUiThread(() -> {
                    // Hubs before 0.76 have no dictionary: the section stays hidden.
                    words = v.has("dictionary") ? v.optJSONArray("dictionary") : null;
                    voiceRows();
                });
            } catch (Exception e) { /* an older hub: no such call */ }
        });

        // Merged worktrees (GET/PUT /v1/worktrees/settings, the desktop's General › Worktrees; the
        // section stays hidden on hubs without it): account settings, the same on every PC.
        wtHead = section(col, "Worktrees");
        wtHead.setVisibility(View.GONE);
        wtCard = card(col);
        wtCard.setVisibility(View.GONE);
        Ui.pool.execute(() -> {
            try {
                JSONObject v = hub.call("GET", "/v1/worktrees/settings", null, 8000);
                runOnUiThread(() -> worktreeRows(v));
            } catch (Exception e) { /* an older hub: no such call */ }
        });

        // Notifications (Notes): what the PCs tell this phone about, and when.
        section(col, "Notifications");
        LinearLayout nt = card(col);
        notifyRows(nt);

        // This app: one row for its version and its update (any PC offers the newest it has),
        // with whatever keeps the automatic install from going in said on its line.
        section(col, "App");
        LinearLayout app = card(col);
        LinearLayout updateRow = Ui.cardRow(this, Ui.I_PHONE, "Harbor for Android", myName(this), Ui.FG, v -> updateTapped());
        updateNote = (TextView) ((LinearLayout) updateRow.getChildAt(1)).getChildAt(1);
        updateBtn = Ui.button(this, "Update", true, v -> update());
        updateBtn.setVisibility(View.GONE);
        updateRow.addView(updateBtn);
        Ui.wrapSub(updateRow, 4);
        // Why the last install didn't go in: Android's whole message, to read or copy.
        updateRow.setOnLongClickListener(v -> { whyDialog(); return true; });
        app.addView(updateRow, Ui.fill());
        showUpdate(Math.max(Update.known(this), available)); // the version already known to be on offer: no wait for a check

        LinearLayout bye = card(col);
        bye.addView(Ui.cardRow(this, Ui.I_PLUG, "Sign out", Account.email(this), Ui.RED, v -> signOut()), Ui.fill());
    }

    /** A section's title over its cards. */
    private TextView section(LinearLayout col, String title) {
        TextView t = Ui.bold(this, title, 14, Ui.G700);
        t.setPadding(Ui.dp(18), Ui.dp(10), Ui.dp(18), Ui.dp(8));
        col.addView(t, Ui.fill());
        return t;
    }

    /** Someone's round photo (`image`, a URL) the size of a card row's icon disc, their initials
     *  until it's here or when they have none. */
    private View avatar(String name, String image) {
        return avatar(name, image, 36);
    }

    private View avatar(String name, String image, int dp) {
        String[] w = name.trim().split("[\\s@._-]+");
        String ini = w.length == 0 || w[0].isEmpty() ? "?" : (w[0].substring(0, 1) + (w.length > 1 && !w[1].isEmpty() ? w[1].substring(0, 1) : "")).toUpperCase();
        FrameLayout f = new FrameLayout(this);
        f.setBackground(Ui.round(Ui.G200, 0, dp / 2));
        TextView t = Ui.bold(this, ini, dp * 13 / 36, Ui.FG);
        t.setGravity(android.view.Gravity.CENTER);
        f.addView(t, new FrameLayout.LayoutParams(-1, -1));
        f.setLayoutParams(new LinearLayout.LayoutParams(Ui.dp(dp), Ui.dp(dp)));
        Avatars.into(f, t, image);
        return f;
    }

    private String myPhoto() {
        return Account.photo(this);
    }

    /** Your photo: everyone in your workspaces sees it beside your name. Pick one from the
     *  phone's photos (cropped square), or remove it for your initials. */
    private void photoSheet() {
        Sheet s = new Sheet(this, "Your photo");
        LinearLayout top = Ui.col(this);
        top.setGravity(android.view.Gravity.CENTER_HORIZONTAL);
        top.setPadding(0, Ui.dp(4), 0, Ui.dp(14));
        top.addView(avatar(Account.name(this), myPhoto(), 96));
        TextView note = Ui.text(this, "Everyone in your workspaces sees it beside your name.", 14, Ui.G700);
        note.setGravity(android.view.Gravity.CENTER);
        note.setPadding(Ui.dp(12), Ui.dp(12), Ui.dp(12), 0);
        top.addView(note, Ui.fill());
        s.body.addView(top, Ui.fill());
        LinearLayout c = s.card();
        c.addView(Ui.cardRow(this, Ui.I_IMAGE, myPhoto().isEmpty() ? "Choose a photo" : "Choose another photo", null, Ui.FG, v -> {
            s.dismiss();
            pickImage(uri -> act(() -> Account.putPhoto(this, Avatars.forUpload(this, uri)), "Photo saved"));
        }), Ui.fill());
        if (!myPhoto().isEmpty()) {
            c.addView(Ui.gap(this));
            c.addView(Ui.cardRow(this, Ui.I_TRASH, "Remove photo", "Your initials instead", Ui.RED, v -> {
                s.dismiss();
                act(() -> Account.deletePhoto(this), "Photo removed");
            }), Ui.fill());
        }
        s.show();
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
    /** GET /v1/hubs's list, for the SSH devices each PC added (null until it's here). */
    private org.json.JSONArray sshHubs;

    /** The SSH devices the PC `p` (a directory entry) added, as GET /v1/hubs says: by its key, else
     *  its id. Ones named like one of the workspace's PCs are that PC, listed already. */
    private java.util.List<String> sshDevices(JSONObject p, org.json.JSONArray pcs) {
        java.util.List<String> out = new java.util.ArrayList<>();
        if (sshHubs == null) return out;
        String fp = Addr.fp(p.optString("fp")), id = p.optString("id");
        for (int i = 0; i < sshHubs.length(); i++) {
            JSONObject h = sshHubs.optJSONObject(i);
            if (h == null) continue;
            String hfp = Addr.fp(h.optString("fp"));
            boolean same = fp != null && hfp != null ? fp.equals(hfp) : !id.isEmpty() && id.equals(h.optString("id"));
            if (!same) continue;
            org.json.JSONArray ds = h.optJSONArray("devices");
            for (int j = 0; ds != null && j < ds.length(); j++) {
                JSONObject d = ds.optJSONObject(j);
                String n = d == null ? "" : d.optString("name");
                if (n.isEmpty() || out.contains(n)) continue;
                boolean isPc = false;
                for (int k = 0; k < pcs.length(); k++) { JSONObject q = pcs.optJSONObject(k); if (q != null && n.equals(q.optString("name"))) isPc = true; }
                if (!isPc) out.add(n);
            }
            break;
        }
        return out;
    }

    /** Account: signed in as…, People and memory, invitations to other workspaces. Members:
     *  this workspace's people (owners invite and remove; anyone leaves a workspace that isn't
     *  their own), its pending invitations. PCs: the workspace's PCs, then your other workspaces' ones, each
     *  as "Your Workspace" or its owner's ("Sam's Workspace"), with its SSH machines ("SSH") under it. */
    private void workspaceRows() {
        wsBox.removeAllViews();
        section(wsBox, "Account");
        LinearLayout acct = card(wsBox);
        acct.addView(Ui.cardRow(this, avatar(Account.name(this), myPhoto()), Account.name(this), Account.email(this) + " · Google", Ui.FG, v -> photoSheet()), Ui.fill());
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
            View.OnClickListener tap = self ? v -> photoSheet() : owner ? v -> confirmRemove(ws, uid, false, nm) : null;
            if (people.getChildCount() > 0) people.addView(Ui.gap(this));
            LinearLayout r = Ui.cardRow(this, avatar(nm, self ? myPhoto() : m.optString("image")), nm + (self ? " (you)" : ""), m.optString("email"), Ui.FG, tap);
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

        // This workspace's PCs, then those of your other workspaces (each once).
        org.json.JSONArray pcs = new org.json.JSONArray();
        java.util.Set<String> seen = new java.util.HashSet<>();
        org.json.JSONArray all = Account.directory(this).optJSONArray("workspaces");
        for (int pass = 0; pass < 2; pass++)
            for (int k = 0; all != null && k < all.length(); k++) {
                JSONObject o = all.optJSONObject(k);
                if (o == null || ws.equals(o.optString("id")) != (pass == 0)) continue;
                org.json.JSONArray op = o.optJSONArray("pcs");
                for (int i = 0; op != null && i < op.length(); i++) {
                    JSONObject p = op.optJSONObject(i);
                    String key = p == null ? "" : p.optString("fp").isEmpty() ? p.optString("id") : p.optString("fp");
                    if (p != null && seen.add(key)) pcs.put(p);
                }
            }
        if (pcs.length() == 0) return;
        section(wsBox, "PCs");
        LinearLayout pcCard = card(wsBox);
        for (int i = 0; i < pcs.length(); i++) {
            JSONObject p = pcs.optJSONObject(i);
            if (pcCard.getChildCount() > 0) pcCard.addView(Ui.gap(this));
            boolean mine = p.optString("owner").equals(me);
            pcCard.addView(Ui.cardRow(this, Ui.disc(this, Ui.I_MONITOR, 36), p.optString("name"), mine ? "Your Workspace" : ownersWorkspace(p.optString("owner_name")), Ui.FG, null), Ui.fill());
            // The machines it added over SSH (a Mac it dictates on, a build box): right under it.
            for (String d : sshDevices(p, pcs)) {
                pcCard.addView(Ui.gap(this));
                pcCard.addView(Ui.cardRow(this, Ui.disc(this, Ui.I_LAPTOP, 36), d, "SSH", Ui.FG, null), Ui.fill());
            }
        }
    }

    /** A PC someone else added, by their first name (settings-devices.ts ownersWorkspace): "Sam's Workspace". */
    static String ownersWorkspace(String ownerName) {
        String first = ownerName.trim().split("\\s+")[0];
        return first.isEmpty() ? "Shared workspace" : first + "'s Workspace";
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

    /** The update row's tap: the update when one is ready, Play Protect's way out when it blocks
     *  background installs, Android's "Install unknown apps" when it isn't allowed, else ask the
     *  PCs again. */
    private void updateTapped() {
        if (installing) return;
        if (available > myCode(this)) { update(); return; }
        if (!getPackageManager().canRequestPackageInstalls()) { allowInstalls(); return; }
        if (Update.blocked(this)) {
            Ui.dialog(this).setTitle("Play Protect asks before updates")
                    .setMessage("Google Play Protect wants to scan each new version, so updates come as a notification: tap it, then Scan app. "
                            + "To let them install by themselves, turn on Play Store › your picture › Play Protect › ⚙ › Improve harmful app detection, then try again.")
                    .setNegativeButton("Close", null)
                    .setPositiveButton("Try again", (d, w) -> {
                        Update.unblock(this);
                        Ui.toast(this, "The next version tries the background again");
                        refreshUpdate();
                    }).show();
            return;
        }
        checkUpdates();
    }

    /** The long press: Android's whole reason the last install failed. */
    private void whyDialog() {
        if (failedWhy.isEmpty()) return;
        Ui.dialog(this).setTitle("Why it didn't install").setMessage(failedWhy)
                .setNegativeButton("Copy", (d, w) -> Ui.copy(this, failedWhy))
                .setPositiveButton("Close", null).show();
    }

    /** Android's "Install unknown apps" for Harbor, straight away: asked once, for every update
     *  after it. Back here with it allowed, a ready update installs (onResume). */
    private void allowInstalls() {
        installWhenAllowed = available > myCode(this);
        Ui.toast(this, "Turn on “Allow from this source” for Harbor, then come back");
        try {
            startActivity(new Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getPackageName())));
        } catch (Exception e) {
            installWhenAllowed = false;
            Ui.toast(this, "Android's settings didn't open: " + e.getMessage());
        }
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

    /** Merged worktrees: one row saying what goes, tap to change it. */
    private void worktreeRows(JSONObject v) {
        wtCard.removeAllViews();
        wtHead.setVisibility(View.VISIBLE);
        wtCard.setVisibility(View.VISIBLE);
        boolean on = v.optBoolean("delete_merged", true), br = v.optBoolean("delete_branch", true), rm = v.optBoolean("delete_remote", false);
        String sub = !on ? "Off: merged worktrees stay" : "Once a chat's PR is merged" + (br ? (rm ? " · branches too, here and on GitHub" : " · their branches too") : "");
        LinearLayout row = Ui.cardRow(this, Ui.I_FOLDER_GIT, "Delete merged worktrees", sub, Ui.FG, x -> pickWorktrees(v));
        Ui.wrapSub(row, 2);
        row.addView(Ui.chevron(this));
        wtCard.addView(row, Ui.fill());
    }

    private void pickWorktrees(JSONObject v) {
        String[] keys = { "delete_merged", "delete_branch", "delete_remote" };
        String[] labels = { "Delete merged worktrees", "Also delete their branches", "Also delete their branches on GitHub" };
        boolean[] on = { v.optBoolean(keys[0], true), v.optBoolean(keys[1], true), v.optBoolean(keys[2], false) };
        Ui.dialog(this).setTitle("Merged worktrees")
                .setMultiChoiceItems(labels, on, (d, i, x) -> on[i] = x)
                .setNegativeButton("Cancel", null)
                .setPositiveButton("OK", (d, w) -> Ui.pool.execute(() -> {
                    try {
                        JSONObject b = new JSONObject();
                        for (int i = 0; i < keys.length; i++) b.put(keys[i], on[i]);
                        JSONObject r = hub.call("PUT", "/v1/worktrees/settings", b);
                        runOnUiThread(() -> worktreeRows(r));
                    } catch (Exception e) {
                        runOnUiThread(() -> Ui.toast(this, Hub.why(e)));
                    }
                })).show();
    }

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
        // Back from Android's "Install unknown apps": the update it was opened for goes in.
        if (installWhenAllowed && getPackageManager().canRequestPackageInstalls()) {
            installWhenAllowed = false;
            update();
        } else {
            installWhenAllowed = false;
            refreshUpdate();
        }
        gmailRow(); // back from Google's page or the account sheet
        discordRow();
        whatsappRow();
        // An install that fails after its download (Android or Play Protect refused it).
        Update.changed = () -> { if (!isFinishing()) refreshUpdate(); };
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

    /** The Apps card's WhatsApp row: `card.text` as the desktop shows it, coloured by its tone;
     *  hidden on hubs without the WhatsApp app. */
    private void whatsappRow() {
        if (whatsappBox == null) return;
        String pc = hub.via();
        Ui.pool.execute(() -> {
            try {
                JSONObject r = hub.callOn(pc, "GET", "/v1/apps/whatsapp", null);
                runOnUiThread(() -> {
                    whatsappSub.setText(WhatsApp.summary(r));
                    whatsappSub.setTextColor(Discord.toneColor(WhatsApp.tone(r)));
                    whatsappBox.setVisibility(View.VISIBLE);
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

    /** The row from what's known, then a quiet look at the PCs (at most every 10 minutes,
     *  Update.check): an update already known shows its Update button straight away. */
    private void refreshUpdate() {
        showUpdate(Update.known(this));
        Ui.pool.execute(() -> {
            long code = Update.check(getApplicationContext(), false);
            Ui.main.post(() -> { if (!isFinishing()) showUpdate(Math.max(code, Update.known(this))); });
        });
    }

    /** Up to date, tapped: asks every PC again, now. */
    private void checkUpdates() {
        if (!installing) updateNote.setText("Checking every PC… · " + myName(this));
        Ui.pool.execute(() -> {
            // Every PC of every workspace: the one this phone talks to may offer an older app.
            long code = Update.check(getApplicationContext(), true);
            Ui.main.post(() -> {
                if (isFinishing()) return;
                if (code <= 0 && !installing) { updateNote.setText(myName(this) + " · no PC answered to check for updates"); return; }
                showUpdate(code);
            });
        });
    }

    /** The row for app `code` on offer: its version and an Update button when it's newer than
     *  this one, else just this version. A download in progress keeps its line. */
    private void showUpdate(long code) {
        if (installing) return; // its progress stays on the line
        long mine = myCode(this);
        Context c = getApplicationContext();
        boolean allowed = getPackageManager().canRequestPackageInstalls(), blocked = Update.blocked(c);
        String failed = code > mine ? Update.failure(c, code) : "";
        String note;
        if (code > mine) {
            note = "Version " + name(code) + " is ready";
        } else {
            note = name(mine) + " · up to date"
                    + (!allowed ? " · tap to let updates install by themselves" : blocked ? " · Play Protect asks before each update: tap for how" : "");
        }
        failedWhy = failed;
        updateNote.setText(note);
        available = code;
        updateBtn.setVisibility(code > mine ? View.VISIBLE : View.GONE);
    }

    /** 7001 -> 0.7.1 (android/build.sh: major*1000000 + minor*1000 + patch). */
    static String name(long code) {
        return (code / 1000000) + "." + (code / 1000 % 1000) + "." + (code % 1000);
    }

    private void update() {
        if (installing) return;
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
