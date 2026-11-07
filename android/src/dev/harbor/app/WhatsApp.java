package dev.harbor.app;

import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.drawable.BitmapDrawable;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

/** The WhatsApp app of a PC, from the phone (Settings › Apps; hub `/v1/apps/whatsapp`,
 *  android/PROTOCOL.md), as the desktop's card has it: the card's line, who is linked and
 *  Unlink, or a link to start. A link runs on the PC; this sheet shows its QR code (for
 *  another phone's camera) and, since a phone can't scan its own screen, asks for this
 *  phone's number to get the code WhatsApp's "Link with phone number instead" takes. The
 *  sheet asks again every 2 s while it's open: the QR rotates. Every call goes to one PC,
 *  the one Settings shows (the link lives on that PC). */
final class WhatsApp {
    private WhatsApp() { }

    private static Sheet sheet;
    /** Runs when the sheet closes (Settings updates its row). */
    static Runnable changed;
    /** Bumped when the sheet closes or opens again: stops the old one's polling. */
    private static int round;
    private static String qrKey;
    private static Bitmap qrBitmap;
    /** The number typed so far: the sheet redraws every 2 s and mustn't lose it. */
    private static String typed = "";

    static final String WARNING = "Harbor links to your WhatsApp as another device, like WhatsApp Web, through an "
            + "unofficial client. WhatsApp's terms don't allow that and can ban the account. Agents send only what "
            + "you ask, paced, never in bulk. Chats are stored on the PC only.";

