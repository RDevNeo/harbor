package dev.harbor.app;

import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.drawable.BitmapDrawable;
import android.view.Gravity;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

/** The WhatsApp app of a PC, from the phone (Settings › Apps; hub `/v1/apps/whatsapp`,
 *  android/PROTOCOL.md), as the desktop's Integrations card has it: one row (logo, "WhatsApp",
 *  the card's line) with Sign in (straight to the QR), or the green "Signed in" badge and Sign out, or Cancel while
 *  a link waits, its QR under it. A link runs on the PC, which shows the same QR: a phone can't
 *  scan its own screen, so it's scanned from another phone, or this one scans the PC's. The
 *  sheet asks again every 2 s while it's open: the QR rotates. Every call goes to one PC, the
 *  one Settings shows (the link lives on that PC). */
final class WhatsApp {
    private WhatsApp() { }

    private static Sheet sheet;
    /** Runs when the sheet closes (Settings updates its row). */
    static Runnable changed;
    /** Bumped when the sheet closes or opens again: stops the old one's polling. */
    private static int round;
    private static String qrKey;
    private static Bitmap qrBitmap;
    /** The answer last drawn: a poll that brings the same one doesn't redraw (a redraw under a
     *  finger loses its tap). */
    private static String drawn = "";
    /** WhatsApp's mark, in its brand green (assets/logos/whatsapp.a8, the desktop's). */
    static final int BRAND = 0xff25d366;

    /** The row's subtitle: `card.text`, verbatim (the desktop card's line). */
    static String summary(JSONObject r) {
        JSONObject c = r.optJSONObject("card");
        if (c != null) return c.optString("text");
        return r.optBoolean("linked") ? "Signed in" : "Not signed in";
    }

    static int tone(JSONObject r) {
        JSONObject c = r.optJSONObject("card");
        return c == null ? 0 : c.optInt("tone");
    }

    /** Opens the sheet for PC `pc` of `hub` ("" = its first PC). */
    static void show(Activity a, Hub hub, String pc) {
        Ui.bg(a, () -> hub.callOn(pc, "GET", "/v1/apps/whatsapp", null), r -> open(a, hub, pc, r));
    }

