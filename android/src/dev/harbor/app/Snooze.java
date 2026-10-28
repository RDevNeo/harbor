package dev.harbor.app;

import android.net.Uri;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.TimeZone;

/** The desktop sidebar's snooze menu as a sheet: its presets, a field for a time of your own
 *  ("5h", "1h30m", "2d", "18:00") with the line under it saying when that ends, and Unsnooze for
 *  a snoozed chat. The hub reads the text and names the times (`GET /v1/snooze`, in this phone's
 *  zone); the snooze is the hub's sidebar's, so its desktop hides the chat too. */
final class Snooze {
    private Snooze() {}

    /** This phone's zone, seconds east of UTC (the hub's `off`). */
    static int off() { return TimeZone.getDefault().getOffset(System.currentTimeMillis()) / 1000; }

    static void sheet(Base a, Hub hub, JSONObject c, Runnable after) {
        String id = c.optString("id");
        Ui.bg(a, () -> hub.call("GET", "/v1/snooze?off=" + off() + "&chat=" + Uri.encode(id), null), r -> show(a, hub, id, r, after));
    }

    private static void show(Base a, Hub hub, String id, JSONObject r, Runnable after) {
        Sheet s = new Sheet(a, "Snooze until");
        String now = r.isNull("snoozed") ? "" : r.optString("snoozed");
        TextView note = Ui.text(a, now.isEmpty()
                ? "It leaves the list here and on the PC until then, and comes back unread."
                : "Snoozed " + now + ". Pick another time, or wake it now.", 14, Ui.G700);
        note.setPadding(Ui.dp(6), 0, Ui.dp(6), Ui.dp(10));
        s.body.addView(note);

        LinearLayout presets = s.card();
        JSONArray ps = r.optJSONArray("presets");
        for (int i = 0; ps != null && i < ps.length(); i++) {
            JSONObject p = ps.optJSONObject(i);
            if (p == null) continue;
            if (presets.getChildCount() > 0) presets.addView(Ui.gap(a));
            long until = p.optLong("until_ms");
            presets.addView(Ui.cardRow(a, Ui.I_CLOCK, p.optString("label"), null, Ui.FG,
                    v -> apply(a, hub, s, id, put("until_ms", until), after)), Ui.fill());
        }

        // A time of your own, as the desktop menu's field: Enter or Snooze applies it.
        LinearLayout custom = s.card();
        custom.setPadding(Ui.dp(14), Ui.dp(14), Ui.dp(14), Ui.dp(12));
        LinearLayout row = Ui.row(a);
        EditText e = Ui.input(a, "Custom: 5h, 2d, 18:00", false);
        e.setImeOptions(EditorInfo.IME_ACTION_DONE);
        row.addView(e, new LinearLayout.LayoutParams(0, -2, 1));
        Runnable go = () -> {
            String t = e.getText().toString().trim();
            if (!t.isEmpty()) apply(a, hub, s, id, put("text", t, "off", off()), after);
        };
        TextView btn = Ui.button(a, "Snooze", true, v -> go.run());
        row.addView(btn, Ui.margins(Ui.wrap(), 10, 0, 0, 0));
        custom.addView(row, Ui.fill());
        TextView preview = Ui.text(a, "", 13, Ui.G700);
        preview.setPadding(Ui.dp(4), Ui.dp(8), Ui.dp(4), 0);
        preview.setVisibility(android.view.View.GONE);
        custom.addView(preview, Ui.fill());
        e.setOnEditorActionListener((v, act, ev) -> { go.run(); return true; });
        // The line under the field, from the hub, a moment after typing stops.
        Runnable ask = () -> {
            String t = e.getText().toString();
            Ui.bg(a, () -> {
                try {
                    return hub.call("GET", "/v1/snooze?off=" + off() + "&text=" + Uri.encode(t), null);
                } catch (Exception ex) {
                    return null; // the next keystroke asks again
                }
            }, p -> {
                if (p == null || !t.equals(e.getText().toString())) return;
                String line = p.optString("preview", "");
                preview.setText(line);
                preview.setVisibility(line.isEmpty() ? android.view.View.GONE : android.view.View.VISIBLE);
            });
        };
        e.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence x, int st, int n, int m) {}
            @Override public void onTextChanged(CharSequence x, int st, int b, int n) {}
            @Override public void afterTextChanged(Editable x) {
                Ui.main.removeCallbacks(ask);
                if (x.toString().trim().isEmpty()) preview.setVisibility(android.view.View.GONE);
                else Ui.main.postDelayed(ask, 250);
            }
        });
        s.dialog.setOnDismissListener(d -> Ui.main.removeCallbacks(ask));

        if (!now.isEmpty()) {
            LinearLayout wake = s.card();
            wake.addView(Ui.cardRow(a, Ui.I_X, "Unsnooze", null, Ui.FG, v -> Ui.bg(a,
                    () -> hub.call("DELETE", "/v1/chats/" + Uri.encode(id) + "/snooze", null),
                    x -> { s.dismiss(); after.run(); })), Ui.fill());
        }
        if (s.dialog.getWindow() != null) s.dialog.getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        s.show();
    }

    private static void apply(Base a, Hub hub, Sheet s, String id, JSONObject body, Runnable after) {
        Ui.bg(a, () -> hub.call("POST", "/v1/chats/" + Uri.encode(id) + "/snooze", body), r -> {
            s.dismiss();
            Ui.toast(a, "Snoozed until " + r.optString("snoozed_label"));
            after.run();
        });
    }

    /** A body of key, value pairs. */
    private static JSONObject put(Object... kv) {
        JSONObject o = new JSONObject();
        try {
            for (int i = 0; i + 1 < kv.length; i += 2) o.put((String) kv[i], kv[i + 1]);
        } catch (Exception e) {
            // (only for a NaN or a null key)
        }
        return o;
    }
}
