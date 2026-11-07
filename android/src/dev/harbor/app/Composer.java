package dev.harbor.app;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
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

/** The rounded composer card: attachments, the text, and a row with +, the mic (speech to text)
 *  and the round send button, which turns into Stop while a turn runs and nothing is typed. An
 *  image pasted into the text is attached (Edit). Its screen puts `badges`, the model and the
 *  effort, right over the card. */
final class Composer {
    final LinearLayout view;
    final Edit edit;
    final LinearLayout badges;
    private final LinearLayout modelBadge;
    private final TextView modelText, effortBadge;
    private String modelLogo;
    private final FrameLayout send;
    private final TextView sendGlyph;
    private final Activity a;
    private final Attach attach;
    /** The image numbers in the text, as of its last change. */
    private List<Integer> images = new ArrayList<>();
    /** The last change to the text: where, and how much came in. */
    private int changedAt, changedLen;
    private boolean running, canSteer, held, editing, history;
    /** The draft mentions messages (Chat.mentions): it isn't empty then, as with files. */
    java.util.function.BooleanSupplier hasMentions;
    /** What the send button does while the agent works: "steer" or "queue" (Chat.FOLLOW_UP). */
    private String mode = "queue";
    /** The usual placeholder; the hub's suggested next message and its Use chip (Suggest.java). */
    final String hint;
    String ghost;
    TextView use;

    Runnable onSend, onStop, onPlus, onModel, onEffort, onType, onResume, onSendMenu;
    /** The draft's mentioned messages (Chat.drawMentions), over the files. */
    final LinearLayout mentions;
    private LinearLayout whoRow;
    private TextView whoText;

    /** "✎ Desk" in the text's corner while another device writes here; null hides it. */
    void who(String names) {
        whoText.setText(names == null ? "" : names);
        whoRow.setVisibility(names == null ? View.GONE : View.VISIBLE);
    }
    /** Dictation (Voice), once `voice(hub)` set it up; its strip goes over the buttons. */
    Voice voice;
    private FrameLayout mic;
    private LinearLayout row;

    void voice(Hub hub) {
        voice = new Voice(a, hub, edit);
        view.addView(voice.strip, view.indexOfChild(row), Ui.fill());
        // "…press enter" / "enviar" at the end of a dictation: as if send was tapped.
        voice.onSend = () -> { if (!empty()) send.performClick(); };
        voice.onState = () -> {
            boolean on = voice.active();
            mic.setBackground(Ui.press(on ? Ui.RED : Ui.G100, 0, 22));
            ((android.widget.ImageView) mic.getChildAt(0)).setImageDrawable(new Ui.Draw(Ui.Draw.MIC, on ? 0xffffffff : Ui.FG));
            mic.setContentDescription(on ? "Stop dictation" : "Dictate");
        };
    }

