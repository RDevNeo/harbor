package dev.harbor.app;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.speech.RecognizerIntent;
import android.text.Editable;
import android.text.TextWatcher;
import android.util.TypedValue;
import android.view.ActionMode;
import android.view.ContentInfo;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import android.view.inputmethod.InputConnectionWrapper;
import android.view.inputmethod.InputContentInfo;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.List;

/** The rounded composer card: attachments, the text, and a row with +, the model pill, the
 *  mic (speech to text) and the round send button, which turns into Stop while a turn runs and
 *  nothing is typed. An image pasted into the text is attached (Edit). */
final class Composer {
    static final int SPEAK = 43;

    final LinearLayout view;
    final Edit edit;
    final TextView pill;
    private final FrameLayout send;
    private final TextView sendGlyph;
    private final Activity a;
    private boolean running;
    /** The usual placeholder; the hub's suggested next message and its Use chip (Recap.java). */
    final String hint;
    String ghost;
    TextView use;

    Runnable onSend, onStop, onPlus, onPill, onType;

    Composer(Activity a, Attach attach, String hint) {
        this.a = a;
        this.hint = hint;
        view = Ui.col(a);
        view.setBackground(Ui.round(Ui.CARD, Ui.LINE, 28));
        view.setElevation(Ui.dp(Ui.dark ? 0 : 1));
        view.setPadding(Ui.dp(6), Ui.dp(6), Ui.dp(10), Ui.dp(10));
        if (attach != null) view.addView(attach.view, Ui.fill());

        edit = new Edit(a, attach);
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
        // Large font sizes must not push the send button out of the card: the pill ellipsizes
        // (screen - composer margins and padding - three 44 dp buttons and their gaps).
        pill.setMaxWidth(a.getResources().getDisplayMetrics().widthPixels - Ui.dp(24 + 16 + 4 + 3 * 44 + 3 * 8 + 4));
        LinearLayout.LayoutParams pp = new LinearLayout.LayoutParams(-2, Ui.dp(44));
        pp.leftMargin = Ui.dp(8);
        row.addView(pill, pp);
        row.addView(new View(a), new LinearLayout.LayoutParams(0, 1, 1));
        use = Recap.useChip(a, this);
        row.addView(use, Ui.margins(new LinearLayout.LayoutParams(-2, Ui.dp(32)), 8, 0, 0, 0));
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
        Recap.refresh(this);
    }

    // ---- pasting images ----

    static final String[] IMAGES = {"image/*", "image/png", "image/jpeg", "image/gif", "image/webp"};

    /** The text box. An image pasted (long press › Paste, the keyboard's clipboard or its image
     *  and GIF insertion) is attached instead of pasted as its address; text pastes as ever.
     *  Android 12+ hands all of these to one OnReceiveContentListener; before, paste and the
     *  keyboard's commitContent come apart. */
    static final class Edit extends EditText {
        private final Attach attach;
        private ActionMode menu; // the floating Paste toolbar while it shows
        /** The cursor moved (the slash menu follows the word under it). */
        Runnable onSelection;
        /** While it says true, Back goes to onBack before the keyboard sees it (the slash menu
         *  closes and the keyboard stays). */
        java.util.function.BooleanSupplier backOpen;
        Runnable onBack;

        @Override protected void onSelectionChanged(int start, int end) {
            super.onSelectionChanged(start, end);
            if (onSelection != null) onSelection.run();
        }

        @Override public boolean onKeyPreIme(int code, KeyEvent e) {
            if (code == KeyEvent.KEYCODE_BACK && backOpen != null && backOpen.getAsBoolean()) {
                if (e.getAction() == KeyEvent.ACTION_UP && !e.isCanceled()) onBack.run();
                return true;
            }
            return super.onKeyPreIme(code, e);
        }

        Edit(Context c, Attach attach) {
            super(c);
            this.attach = attach;
            if (attach == null) return;
            if (Build.VERSION.SDK_INT >= 31) Receive.on(this, attach);
            // An image paste changes no text, so the toolbar would stay up: attached() closes it.
            ActionMode.Callback keep = new ActionMode.Callback() {
                @Override public boolean onCreateActionMode(ActionMode m, Menu x) { menu = m; return true; }
                @Override public boolean onPrepareActionMode(ActionMode m, Menu x) { return false; }
                @Override public boolean onActionItemClicked(ActionMode m, MenuItem i) { return false; }
                @Override public void onDestroyActionMode(ActionMode m) { if (menu == m) menu = null; }
            };
            setCustomInsertionActionModeCallback(keep);
            setCustomSelectionActionModeCallback(keep);
        }

        /** Images went to the attachments: the Paste toolbar has done its job. */
        void attached() {
            post(() -> { if (menu != null) menu.finish(); });
        }

        @Override public InputConnection onCreateInputConnection(EditorInfo out) {
            InputConnection ic = super.onCreateInputConnection(out);
            if (attach == null || Build.VERSION.SDK_INT >= 31 || ic == null) return ic;
            out.contentMimeTypes = IMAGES;
            return new InputConnectionWrapper(ic, false) {
                @Override public boolean commitContent(InputContentInfo info, int flags, Bundle opts) {
                    if ((flags & InputConnection.INPUT_CONTENT_GRANT_READ_URI_PERMISSION) != 0) {
                        try { info.requestPermission(); } catch (Exception e) { return false; }
                    }
                    attach.paste(info.getContentUri(), info::releasePermission);
                    return true;
                }
            };
        }

        @Override public boolean onTextContextMenuItem(int id) {
            if (attach != null && Build.VERSION.SDK_INT < 31 && (id == android.R.id.paste || id == android.R.id.pasteAsPlainText) && pasteImages()) return true;
            return super.onTextContextMenuItem(id);
        }

        /** Attaches the clipboard's images and types its text; false when it holds no image. */
        private boolean pasteImages() {
            ClipboardManager cm = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
            ClipData clip = cm == null ? null : cm.getPrimaryClip();
            if (clip == null) return false;
            List<Uri> images = new ArrayList<>();
            StringBuilder text = new StringBuilder();
            for (int i = 0; i < clip.getItemCount(); i++) {
                ClipData.Item it = clip.getItemAt(i);
                if (it.getUri() != null && Attach.image(getContext(), it.getUri(), clip.getDescription())) images.add(it.getUri());
                else if (it.getText() != null) text.append(it.getText());
            }
            if (images.isEmpty()) return false;
            for (Uri u : images) attach.paste(u, null);
            attached();
            if (text.length() > 0) {
                int a = Math.max(0, getSelectionStart()), b = Math.max(0, getSelectionEnd());
                getText().replace(Math.min(a, b), Math.max(a, b), text);
            }
            return true;
        }
    }

    /** Android 12+: paste, drag and drop and the keyboard all arrive here; what isn't an image
     *  goes on to the text box as usual. */
    private static final class Receive {
        static void on(Edit e, Attach attach) {
            e.setOnReceiveContentListener(IMAGES, (v, payload) -> {
                ClipData all = payload.getClip();
                ClipData rest = null;
                for (int i = 0; i < all.getItemCount(); i++) {
                    ClipData.Item it = all.getItemAt(i);
                    if (it.getUri() != null && Attach.image(v.getContext(), it.getUri(), all.getDescription())) attach.paste(it.getUri(), null);
                    else if (rest == null) rest = new ClipData(all.getDescription(), it);
                    else rest.addItem(it);
                }
                if (rest == null || rest.getItemCount() < all.getItemCount()) e.attached();
                return rest == null ? null : new ContentInfo.Builder(payload).setClip(rest).build();
            });
        }
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