    private static void open(Activity a, Hub hub, String pc, JSONObject r) {
        if (sheet != null) sheet.dismiss();
        Sheet s = new Sheet(a, "WhatsApp");
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

    private static void poll(Activity a, Hub hub, String pc, Sheet s, int my) {
        if (my != round || a.isFinishing() || a.isDestroyed()) return;
        Ui.pool.execute(() -> {
            JSONObject r = null;
            try { r = hub.callOn(pc, "GET", "/v1/apps/whatsapp", null); } catch (Exception ignored) { /* the next one may answer */ }
            JSONObject got = r;
            Ui.main.post(() -> {
                if (my != round || a.isFinishing() || a.isDestroyed()) return;
                if (got != null && !got.toString().equals(drawn)) render(a, hub, pc, s, got);
                Ui.main.postDelayed(() -> poll(a, hub, pc, s, my), 2000);
            });
        });
    }

    private static void render(Activity a, Hub hub, String pc, Sheet s, JSONObject r) {
        drawn = r.toString();
        s.body.removeAllViews();
        String where = hub.labelOn(pc);
        JSONObject link = r.optJSONObject("pairing");
        boolean linked = r.optBoolean("linked");

        s.body.addView(Ui.text(a, "Agents on " + where + " can read and send on WhatsApp as you, only when you ask them to. The link and your chats stay on the PC.", 14, Ui.G700),
                Ui.margins(Ui.fill(), 6, 0, 6, 12));

        // The desktop card's head: logo, name, its line, and its badge and button.
        LinearLayout c = s.card();
        LinearLayout row = Ui.cardRow(a, Ui.appTile(a, "whatsapp.a8", BRAND, 40), "WhatsApp", summary(r), Ui.FG, null);
        TextView sub = Discord.subOf(row);
        if (sub != null) sub.setTextColor(Discord.toneColor(tone(r)));
        // The whole line, as the desktop's wider card shows it: it wraps beside the badge and button.
        Ui.wrapSub(row, 3);
        if (link != null) {
            row.addView(Ui.rowButton(a, "Cancel", false, v -> post(a, hub, pc, s, "cancel")), trailing());
        } else if (linked) {
            row.addView(Ui.pill(a, "Signed in"), trailing());
            row.addView(Ui.rowButton(a, "Sign out", false, v -> confirmOut(a, hub, pc, s)), trailing());
        } else {
            row.addView(Ui.rowButton(a, "Sign in", true, v -> post(a, hub, pc, s, "link")), trailing());
        }
        c.addView(row, Ui.fill());
        if (link != null) qrCode(a, c, r);
    }

    private static LinearLayout.LayoutParams trailing() {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.leftMargin = Ui.dp(6);
        lp.gravity = Gravity.CENTER_VERTICAL;
        return lp;
    }

    /** A link waiting for a phone: only its QR and how to scan it, under the row. */
    private static void qrCode(Activity a, LinearLayout c, JSONObject r) {
        Bitmap qr = qr(r.optJSONObject("qr"));
        if (qr != null) {
            ImageView iv = new ImageView(a);
            BitmapDrawable d = new BitmapDrawable(a.getResources(), qr);
            d.setFilterBitmap(false);
            iv.setImageDrawable(d);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(qr.getWidth(), qr.getHeight());
            lp.gravity = Gravity.CENTER_HORIZONTAL;
            lp.topMargin = Ui.dp(2);
            c.addView(iv, lp);
        }
        TextView cap = Ui.text(a, "Scan it with WhatsApp on another phone, or scan the PC's screen with this one: WhatsApp › Settings › Linked devices › Link a device.", 13, Ui.G700);
        cap.setGravity(Gravity.CENTER);
        c.addView(cap, Ui.margins(Ui.fill(), 18, 10, 18, 16));
    }

    /** The hub's `qr` ({size, rows}) as a bitmap of whole pixels a module, about 240 dp wide. */
    private static Bitmap qr(JSONObject q) {
        JSONArray rows = q == null ? null : q.optJSONArray("rows");
        if (rows == null || rows.length() == 0) return null;
        String[] rs = new String[rows.length()];
        for (int i = 0; i < rs.length; i++) rs[i] = rows.optString(i, "");
        int scale = DiscordKit.scale(rs, Ui.dp(240));
        String key = String.join("\n", rs) + "|" + scale;
        if (key.equals(qrKey) && qrBitmap != null) return qrBitmap;
        int side = DiscordKit.modules(rs) * scale;
        qrBitmap = Bitmap.createBitmap(DiscordKit.pixels(rs, scale), side, side, Bitmap.Config.ARGB_8888);
        qrKey = key;
        return qrBitmap;
    }

    private static void confirmOut(Activity a, Hub hub, String pc, Sheet s) {
        Ui.dialog(a).setTitle("Sign out of WhatsApp on " + hub.labelOn(pc) + "?")
                .setMessage("WhatsApp drops that device, and the chats Harbor stored there are deleted. Agents there can't use WhatsApp until you link it again.")
                .setPositiveButton("Sign out", (d, w) -> post(a, hub, pc, s, "signout"))
                .setNegativeButton("Cancel", null).show();
    }

    private static void post(Activity a, Hub hub, String pc, Sheet s, String action) {
        Ui.bg(a, () -> {
            JSONObject b = new JSONObject();
            if ("link".equals(action)) b.put("accept", true);
            return hub.callOn(pc, "POST", "/v1/apps/whatsapp/" + action, b);
        }, r -> {
            if (sheet == s) render(a, hub, pc, s, r);
        });
    }
}
