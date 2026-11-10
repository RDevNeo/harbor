package dev.harbor.app;

import android.app.Activity;
import android.graphics.drawable.ColorDrawable;
import android.text.Editable;
import android.text.TextUtils;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.EditorInfo;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.PopupWindow;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/** The new chat's project popover, anchored under the project's name, as the desktop's
 *  (ts/packages/ui/src/logic/projectpop.ts, picker.slint ProjectPop): a search field over an accent
 *  rule, then each project with its tinted initials, "No project" first and "Add project" pinned
 *  last. Typing filters; with a keyboard Up/Down and Enter pick; a tap outside or Back closes it. */
final class ProjectPop {
    interface Pick { void on(String id); }

    /** The id Pick gets for "Add project". */
    static final String ADD = "\u0000add";
    /** The desktop's muted badge tints (projectpop.ts TINTS), picked by the name's String.hashCode. */
    static final int[] TINTS = {0xff9d8fd4, 0xff6fb58a, 0xffd29a62, 0xff6f9fd8, 0xffcf8aa8, 0xff5fb3ad, 0xffc7b265, 0xffd47f7a};
    private static final int ROW = 44, MAX_ROWS = 6;

    private static final class Item {
        final String kind, id, label, hint;
        Item(String kind, String id, String label, String hint) { this.kind = kind; this.id = id; this.label = label; this.hint = hint; }
    }

    private final Activity a;
    private final List<Item> all = new ArrayList<>();
    private final String current;
    private final Pick pick;
    private final PopupWindow win;
    private final LinearLayout list;
    private final ScrollView scroll;
    private final FrameLayout pinned;
    private List<Item> shown = new ArrayList<>();
    private int hover;

    /** Two letters for a badge, as projectpop.ts `initials`. */
    static String initials(String name) {
        String spaced = name.replaceAll("([a-z0-9])([A-Z])", "$1 $2");
        List<String> w = new ArrayList<>();
        for (String s : spaced.split("[^\\p{L}\\p{N}]+")) if (!s.isEmpty()) w.add(s);
        if (w.isEmpty()) return "?";
        String s = w.size() > 1 ? first(w.get(0), 1) + first(w.get(1), 1) : first(w.get(0), 2);
        return s.toUpperCase(Locale.ROOT);
    }

    private static String first(String s, int n) { return s.substring(0, s.offsetByCodePoints(0, Math.min(n, s.codePointCount(0, s.length())))); }

    static int tint(String name) { return TINTS[Math.floorMod(name.hashCode(), TINTS.length)]; }

    /** `st`: the hub's state, its projects and where each one is (Place). */
    static PopupWindow show(Activity a, View anchor, JSONObject st, String current, Pick pick) {
        return new ProjectPop(a, anchor, st, current, pick).win;
    }

