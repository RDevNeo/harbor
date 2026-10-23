package dev.harbor.app;

import android.app.Activity;
import android.content.Intent;
import android.speech.RecognizerIntent;
import android.text.Editable;
import android.text.TextWatcher;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.ArrayList;

/** The rounded composer card: attachments, the text, and a row with +, the model pill, the
 *  mic (speech to text) and the round send button, which turns into Stop while a turn runs and
 *  nothing is typed. */
final class Composer {
    static final int SPEAK = 43;

    final LinearLayout view;
    final EditText edit;
    final TextView pill;
    private final FrameLayout send;
    private final TextView sendGlyph;
    private final Activity a;
    private boolean running;

    Runnable onSend, onStop, onPlus, onPill, onType;

    Composer(Activity a, Attach attach, String hint) {
        this.a = a;
        view = Ui.col(a);
        view.setBackground(Ui.round(Ui.CARD, Ui.LINE, 28));
        view.setElevation(Ui.dp(Ui.dark ? 0 : 1));
        view.setPadding(Ui.dp(6), Ui.dp(6), Ui.dp(10), Ui.dp(10));
        if (attach != null) view.addView(attach.view, Ui.fill());

        edit = new EditText(a);
        edit.setHint(hint);
        edit.setHintTextColor(Ui.G600);
        edit.setTextColor(Ui.FG);
        edit.setTypeface(Ui.sans);
        edit.setTextSize(TypedValue.COMPLEX_UNIT_SP, 17);
        edit.setBackground(null);
        edit.setPadding(Ui.dp(14), Ui.dp(10), Ui.dp(10), Ui.dp(6));
        edit.setMinHeight(Ui.dp(48));
        edit.setMaxLines(7);
        edit.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE
                | android.text.InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
        view.addView(edit, Ui.fill());

        LinearLayout row = Ui.row(a);
        row.setPadding(Ui.dp(4), Ui.dp(4), 0, 0);
        row.addView(Ui.roundButton(a, Ui.I_PLUS, Ui.G100, Ui.FG, 44, v -> { if (onPlus != null) onPlus.run(); }));
        pill = Ui.pill(a, "", v -> { if (onPill != null) onPill.run(); });
        LinearLayout.LayoutParams pp = new LinearLayout.LayoutParams(-2, Ui.dp(44));
        pp.leftMargin = Ui.dp(8);
        row.addView(pill, pp);
        row.addView(new View(a), new LinearLayout.LayoutParams(0, 1, 1));
        FrameLayout mic = Ui.roundButton(a, new Ui.Draw(Ui.Draw.MIC, Ui.FG), Ui.G100, Ui.FG, 44, v -> speak());
        mic.setContentDescription("Speak");
        row.addView(mic, Ui.margins(new LinearLayout.LayoutParams(Ui.dp(44), Ui.dp(44)), 8, 0, 0, 0));
        send = Ui.roundButton(a, Ui.I_UP, Ui.INK, Ui.ON_INK, 44, v -> {
            if (running && empty()) { if (onStop != null) onStop.run(); }
            else if (onSend != null) onSend.run();
        });
        sendGlyph = (TextView) send.getChildAt(0);
        row.addView(send, Ui.margins(new LinearLayout.LayoutParams(Ui.dp(44), Ui.dp(44)), 8, 0, 0, 0));
        view.addView(row, Ui.fill());

        edit.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int st, int c, int af) { }
            @Override public void onTextChanged(CharSequence s, int st, int b, int c) { }
            @Override public void afterTextChanged(Editable e) {
                refresh();
                if (e.length() > 0 && onType != null) onType.run();
            }
        });
        refresh();
    }

    boolean empty() { return edit.getText().toString().trim().isEmpty(); }

    void running(boolean r) {
        running = r;
        refresh();
    }

    void busy(boolean b) { send.setAlpha(b ? 0.4f : 1f); }

    private void refresh() {
        boolean stop = running && empty();
        sendGlyph.setText(stop ? Ui.I_STOP : Ui.I_UP);
        send.setContentDescription(stop ? "Stop" : "Send");
    }

    // ---- speech to text (the phone's own recogniser) ----

    private void speak() {
        try {
            a.startActivityForResult(new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                    .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM), SPEAK);
        } catch (Exception e) {
            Ui.toast(a, "No speech recogniser on this phone");
        }
    }

    /** Call from onActivityResult; true when it was ours. */
    boolean result(int req, int res, Intent data) {
        if (req != SPEAK) return false;
        if (res != Activity.RESULT_OK || data == null) return true;
        ArrayList<String> said = data.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS);
        if (said == null || said.isEmpty()) return true;
        String now = edit.getText().toString();
        String add = said.get(0);
        edit.setText(now.isEmpty() || now.endsWith(" ") || now.endsWith("\n") ? now + add : now + " " + add);
        edit.setSelection(edit.length());
        return true;
    }

    /** The "Add to session" sheet: Camera / Photos / Files tiles, then the run settings. */
    static Sheet addSheet(Activity a, Attach attach, Run run, Run.Changed ch) {
        Sheet s = new Sheet(a, "Add to session");
        LinearLayout tiles = Ui.row(a);
        tiles.addView(tile(a, s, new Ui.Draw(Ui.Draw.CAMERA, Ui.FG), "Camera", attach::camera), tileParams(0));
        tiles.addView(tile(a, s, Ui.I_IMAGE, "Photos", attach::photos), tileParams(10));
        tiles.addView(tile(a, s, Ui.I_UPLOAD, "Files", attach::files), tileParams(10));
        s.body.addView(tiles, Ui.margins(Ui.fill(), 0, 0, 0, 12));
        if (run != null) run.rows(a, s, (f, v) -> { s.dismiss(); ch.apply(f, v); });
        return s.show();
    }

    private static LinearLayout.LayoutParams tileParams(float left) {
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(0, -2, 1);
        p.leftMargin = Ui.dp(left);
        return p;
    }

    private static View tile(Activity a, Sheet s, Object glyph, String label, Runnable on) {
        LinearLayout t = Ui.col(a);
        t.setGravity(Gravity.CENTER_HORIZONTAL);
        t.setPadding(0, Ui.dp(18), 0, Ui.dp(16));
        t.setBackground(Ui.press(Ui.CARD, Ui.dark ? 0 : Ui.LINE, 20));
        t.addView(Ui.disc(a, glyph, 52));
        TextView l = Ui.text(a, label, 16, Ui.FG);
        l.setGravity(Gravity.CENTER);
        t.addView(l, Ui.margins(Ui.fill(), 0, 10, 0, 0));
        t.setOnClickListener(v -> { s.dismiss(); on.run(); });
        return t;
    }
}