    Composer(Activity a, Attach attach, String hint) {
        this.a = a;
        this.attach = attach;
        this.hint = hint;
        view = Ui.col(a);
        view.setBackground(Ui.round(Ui.CARD, Ui.LINE, 28));
        view.setElevation(Ui.dp(Ui.dark ? 0 : 1));
        view.setPadding(Ui.dp(6), Ui.dp(6), Ui.dp(10), Ui.dp(10));
        mentions = Ui.col(a);
        mentions.setVisibility(View.GONE);
        view.addView(mentions, Ui.fill());
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
        // The text, with the suggestion's Use chip in its top-right corner (the desktop's "⇥ Tab"
        // tag): never in the button row, where it pushed the send button out of the card.
        FrameLayout box = new FrameLayout(a);
        box.addView(edit, new FrameLayout.LayoutParams(-1, -2));
        use = Suggest.useChip(a, this);
        box.addView(use, Ui.margins(new FrameLayout.LayoutParams(-2, Ui.dp(28), Gravity.TOP | Gravity.END), 0, 8, 6, 0));
        // Who else writes in this chat (the draft here is theirs then), as the desktop's corner.
        whoRow = Ui.row(a);
        whoRow.setGravity(Gravity.CENTER_VERTICAL);
        whoRow.addView(Ui.icon(a, Ui.I_PEN, 12, Ui.G600));
        whoText = Ui.text(a, "", 12, Ui.G600);
        whoText.setSingleLine(true);
        whoText.setEllipsize(android.text.TextUtils.TruncateAt.END);
        whoRow.addView(whoText, Ui.margins(Ui.wrap(), 4, 0, 0, 0));
        whoRow.setVisibility(View.GONE);
        LinearLayout.LayoutParams wp = Ui.margins(Ui.wrap(), 14, 2, 10, 0);
        wp.gravity = Gravity.END;
        view.addView(whoRow, wp);
        view.addView(box, Ui.fill());

        LinearLayout row = Ui.row(a);
        row.setPadding(Ui.dp(4), Ui.dp(4), 0, 0);
        row.addView(Ui.roundButton(a, Ui.I_PLUS, Ui.G100, Ui.FG, 44, v -> { if (onPlus != null) onPlus.run(); }));
        row.addView(new View(a), new LinearLayout.LayoutParams(0, Ui.dp(44), 1));
        mic = Ui.roundButton(a, new Ui.Draw(Ui.Draw.MIC, Ui.FG), Ui.G100, Ui.FG, 44, v -> { if (voice != null) voice.toggle(); });
        mic.setContentDescription("Dictate");
        row.addView(mic, Ui.margins(new LinearLayout.LayoutParams(Ui.dp(44), Ui.dp(44)), 8, 0, 0, 0));
        send = Ui.roundButton(a, Ui.I_UP, Ui.INK, Ui.ON_INK, 44, v -> {
            if (editing) { if (onSend != null) onSend.run(); }
            else if (running && empty()) { if (onStop != null) onStop.run(); }
            else if (resumable()) { if (onResume != null) onResume.run(); }
            else if (onSend != null) onSend.run();
        });
        // Long-press while the agent works: "Choose how to send this message" (Steer or Queue).
        send.setOnLongClickListener(v -> {
            if (editing || !running || empty() || !canSteer || onSendMenu == null) return false;
            onSendMenu.run();
            return true;
        });
        sendGlyph = (TextView) send.getChildAt(0);
        row.addView(send, Ui.margins(new LinearLayout.LayoutParams(Ui.dp(44), Ui.dp(44)), 8, 0, 0, 0));
        view.addView(row, Ui.fill());
        this.row = row;

        // A wrap-content row shrinks its weighted child only when it overflows, so a long model name
        // ellipsizes instead of pushing the effort badge out.
        badges = Ui.row(a);
        badges.setBaselineAligned(false);
        modelBadge = Ui.row(a);
        // Background first: its InsetDrawable brings padding of its own, which would replace ours.
        modelBadge.setBackground(badgeBackground());
        modelBadge.setPadding(Ui.dp(10), 0, Ui.dp(12), 0);
        modelBadge.setOnClickListener(v -> { if (onModel != null) onModel.run(); });
        modelText = Ui.subtitle(Ui.text(a, "", 13, Ui.FG));
        modelBadge.addView(modelText, Ui.margins(new LinearLayout.LayoutParams(-2, -2, 1), 6, 0, 0, 0));
        badges.addView(modelBadge, new LinearLayout.LayoutParams(-2, Ui.dp(44), 1));
        effortBadge = Ui.subtitle(Ui.text(a, "", 13, Ui.FG));
        effortBadge.setGravity(Gravity.CENTER);
        effortBadge.setBackground(badgeBackground());
        effortBadge.setPadding(Ui.dp(12), 0, Ui.dp(12), 0);
        effortBadge.setOnClickListener(v -> { if (onEffort != null) onEffort.run(); });
        badges.addView(effortBadge, Ui.margins(new LinearLayout.LayoutParams(-2, Ui.dp(44)), 6, 0, 0, 0));
        // Landscape with the keyboard up leaves no room for them; on a phone upright they stay.
        edit.getViewTreeObserver().addOnGlobalLayoutListener(this::fitBadges);

        edit.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int st, int c, int af) { }
            @Override public void onTextChanged(CharSequence s, int st, int b, int c) {
                changedAt = st;
                changedLen = c;
            }
            @Override public void afterTextChanged(Editable e) {
                imagesFollow(e);
                refresh();
                if (onType != null) onType.run();
            }
        });
        // Enter in an empty composer (the keyboard's or a hardware one) is Resume, as on the desktop
        // (ts resume.ts): no blank line goes in. Typed text keeps Enter for new lines.
        android.text.InputFilter[] fs = edit.getFilters();
        android.text.InputFilter[] all = java.util.Arrays.copyOf(fs, fs.length + 1);
        all[fs.length] = (src, start, end, dest, ds, de) -> {
            if (edit.setting || end - start != 1 || src.charAt(start) != '\n' || dest.toString().trim().length() > 0 || !resumable()) return null;
            edit.post(() -> { if (resumable() && onResume != null) onResume.run(); });
            return "";
        };
        edit.setFilters(all);
        if (attach != null) {
            attach.onImage = edit::insertImage;
            attach.onImageGone = n -> {
                edit.forgetImage(n);
                images = TagList.imageNumbers(edit.getText());
            };
        }
        refresh();
    }

    /** The text changed: a token erased in it takes its image along and the later numbers move
     *  down (src/usertext.rs). Text set from outside (a shared draft, a queued message) comes
     *  with its files. Every token goes in one erase. */
    private void imagesFollow(Editable e) {
        if (attach == null || edit.renumbering) return;
        if (!edit.setting) {
            if (!edit.placing && changedLen > 1) arrived(e);
            List<Integer> now = TagList.imageNumbers(e);
            for (int i = images.size() - 1; i >= 0; i--) {
                int n = images.get(i);
                if (now.contains(n)) continue;
                attach.removeImage(n);
                edit.forgetImage(n);
            }
        }
        images = TagList.imageNumbers(e);
        for (int[] t : TagList.images(e)) edit.pick(t[0], t[1]);
    }

    /** Tokens that came in whole, not typed: a paste or an undo. What was copied or cut here
     *  keeps its images and takes the numbers they have now; anything else, whose number means
     *  another moment's or another message's image, stops being a token (src/usertext.rs). */
    private void arrived(Editable e) {
        int from = changedAt, to = changedAt + changedLen; // the replacements below move them
        boolean ours = to <= e.length() && e.subSequence(from, to).toString().equals(edit.clipText);
        List<int[]> all = TagList.images(e);
        edit.renumbering = true;
        try {
            for (int i = all.size() - 1; i >= 0; i--) {
                int[] t = all.get(i);
                if (t[0] < from || t[1] > to) continue;
                Attach.Up u = ours ? edit.clip.get(t[2]) : null;
                e.replace(t[0], t[1], u != null ? TagList.token(attach.back(u)) : TagList.defused(t[2]));
            }
        } finally { edit.renumbering = false; }
    }

    /** Fills the badges: the provider's logo in assets/logos ("": a bot), the model's name, and
     *  the effort ("": the provider has none, no badge). */
    void badges(String logo, String model, String effort) {
        if (!logo.equals(modelLogo)) {
            if (modelLogo != null) modelBadge.removeViewAt(0);
            modelLogo = logo;
            android.graphics.Bitmap b = Ui.logo(a, logo);
            View mark;
            if (b != null) {
                android.widget.ImageView iv = new android.widget.ImageView(a);
                iv.setImageBitmap(b);
                mark = iv;
            } else mark = Ui.icon(a, Ui.I_BOT, 13, Ui.G700);
            modelBadge.addView(mark, 0, new LinearLayout.LayoutParams(Ui.dp(15), Ui.dp(15)));
        }
        modelText.setText(model);
        modelBadge.setContentDescription("Model: " + model);
        effortBadge.setText(effort);
        effortBadge.setContentDescription("Effort: " + effort);
        effortBadge.setVisibility(effort.isEmpty() ? View.GONE : View.VISIBLE);
    }

    private android.graphics.drawable.Drawable badgeBackground() {
        return new android.graphics.drawable.InsetDrawable(Ui.press(Ui.CARD, Ui.LINE, 14), 0, Ui.dp(8), 0, Ui.dp(8));
    }

    /** The badges go with the card (a read-only chat has none) and where height is scarce. The
     *  screen's height doesn't depend on them, so this can't flip back and forth. */
    private void fitBadges() {
        boolean room = view.getVisibility() == View.VISIBLE && a.findViewById(android.R.id.content).getHeight() >= Ui.dp(320);
        int want = room ? View.VISIBLE : View.GONE;
        if (badges.getVisibility() != want) badges.setVisibility(want);
    }

    boolean empty() { return edit.getText().toString().trim().isEmpty(); }

    /** Send (the button or Enter) is Resume now (ts resume.ts `resumeKind`): nothing typed,
     *  attached or mentioned, the agent idle, and a queue a Stop held or a transcript to go on from. */
    boolean resumable() {
        return !editing && !running && empty() && (attach == null || !attach.any()) && (hasMentions == null || !hasMentions.getAsBoolean()) && (held || history);
    }

    /** The chat shows messages: an empty send asks the agent to go on (Resume). */
    void history(boolean h) {
        if (history == h) return;
        history = h;
        refresh();
    }

    /** Files or mentions changed: the button follows. */
    void again() { refresh(); }

    void running(boolean r) {
        running = r;
        refresh();
    }

    /** The hub's follow-up state (PROTOCOL.md status `can_steer`, `held`) and this phone's mode. */
    void follow(boolean canSteer, boolean held, String mode) {
        this.canSteer = canSteer;
        this.held = held;
        this.mode = mode;
        refresh();
    }

    /** A queued message is being edited here: the button saves it (a check). */
    void editing(boolean e) {
        editing = e;
        refresh();
    }

    /** What sending now does: "steer" when the running agent takes it, else "queue". */
    String sendMode() { return running && canSteer && "steer".equals(mode) ? "steer" : "queue"; }

    void busy(boolean b) { send.setAlpha(b ? 0.4f : 1f); }

    private void refresh() {
        boolean empty = empty();
        String g, d;
        if (editing) { g = Ui.I_CHECK; d = "Update queued message"; }
        else if (running && empty) { g = Ui.I_STOP; d = "Stop"; }
        else if (running) {
            boolean steer = "steer".equals(sendMode());
            g = steer ? Ui.I_STEER : Ui.I_LIST_PLUS;
            d = steer ? "Steer message" : "Queue message";
        } else if (resumable()) { g = Ui.I_PLAY; d = held ? "Resume queue" : "Resume"; }
        else { g = Ui.I_UP; d = "Send"; }
        sendGlyph.setText(g);
        boolean stopping = !editing && running && empty;
        send.setBackground(Ui.press(stopping ? Ui.STOP : Ui.INK, 0, 22));
        sendGlyph.setTextColor(stopping ? Ui.ON_STOP : Ui.ON_INK);
        send.setContentDescription(d);
        Suggest.refresh(this);
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
        /** The text is being set from outside, an image's token written, or its image numbers
         *  rewritten (imagesFollow). */
        boolean setting, placing, renumbering;
        /** The text last copied or cut here, and the images its tokens named. */
        String clipText;
        java.util.Map<Integer, Attach.Up> clip = new java.util.HashMap<>();

        @Override public void setText(CharSequence text, BufferType type) {
            setting = true;
            try { super.setText(text, type); } finally { setting = false; }
        }

        /** Writes `[Image #n]` at the cursor, spaces where words would touch it. */
        void insertImage(int n) {
            Editable e = getText();
            // A token written by hand that named no image must not start naming this one.
            List<int[]> all = TagList.images(e);
            renumbering = true;
            try {
                for (int i = all.size() - 1; i >= 0; i--) {
                    if (all.get(i)[2] >= n) e.replace(all.get(i)[0], all.get(i)[1], TagList.defused(all.get(i)[2]));
                }
            } finally { renumbering = false; }
            placing = true;
            try {
                int at = Math.max(getSelectionStart(), getSelectionEnd());
                if (at < 0 || (at == 0 && !hasFocus())) at = e.length();
                String head = at > 0 && !Character.isWhitespace(e.charAt(at - 1)) ? " " : "";
                String tail = at < e.length() && Character.isWhitespace(e.charAt(at)) ? "" : " ";
                String token = head + TagList.token(n) + tail;
                e.insert(at, token);
                setSelection(at + token.length());
            } finally { placing = false; }
        }

        /** Image `n` left the message: its tokens go and the later numbers move down, one space
         *  staying between the words around a token (src/usertext.rs `forget_image`). */
        void forgetImage(int n) {
            Editable e = getText();
            List<int[]> all = TagList.images(e);
            renumbering = true;
            try {
                for (int i = all.size() - 1; i >= 0; i--) {
                    int[] t = all.get(i);
                    if (t[2] > n) e.replace(t[0], t[1], TagList.token(t[2] - 1));
                    else if (t[2] == n) {
                        boolean space = t[1] < e.length() && e.charAt(t[1]) == ' ' && (t[0] == 0 || Character.isWhitespace(e.charAt(t[0] - 1)));
                        e.delete(t[0], space ? t[1] + 1 : t[1]);
                    }
                }
            } finally { renumbering = false; }
            for (int[] t : TagList.images(e)) pick(t[0], t[1]);
        }

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

        /** A token picked from a menu (`@file`, `#12`, `/command`) or a mentioned chat's title:
         *  any erase in it takes all of it, as the desktop's composer does (src/usertext.rs
         *  `erase`). A span, so it holds whichever way the text is erased: the keyboard's
         *  backspace (deleteSurroundingText or a shorter composing word) or a hardware Del. */
        static final class Picked implements android.text.NoCopySpan { }

        private Picked erasing; // the token an erase under way touches
        private boolean expanding;

        /** Marks `[from, to)` as a picked token. */
        void pick(int from, int to) {
            Editable e = getText();
            if (from < 0 || to > e.length() || from >= to) return;
            for (Picked p : e.getSpans(from, to, Picked.class)) if (e.getSpanStart(p) == from && e.getSpanEnd(p) == to) return;
            e.setSpan(new Picked(), from, to, android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        }

        private final TextWatcher whole = new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int start, int count, int after) {
                erasing = null;
                if (expanding || count <= after || !(s instanceof android.text.Spanned)) return;
                android.text.Spanned sp = (android.text.Spanned) s;
                int end = start + count;
                for (Picked p : sp.getSpans(Math.max(0, start - 1), end, Picked.class)) {
                    int a = sp.getSpanStart(p), z = sp.getSpanEnd(p);
                    // Part of it (not all: that needs nothing more), or the space just after it.
                    boolean part = start < z && end > a && (start > a || end < z);
                    boolean space = after == 0 && count == 1 && start == z && s.charAt(start) == ' ';
                    if (part || space) { erasing = p; return; }
                }
            }
            @Override public void onTextChanged(CharSequence s, int start, int before, int count) {
                // Typed inside one: it's text of its own now.
                if (expanding || before != 0 || count == 0 || !(s instanceof android.text.Spannable)) return;
                android.text.Spannable sp = (android.text.Spannable) s;
                for (Picked p : sp.getSpans(start, start + count, Picked.class))
                    if (sp.getSpanStart(p) < start && sp.getSpanEnd(p) > start + count) sp.removeSpan(p);
            }
            @Override public void afterTextChanged(Editable e) {
                Picked p = erasing;
                erasing = null;
                if (p == null) return;
                int a = e.getSpanStart(p), z = e.getSpanEnd(p);
                e.removeSpan(p);
                if (a < 0 || z <= a) return;
                // One space stays between the words around it.
                if (z < e.length() && e.charAt(z) == ' ' && (a == 0 || e.charAt(a - 1) == ' ')) z++;
                expanding = true;
                try { e.delete(a, z); } finally { expanding = false; }
                // The keyboard's composing word may have pointed into it.
                post(() -> {
                    android.view.inputmethod.InputMethodManager im = (android.view.inputmethod.InputMethodManager) getContext().getSystemService(Context.INPUT_METHOD_SERVICE);
                    if (im != null) im.restartInput(Edit.this);
                });
            }
        };

        Edit(Context c, Attach attach) {
            super(c);
            this.attach = attach;
            addTextChangedListener(whole);
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
            if (attach != null && (id == android.R.id.cut || id == android.R.id.copy) && getSelectionStart() != getSelectionEnd()) {
                int a = Math.min(getSelectionStart(), getSelectionEnd()), b = Math.max(getSelectionStart(), getSelectionEnd());
                clipText = getText().subSequence(a, b).toString();
                clip = attach.named(TagList.images(clipText));
            }
            if (attach != null && Build.VERSION.SDK_INT < 31 && (id == android.R.id.paste || id == android.R.id.pasteAsPlainText) && pasteImages()) return true;
            return super.onTextContextMenuItem(id);
        }

        /** A message copied here with its images (Copied) pasted back: its images attach, its text
         *  types at the cursor with each `[Image #k]` naming the k-th of them now (a user message's),
         *  and those its text doesn't name get their tokens after it, as on the desktop
         *  (ts usertext.ts `pastedCopy`). False: the clip isn't such a copy. */
        boolean pasteCopy(ClipData from) {
            Copied.Info c = attach == null ? null : Copied.mine(from);
            if (c == null) return false;
            java.util.function.IntConsumer on = attach.onImage;
            attach.onImage = null; // the tokens are written below, not at each attach
            java.util.Map<Integer, Attach.Up> named = new java.util.HashMap<>();
            List<Attach.Up> ups = new ArrayList<>();
            try {
                for (int i = 0; i < c.uris.size(); i++) {
                    Attach.Up u = attach.paste(c.uris.get(i), null);
                    ups.add(u);
                    if (c.named) named.put(i + 1, u);
                }
            } finally { attach.onImage = on; }
            clipText = c.text;
            clip = named; // arrived() maps the tokens of the text typed below to these images
            int a = Math.max(0, getSelectionStart()), b = Math.max(0, getSelectionEnd());
            getText().replace(Math.min(a, b), Math.max(a, b), c.text);
            java.util.Set<Integer> said = new java.util.HashSet<>();
            if (c.named) for (int[] t : TagList.images(c.text)) said.add(t[2]);
            for (int i = 0; i < ups.size(); i++) if (!said.contains(i + 1) && ups.get(i).number > 0) insertImage(ups.get(i).number);
            attached();
            return true;
        }

        /** Attaches the clipboard's images and types its text; false when it holds no image. */
        private boolean pasteImages() {
            ClipboardManager cm = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
            ClipData clip = cm == null ? null : cm.getPrimaryClip();
            if (clip == null) return false;
            if (pasteCopy(clip)) return true;
            List<Uri> images = new ArrayList<>();
            StringBuilder text = new StringBuilder();
            for (int i = 0; i < clip.getItemCount(); i++) {
                ClipData.Item it = clip.getItemAt(i);
                boolean image = it.getUri() != null && Attach.image(getContext(), it.getUri(), clip.getDescription());
                if (image) images.add(it.getUri());
                // An item can hold an image and its text both (a message copied with its image).
                if (it.getText() != null) text.append(it.getText());
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
                if (e.pasteCopy(all)) return null;
                ClipData rest = null;
                boolean took = false;
                for (int i = 0; i < all.getItemCount(); i++) {
                    ClipData.Item it = all.getItemAt(i);
                    ClipData.Item left = it;
                    if (it.getUri() != null && Attach.image(v.getContext(), it.getUri(), all.getDescription())) {
                        attach.paste(it.getUri(), null);
                        took = true;
                        // An item can hold an image and its text both (a message copied with its image): the text goes on.
                        left = it.getText() != null && it.getText().length() > 0 ? new ClipData.Item(it.getText()) : null;
                    }
                    if (left == null) continue;
                    if (rest == null) rest = new ClipData(all.getDescription(), left);
                    else rest.addItem(left);
                }
                if (took) e.attached();
                return rest == null ? null : new ContentInfo.Builder(payload).setClip(rest).build();
            });
        }
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
        s.card().addView(Ui.cardRow(a, Ui.I_GAUGE, "Claude usage", "5-hour and weekly limits", Ui.FG,
                v -> { s.dismiss(); Limits.show(a, attach.hub()); }), Ui.fill());
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
