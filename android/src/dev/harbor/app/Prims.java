package dev.harbor.app;

import android.content.Context;
import android.content.Intent;
import android.graphics.Paint;
import android.net.Uri;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/** Screens from the PC (PROTOCOL.md "Screens from the PC", ts logic/phoneui.ts): sections of card
 *  rows whose words, glyphs, order and taps the PC decides, drawn with the app's own cards so
 *  they look like the rest of it. A tap opens a checklist, a pick list, runs an act on the PC
 *  (after a confirmation when it asks for one), opens an address, or one of the app's own
 *  screens; the PC's answer is the screen again. A new or reworded setting is then a PC
 *  release, not a new APK. The app says what it can draw (`prims`); the PC leaves the rest out. */
final class Prims {
    private Prims() {}

    /** What this app draws, sent as `prims` (phoneui.ts PRIMS_V1: a test keeps them equal). Its
     *  own screens go with them as "native:<name>". */
    static final String[] KNOWN = { "section", "row", "multi", "pick", "do", "url", "native" };

    /** The app's own screens a row may open (`native`); `done` asks the PC for the screen again. */
    interface Native { void open(String screen, Runnable done); }

    static JSONArray prims(String[] natives) {
        JSONArray a = new JSONArray();
        for (String k : KNOWN) a.put(k);
        for (String n : natives) a.put("native:" + n);
        return a;
    }

    /** A section's title over its card (Settings' look). */
    static TextView section(Context c, LinearLayout col, String title) {
        TextView t = Ui.bold(c, title, 14, Ui.G700);
        t.setPadding(Ui.dp(18), Ui.dp(10), Ui.dp(18), Ui.dp(8));
        col.addView(t, Ui.fill());
        return t;
    }

    /** A card of rows under it, with the gap before the next section. */
    static LinearLayout card(Context c, LinearLayout col) {
        LinearLayout k = Ui.card(c);
        col.addView(k, Ui.margins(Ui.fill(), 0, 0, 0, 14));
        return k;
    }

    /** A trailing tag on a row ("Owner"). */
    static TextView tag(Context c, String s) {
        TextView t = Ui.text(c, s, 13, Ui.G700);
        t.setPadding(Ui.dp(10), Ui.dp(3), Ui.dp(10), Ui.dp(3));
        t.setBackground(Ui.round(Ui.G100, 0, 12));
        t.setLayoutParams(Ui.margins(Ui.wrap(), 8, 0, 0, 0));
        return t;
    }

    static int tone(String t) {
        switch (t == null ? "" : t) {
            case "muted": return Ui.G700;
            case "red": return Ui.RED;
            case "amber": return Ui.AMBER;
            case "blue": return Ui.BLUE;
            default: return Ui.FG;
        }
    }

    /** The PC's glyph, when this app's copy of the icon font has it (a newer PC may use a newer one). */
    static String glyph(String g) {
        if (g == null || g.isEmpty() || Ui.icons == null) return null;
        Paint p = new Paint();
        p.setTypeface(Ui.icons);
        return p.hasGlyph(g) ? g : null;
    }

    /** One screen (`name`, "settings"), drawn into `box`. */
    static final class Screen {
        private final Base a;
        private final Hub hub;
        private final String name;
        private final LinearLayout box;
        private final String[] natives;
        private final Native nat;

        Screen(Base a, Hub hub, String name, LinearLayout box, String[] natives, Native nat) {
            this.a = a; this.hub = hub; this.name = name; this.box = box; this.natives = natives; this.nat = nat;
        }

        /** Asks the PC; `older` runs instead when the PC has no screens (or doesn't answer). */
        void load(Runnable older) {
            Ui.pool.execute(() -> {
                try {
                    JSONObject s = hub.call("POST", "/v1/ui/" + name, new JSONObject().put("prims", prims(natives)), 8000);
                    Ui.main.post(() -> { if (!a.isFinishing()) draw(s); });
                } catch (Exception e) {
                    Ui.main.post(() -> { if (!a.isFinishing() && older != null) older.run(); });
                }
            });
        }

        void reload() { load(null); }

