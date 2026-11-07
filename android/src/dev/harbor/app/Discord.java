package dev.harbor.app;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.drawable.BitmapDrawable;
import android.view.Gravity;
import android.view.View;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

/** The Discord app of a PC, from the phone (Settings › Apps; hub `/v1/apps/discord`,
 *  android/PROTOCOL.md): the line the desktop's card shows, sign-out, a sign-in running on the PC
 *  (its QR code, to scan with the Discord app on another phone, and Cancel) and a captcha
 *  waiting for a person (DiscordCaptcha). Signing in only happens on the PC. The sheet asks
 *  again every 2 s while it's open: the QR rotates. Every call goes to one PC, the one Settings
 *  shows (the account lives on that PC). */
final class Discord {
    private Discord() { }

    private static Sheet sheet;
    /** Runs when the sheet closes (Settings updates its row). */
    static Runnable changed;
    /** Bumped when the sheet closes or opens again: stops the old one's polling. */
    private static int round;
    /** The QR drawn last, so a poll that brings the same one doesn't draw it again. */
    private static String qrKey;
    private static Bitmap qrBitmap;

    /** The colour of the card's line: 2 a warning, 1 the accent, 0 the usual grey. */
    static int toneColor(int tone) {
        return tone == 2 ? Ui.AMBER : tone == 1 ? Ui.BLUE : Ui.G700;
    }

    /** The row's subtitle: `card.text`, verbatim. Hubs of 0.114 answer without `card`: who is
     *  signed in, then. */
    static String summary(JSONObject r) {
        JSONObject c = r.optJSONObject("card");
        if (c != null) return c.optString("text");
        JSONObject acc = r.optJSONObject("account");
        if (acc == null) return "Not signed in";
        String n = acc.optString("name");
        return "Signed in as " + (n.isEmpty() ? acc.optString("username") : n);
    }

    static int tone(JSONObject r) {
        JSONObject c = r.optJSONObject("card");
        return c == null ? 0 : c.optInt("tone");
    }

    /** Opens the sheet for PC `pc` of `hub` ("" = its first PC). */
    static void show(Activity a, Hub hub, String pc) {
        Ui.bg(a, () -> hub.callOn(pc, "GET", "/v1/apps/discord", null), r -> open(a, hub, pc, r));
    }

    private static void open(Activity a, Hub hub, String pc, JSONObject r) {
        if (sheet != null) sheet.dismiss();
        Sheet s = new Sheet(a, "Discord");
        sheet = s;
        int my = ++round;
        render(a, hub, pc, s, r);
        s.dialog.setOnDismissListener(d -> {
            if (my == round) round++;
            if (sheet == s) sheet = null;
            if (changed != null) changed.run();
        });
        s.show();
        Ui.main.postDelayed(() -> poll(a, hub, pc, s, my), 2000);
    }

    /** One more look, two seconds after the last answer (never two at once). */
    private static void poll(Activity a, Hub hub, String pc, Sheet s, int my) {
        if (my != round || a.isFinishing() || a.isDestroyed()) return;
        Ui.pool.execute(() -> {
            JSONObject r = null;
            try { r = hub.callOn(pc, "GET", "/v1/apps/discord", null); } catch (Exception ignored) { /* the next one may answer */ }
            JSONObject got = r;
            Ui.main.post(() -> {
                if (my != round || a.isFinishing() || a.isDestroyed()) return;
                if (got != null) render(a, hub, pc, s, got);
                Ui.main.postDelayed(() -> poll(a, hub, pc, s, my), 2000);
            });
        });
    }