    private ProjectPop(Activity a, View anchor, JSONObject st, String current, Pick pick) {
        this.a = a;
        this.current = current == null ? "" : current;
        this.pick = pick;
        all.add(new Item("none", "", "No project", ""));
        JSONArray projects = st.optJSONArray("projects");
        // After the name, as the drawer's project rows: the PC that holds its folder, or for two of one name its folder.
        if (projects != null) for (int i = 0; i < projects.length(); i++) {
            JSONObject j = projects.optJSONObject(i);
            if (j != null) all.add(new Item("project", j.optString("id"), j.optString("name"), Place.hint(st, j.optString("id"))));
        }

        LinearLayout box = Ui.col(a);
        box.setBackground(Ui.round(Ui.CARD, Ui.LINE, 12));
        box.setPadding(Ui.dp(6), Ui.dp(4), Ui.dp(6), Ui.dp(6));
        // The search field and its accent rule.
        LinearLayout search = Ui.row(a);
        search.addView(Ui.icon(a, Ui.I_SEARCH, 17, Ui.G600), new LinearLayout.LayoutParams(Ui.dp(20), Ui.dp(20)));
        EditText field = new EditText(a);
        field.setHint("Search projects...");
        field.setHintTextColor(Ui.G600);
        field.setTextColor(Ui.FG);
        field.setTypeface(Ui.sans);
        field.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 15);
        field.setBackground(null);
        field.setSingleLine(true);
        field.setPadding(Ui.dp(10), Ui.dp(10), Ui.dp(4), Ui.dp(10));
        field.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        field.setImeOptions(EditorInfo.IME_ACTION_GO);
        search.addView(field, Ui.weight());
        box.addView(search, Ui.margins(Ui.fill(), 8, 0, 8, 0));
        View rule = new View(a);
        rule.setBackgroundColor(Ui.BLUE);
        box.addView(rule, Ui.margins(new LinearLayout.LayoutParams(-1, Math.max(1, Ui.dp(1))), 4, 0, 4, 6));
        // The rows, and "Add project" pinned under them.
        list = Ui.col(a);
        scroll = new ScrollView(a);
        scroll.setVerticalScrollBarEnabled(false);
        scroll.addView(list, new FrameLayout.LayoutParams(-1, -2));
        box.addView(scroll, new LinearLayout.LayoutParams(-1, -2));
        pinned = new FrameLayout(a);
        box.addView(pinned, new LinearLayout.LayoutParams(-1, -2));

        int width = Math.min(Ui.dp(280), a.getResources().getDisplayMetrics().widthPixels - Ui.dp(32));
        win = new PopupWindow(box, width, ViewGroup.LayoutParams.WRAP_CONTENT, true);
        win.setBackgroundDrawable(new ColorDrawable(0));
        win.setOutsideTouchable(true);
        win.setElevation(Ui.dp(12));
        win.setInputMethodMode(PopupWindow.INPUT_METHOD_NEEDED);