        void draw(JSONObject s) {
            box.removeAllViews();
            JSONArray secs = s.optJSONArray("sections");
            for (int i = 0; secs != null && i < secs.length(); i++) {
                JSONObject sec = secs.optJSONObject(i);
                JSONArray rows = sec == null ? null : sec.optJSONArray("rows");
                if (rows == null || rows.length() == 0) continue;
                section(a, box, sec.optString("title"));
                LinearLayout card = card(a, box);
                for (int j = 0; j < rows.length(); j++) {
                    JSONObject r = rows.optJSONObject(j);
                    if (r == null) continue;
                    if (card.getChildCount() > 0) card.addView(Ui.gap(a));
                    card.addView(row(r), Ui.fill());
                }
            }
            String say = s.optString("say");
            if (!say.isEmpty()) Ui.toast(a, say);
        }

        private LinearLayout row(JSONObject r) {
            JSONObject tap = r.optJSONObject("tap");
            LinearLayout v = Ui.cardRow(a, glyph(r.optString("glyph")), r.optString("title"), r.optString("sub"), tone(r.optString("tone")),
                    tap == null ? null : x -> tap(tap));
            int lines = r.optInt("lines", 1);
            if (lines > 1) Ui.wrapSub(v, lines);
            if (!r.optString("tag").isEmpty()) v.addView(tag(a, r.optString("tag")));
            if (r.optBoolean("chevron")) v.addView(Ui.chevron(a));
            return v;
        }

        private void tap(JSONObject t) {
            String act = t.optString("act");
            switch (t.optString("kind")) {
                case "multi": {
                    JSONArray items = t.optJSONArray("items");
                    int n = items == null ? 0 : items.length();
                    String[] keys = new String[n], labels = new String[n];
                    boolean[] on = new boolean[n];
                    for (int i = 0; i < n; i++) {
                        JSONObject it = items.optJSONObject(i);
                        keys[i] = it == null ? "" : it.optString("key");
                        labels[i] = it == null ? "" : it.optString("label");
                        on[i] = it != null && it.optBoolean("on");
                    }
                    Ui.dialog(a).setTitle(t.optString("title"))
                            .setMultiChoiceItems(labels, on, (d, i, x) -> on[i] = x)
                            .setNegativeButton("Cancel", null)
                            .setPositiveButton("OK", (d, w) -> {
                                JSONObject vals = new JSONObject();
                                try { for (int i = 0; i < n; i++) vals.put(keys[i], on[i]); } catch (Exception ignored) { }
                                post(act, "values", vals);
                            }).show();
                    break;
                }
                case "pick": {
                    JSONArray os = t.optJSONArray("options");
                    List<Sheet.Option> o = new ArrayList<>();
                    for (int i = 0; os != null && i < os.length(); i++) {
                        JSONObject it = os.optJSONObject(i);
                        if (it != null) o.add(new Sheet.Option(it.optString("id"), it.optString("label"), it.optString("sub"), it.optBoolean("enabled", true)));
                    }
                    Sheet.pick(a, t.optString("title"), t.optString("note"), o, t.optString("selected"), id -> post(act, "value", id));
                    break;
                }
                case "do": {
                    JSONObject c = t.optJSONObject("confirm");
                    Object value = t.opt("value");
                    if (c == null) { post(act, "value", value); break; }
                    Ui.dialog(a).setTitle(c.optString("title")).setMessage(c.optString("text"))
                            .setNegativeButton("Cancel", null)
                            .setPositiveButton(c.optString("ok", "OK"), (d, w) -> post(act, "value", value)).show();
                    break;
                }
                case "url": {
                    String url = t.optString("url");
                    try { a.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); } catch (Exception e) { Ui.copy(a, url); }
                    break;
                }
                case "native":
                    if (nat != null) nat.open(t.optString("screen"), this::reload);
                    break;
                default:
                    break;
            }
        }

        /** Runs `act` on the PC; its answer is the screen again (a toast with its `say`). */
        private void post(String act, String key, Object value) {
            Ui.pool.execute(() -> {
                try {
                    JSONObject b = new JSONObject().put("prims", prims(natives)).put("act", act);
                    if (value != null) b.put(key, value);
                    JSONObject s = hub.call("POST", "/v1/ui/" + name + "/do", b);
                    Ui.main.post(() -> { if (!a.isFinishing()) draw(s); });
                } catch (Exception e) {
                    Ui.main.post(() -> { if (!a.isFinishing()) Ui.toast(a, Hub.why(e)); });
                }
            });
        }
    }
}