    /** The row's subtitle: `card.text`, verbatim (the desktop card's line). */
    static String summary(JSONObject r) {
        JSONObject c = r.optJSONObject("card");
        if (c != null) return c.optString("text");
        return r.optBoolean("linked") ? "Linked" : "Not linked";
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
        typed = "";
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
                // Never while the number is being typed: a redraw would take the keyboard away.
                if (got != null && !typing(s)) render(a, hub, pc, s, got);
                Ui.main.postDelayed(() -> poll(a, hub, pc, s, my), 2000);
            });
        });
    }

    private static boolean typing(Sheet s) {
        View f = s.body.findFocus();
        return f instanceof EditText;
    }

    private static void render(Activity a, Hub hub, String pc, Sheet s, JSONObject r) {
        s.body.removeAllViews();
        String where = hub.labelOn(pc);
        JSONObject acc = r.optJSONObject("account");
        JSONObject link = r.optJSONObject("pairing");
        boolean linked = r.optBoolean("linked");

        s.body.addView(Ui.text(a, "Agents on " + where + " can read and send on WhatsApp as you, only when you ask them to. The link and your chats stay on the PC.", 14, Ui.G700),
                Ui.margins(Ui.fill(), 6, 0, 6, 12));

        LinearLayout c = s.card();
        LinearLayout state = Ui.cardRow(a, Ui.I_PLUG, "WhatsApp on " + where, summary(r), Ui.FG, null);
        TextView sub = Discord.subOf(state);
        if (sub != null) sub.setTextColor(Discord.toneColor(tone(r)));
        Ui.wrapSub(state, 4);
        c.addView(state, Ui.fill());
        if (linked && acc != null) {
            String name = acc.optString("name");
            String jid = acc.optString("jid");
            String phone = jid.contains("@") ? "+" + jid.substring(0, jid.indexOf('@')) : jid;
            c.addView(Ui.gap(a));
            LinearLayout row = Ui.cardRow(a, Ui.I_USER, name.isEmpty() ? phone : name, name.isEmpty() ? "" : phone, Ui.FG, null);
            row.addView(Ui.button(a, "Unlink", false, v -> confirmOut(a, hub, pc, s)));
            c.addView(row, Ui.fill());
        } else if (link == null) {
            c.addView(Ui.button(a, "Link", true, v -> confirmLink(a, hub, pc, s)), Ui.margins(Ui.fill(), 16, 4, 16, 14));
        }

        if (link != null) linking(a, hub, pc, s, r, link, where);
    }

    /** A link waiting for the phone: its QR, its code or a number to get one, Cancel. */
    private static void linking(Activity a, Hub hub, String pc, Sheet s, JSONObject r, JSONObject link, String where) {
        LinearLayout sc = s.card();
        String code = link.isNull("code") ? "" : link.optString("code");
        String note = link.optString("note");
        sc.addView(Ui.text(a, note.isEmpty() ? "Linking on " + where + "…" : note, 15, Ui.FG), Ui.margins(Ui.fill(), 18, 14, 18, 8));
        if (!code.isEmpty()) {
            TextView big = Ui.text(a, code, 30, Ui.FG);
            big.setGravity(Gravity.CENTER);
            big.setTypeface(android.graphics.Typeface.MONOSPACE);
            sc.addView(big, Ui.margins(Ui.fill(), 18, 4, 18, 6));
            sc.addView(Ui.text(a, "In WhatsApp: Settings › Linked devices › Link a device › Link with phone number instead, then type this code.", 13, Ui.G700),
                    Ui.margins(Ui.fill(), 18, 0, 18, 8));
            sc.addView(Ui.button(a, "Copy code", true, v -> { Ui.copy(a, code.replace("-", "")); Ui.toast(a, "Copied"); }), Ui.margins(Ui.fill(), 16, 4, 16, 4));
        } else {
            Bitmap qr = qr(r.optJSONObject("qr"));
            if (qr != null) {
                ImageView iv = new ImageView(a);
                BitmapDrawable d = new BitmapDrawable(a.getResources(), qr);
                d.setFilterBitmap(false);
                iv.setImageDrawable(d);
                LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(qr.getWidth(), qr.getHeight());
                lp.gravity = Gravity.CENTER_HORIZONTAL;
                lp.topMargin = Ui.dp(4);
                sc.addView(iv, lp);
                TextView cap = Ui.text(a, "Scan from the phone with WhatsApp: Settings › Linked devices › Link a device.", 13, Ui.G700);
                cap.setGravity(Gravity.CENTER);
                sc.addView(cap, Ui.margins(Ui.fill(), 18, 8, 18, 4));
            }
            sc.addView(Ui.text(a, "WhatsApp is on this phone? Get a code instead: your number, with its country code.", 13, Ui.G700), Ui.margins(Ui.fill(), 18, 8, 18, 6));
            EditText num = Ui.input(a, "+1 555 123 4567", false);
            num.setInputType(InputType.TYPE_CLASS_PHONE);
            num.setText(typed);
            num.addTextChangedListener(new android.text.TextWatcher() {
                @Override public void beforeTextChanged(CharSequence x, int b, int c2, int d) { }
                @Override public void onTextChanged(CharSequence x, int b, int c2, int d) { typed = x.toString(); }
                @Override public void afterTextChanged(android.text.Editable e) { }
            });
            sc.addView(num, Ui.margins(Ui.fill(), 16, 0, 16, 6));
            sc.addView(Ui.button(a, "Get a code", false, v -> {
                String p = num.getText().toString().trim();
                if (p.replaceAll("\\D", "").length() < 8) { Ui.toast(a, "Type the number with its country code"); return; }
                num.clearFocus();
                post(a, hub, pc, s, "code", p);
            }), Ui.margins(Ui.fill(), 16, 0, 16, 4));
        }
        sc.addView(Ui.button(a, "Cancel", false, v -> post(a, hub, pc, s, "cancel", null)), Ui.margins(Ui.fill(), 16, 4, 16, 14));
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

    private static void confirmLink(Activity a, Hub hub, String pc, Sheet s) {
        Ui.dialog(a).setTitle("Link WhatsApp on " + hub.labelOn(pc) + "?")
                .setMessage(WARNING)
                .setPositiveButton("I understand, link", (d, w) -> post(a, hub, pc, s, "link", null))
                .setNegativeButton("Cancel", null).show();
    }

    private static void confirmOut(Activity a, Hub hub, String pc, Sheet s) {
        Ui.dialog(a).setTitle("Unlink WhatsApp on " + hub.labelOn(pc) + "?")
                .setMessage("WhatsApp drops that device, and the chats Harbor stored there are deleted. Agents there can't use WhatsApp until you link it again.")
                .setPositiveButton("Unlink", (d, w) -> post(a, hub, pc, s, "signout", null))
                .setNegativeButton("Cancel", null).show();
    }

    private static void post(Activity a, Hub hub, String pc, Sheet s, String action, String phone) {
        Ui.bg(a, () -> {
            JSONObject b = new JSONObject();
            if ("link".equals(action)) b.put("accept", true);
            if (phone != null) b.put("phone", phone);
            return hub.callOn(pc, "POST", "/v1/apps/whatsapp/" + action, b);
        }, r -> {
            if (sheet == s) render(a, hub, pc, s, r);
        });
    }
}