        field.addTextChangedListener(new TextWatcher() {
            public void beforeTextChanged(CharSequence s, int st, int c, int af) { }
            public void onTextChanged(CharSequence s, int st, int b, int c) { }
            public void afterTextChanged(Editable s) { filter(s.toString(), false); }
        });
        field.setOnEditorActionListener((v, id, e) -> { choose(hover); return true; });
        field.setOnKeyListener((v, code, e) -> {
            if (e.getAction() != KeyEvent.ACTION_DOWN) return false;
            int n = shown.size();
            if (n == 0) return false;
            if (code == KeyEvent.KEYCODE_DPAD_DOWN || code == KeyEvent.KEYCODE_DPAD_UP) {
                hover = (hover + (code == KeyEvent.KEYCODE_DPAD_DOWN ? 1 : n - 1)) % n;
                render();
                return true;
            }
            if (code == KeyEvent.KEYCODE_ENTER) { choose(hover); return true; }
            if (code == KeyEvent.KEYCODE_ESCAPE) { win.dismiss(); return true; }
            return false;
        });
        filter("", true);
        // Centred under the name; Android moves it above when there's no room below. The keyboard goes
        // first (picking a project isn't typing): the screen lays out again without it, then it shows.
        Runnable open = () -> {
            if (a.isFinishing() || win.isShowing()) return;
            win.showAsDropDown(anchor, (anchor.getWidth() - width) / 2, Ui.dp(4));
        };
        android.view.inputmethod.InputMethodManager im = (android.view.inputmethod.InputMethodManager) a.getSystemService(Activity.INPUT_METHOD_SERVICE);
        View focus = a.getCurrentFocus();
        boolean hid = im != null && focus != null && im.hideSoftInputFromWindow(focus.getWindowToken(), 0);
        if (!hid) { anchor.post(open); return; }
        anchor.addOnLayoutChangeListener(new View.OnLayoutChangeListener() {
            public void onLayoutChange(View v, int l, int t, int r, int b, int ol, int ot, int or, int ob) {
                if (t == ot) return;
                v.removeOnLayoutChangeListener(this);
                v.post(open);
            }
        });
        anchor.postDelayed(open, 450);
    }

    /** As projectpop.ts `popRows` and `popStart`: "No project" while it matches, the projects
     *  whose name has the query, "Add project" always; the highlight on the current project. */
    private void filter(String query, boolean start) {
        String q = query.trim().toLowerCase(Locale.ROOT);
        shown = new ArrayList<>();
        for (Item it : all) if (q.isEmpty() || it.label.toLowerCase(Locale.ROOT).contains(q)) shown.add(it);
        shown.add(new Item("add", ADD, "Add project", ""));
        hover = 0;
        if (start && q.isEmpty()) for (int i = 0; i < shown.size(); i++) if (!shown.get(i).kind.equals("add") && shown.get(i).id.equals(current)) hover = i;
        render();
    }

    private void render() {
        list.removeAllViews();
        pinned.removeAllViews();
        int listed = shown.size() - 1;
        for (int i = 0; i < listed; i++) list.addView(row(i), new LinearLayout.LayoutParams(-1, Ui.dp(ROW)));
        pinned.addView(row(listed), new FrameLayout.LayoutParams(-1, Ui.dp(ROW)));
        ViewGroup.LayoutParams lp = scroll.getLayoutParams();
        lp.height = Ui.dp(ROW) * Math.min(listed, MAX_ROWS);
        scroll.setLayoutParams(lp);
        if (hover < listed) {
            int y = hover * Ui.dp(ROW);
            scroll.post(() -> {
                if (y < scroll.getScrollY()) scroll.scrollTo(0, y);
                else if (y + Ui.dp(ROW) > scroll.getScrollY() + scroll.getHeight()) scroll.scrollTo(0, y + Ui.dp(ROW) - scroll.getHeight());
            });
        }
    }

    private View row(int i) {
        Item it = shown.get(i);
        LinearLayout r = Ui.row(a);
        r.setPadding(Ui.dp(10), 0, Ui.dp(10), 0);
        r.setBackground(Ui.press(i == hover ? Ui.G200 : 0, 0, 8));
        View badge;
        if (it.kind.equals("project")) {
            int t = tint(it.label);
            TextView b = Ui.bold(a, initials(it.label), 10, t);
            b.setGravity(Gravity.CENTER);
            b.setIncludeFontPadding(false);
            b.setBackground(Ui.round((t & 0x00ffffff) | 0x24000000, (t & 0x00ffffff) | 0x38000000, 6));
            badge = b;
        } else {
            badge = Ui.icon(a, it.kind.equals("add") ? Ui.I_FOLDER_PLUS : Ui.I_FOLDER, 19, Ui.G700);
        }
        r.addView(badge, new LinearLayout.LayoutParams(Ui.dp(24), Ui.dp(24)));
        TextView name = Ui.text(a, it.label, 15, Ui.FG);
        name.setSingleLine(true);
        name.setEllipsize(TextUtils.TruncateAt.END);
        if (it.hint.isEmpty()) r.addView(name, Ui.margins(Ui.weight(), 12, 0, 0, 0));
        else {
            name.setMaxWidth(Ui.dp(160));
            r.addView(name, Ui.margins(new LinearLayout.LayoutParams(-2, -2), 12, 0, 0, 0));
            TextView where = Ui.text(a, it.hint, 13, Ui.G600);
            where.setSingleLine(true);
            where.setEllipsize(TextUtils.TruncateAt.END);
            r.addView(where, Ui.margins(Ui.weight(), 8, 0, 0, 0));
        }
        if (!it.kind.equals("add") && it.id.equals(current)) r.addView(Ui.icon(a, Ui.I_CHECK, 16, Ui.G600), new LinearLayout.LayoutParams(Ui.dp(20), Ui.dp(20)));
        r.setContentDescription(it.label);
        r.setOnClickListener(v -> choose(i));
        return r;
    }

    private void choose(int i) {
        if (i < 0 || i >= shown.size()) return;
        Item it = shown.get(i);
        win.dismiss();
        pick.on(it.id);
    }
}