    private static void render(Activity a, Hub hub, String pc, Sheet s, JSONObject r) {
        s.body.removeAllViews();
        String where = hub.labelOn(pc);
        JSONObject acc = r.optJSONObject("account");
        JSONObject in = r.optJSONObject("signin");
        boolean signing = in != null && in.optBoolean("active");

        s.body.addView(Ui.text(a, "Agents on " + where + " can read and send on Discord as this account, only when you ask them to. The sign-in stays on the PC.", 14, Ui.G700),
                Ui.margins(Ui.fill(), 6, 0, 6, 12));

        LinearLayout c = s.card();
        LinearLayout state = Ui.cardRow(a, Ui.I_PLUG, "Discord on " + where, summary(r), Ui.FG, null);
        TextView sub = sub(state);
        if (sub != null) sub.setTextColor(toneColor(tone(r)));
        Ui.wrapSub(state, 4);
        c.addView(state, Ui.fill());
        if (acc != null) {
            String name = acc.optString("name");
            String user = acc.optString("username");
            c.addView(Ui.gap(a));
            LinearLayout row = Ui.cardRow(a, Ui.I_USER, name.isEmpty() ? user : name, name.isEmpty() || user.isEmpty() || name.equals(user) ? "" : user, Ui.FG, null);
            row.addView(Ui.button(a, "Sign out", false, v -> confirmOut(a, hub, pc, s)));
            c.addView(row, Ui.fill());
        } else if (!signing) {
            c.addView(Ui.gap(a));
            LinearLayout row = Ui.cardRow(a, Ui.I_MONITOR, "Not signed in", "Sign in on the PC: Settings › Integrations › Apps › Discord.", Ui.FG, null);
            Ui.wrapSub(row, 3);
            c.addView(row, Ui.fill());
        }

        // A join waiting on a captcha: a person solves it here (or on the PC).
        JSONObject cap = r.optJSONObject("captcha");
        if (cap != null) {
            LinearLayout cc = s.card();
            String guild = cap.optString("guild");
            LinearLayout row = Ui.cardRow(a, Ui.I_ALERT, "Discord needs a captcha", "To join " + (guild.isEmpty() ? "a server" : guild), Ui.AMBER, null);
            Ui.wrapSub(row, 2);
            cc.addView(row, Ui.fill());
            cc.addView(Ui.button(a, "Solve the captcha", true, v -> a.startActivity(new Intent(a, DiscordCaptcha.class).putExtra("hub", hub.id).putExtra("pc", pc))),
                    Ui.margins(Ui.fill(), 16, 0, 16, 14));
        }

        // A sign-in running on the PC: what it waits for, its QR code, Cancel.
        if (signing) {
            LinearLayout sc = s.card();
            String note = in.optString("note");
            sc.addView(Ui.text(a, note.isEmpty() ? "Signing in on " + where + "…" : note, 15, Ui.FG), Ui.margins(Ui.fill(), 18, 14, 18, 8));
            String err = in.optString("error");
            if (!in.isNull("error") && !err.isEmpty()) sc.addView(Ui.text(a, err, 14, Ui.AMBER), Ui.margins(Ui.fill(), 18, 0, 18, 8));
            Bitmap qr = qr(a, r.optJSONObject("qr"));
            if (qr != null) {
                ImageView iv = new ImageView(a);
                BitmapDrawable d = new BitmapDrawable(a.getResources(), qr);
                d.setFilterBitmap(false); // modules stay sharp
                iv.setImageDrawable(d);
                LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(qr.getWidth(), qr.getHeight());
                lp.gravity = Gravity.CENTER_HORIZONTAL;
                lp.topMargin = Ui.dp(4);
                sc.addView(iv, lp);
                TextView cap2 = Ui.text(a, "Scan with the Discord app on another phone", 13, Ui.G700);
                cap2.setGravity(Gravity.CENTER);
                sc.addView(cap2, Ui.margins(Ui.fill(), 18, 8, 18, 4));
            }
            sc.addView(Ui.button(a, "Cancel", false, v -> post(a, hub, pc, s, "cancel")), Ui.margins(Ui.fill(), 16, 8, 16, 14));
        }
    }

    /** A cardRow's line under its title (WhatsApp's sheet too). */
    static TextView subOf(LinearLayout row) { return sub(row); }

    /** A cardRow's line under its title. */
    private static TextView sub(LinearLayout row) {
        for (int i = 0; i < row.getChildCount(); i++) {
            View v = row.getChildAt(i);
            if (v instanceof LinearLayout && ((LinearLayout) v).getChildCount() > 1 && ((LinearLayout) v).getChildAt(1) instanceof TextView)
                return (TextView) ((LinearLayout) v).getChildAt(1);
        }
        return null;
    }

    /** The hub's `qr` ({size, rows}) as a bitmap of whole pixels a module, about 220 dp wide. */
    private static Bitmap qr(Activity a, JSONObject q) {
        JSONArray rows = q == null ? null : q.optJSONArray("rows");
        if (rows == null || rows.length() == 0) return null;
        String[] rs = new String[rows.length()];
        for (int i = 0; i < rs.length; i++) rs[i] = rows.optString(i, "");
        int scale = DiscordKit.scale(rs, Ui.dp(220));
        String key = String.join("\n", rs) + "|" + scale;
        if (key.equals(qrKey) && qrBitmap != null) return qrBitmap;
        int side = DiscordKit.modules(rs) * scale;
        qrBitmap = Bitmap.createBitmap(DiscordKit.pixels(rs, scale), side, side, Bitmap.Config.ARGB_8888);
        qrKey = key;
        return qrBitmap;
    }

    private static void confirmOut(Activity a, Hub hub, String pc, Sheet s) {
        Ui.dialog(a).setTitle("Sign out of Discord on " + hub.labelOn(pc) + "?")
                .setMessage("Agents there can't use Discord until someone signs in again on the PC.")
                .setPositiveButton("Sign out", (d, w) -> post(a, hub, pc, s, "signout"))
                .setNegativeButton("Cancel", null).show();
    }

    private static void post(Activity a, Hub hub, String pc, Sheet s, String action) {
        Ui.bg(a, () -> hub.callOn(pc, "POST", "/v1/apps/discord/" + action, new JSONObject()), r -> {
            if (sheet == s) render(a, hub, pc, s, r);
        });
    }
}
