package dev.harbor.app;

import android.app.Activity;
import android.content.Context;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.List;

/** Hub's design system on the phone (DESIGN.md "Android"): the parts every tab shares, so Projects' drawer,
 *  Persons and Routine draw their titles, section heads, rows, folds, pills, chips and cards the same way. Built on
 *  Ui's palette, fonts and drawables; Projects' drawer (Sidebar.java) is the reference look. */
final class Ds {
    private Ds() {}

    // ---- tokens (dp / sp) ----

    /** A side-panel row's least height, its press fill's radius, its inset from the edges. */
    static final int ROW_H = 44, ROW_RADIUS = 12, ROW_INSET = 8;
    /** A row's title and second line (sp). */
    static final float T_ROW = 15, T_SUB = 12, T_META = 13, T_CAPS = 11.5f;
    /** A tab's page title (sp, serif bold, as the drawer's "Hub"). */
    static final float T_PAGE = 26;
    /** Cards: radius and padding (dp). */
    static final int CARD_RADIUS = 16, CARD_PAD_X = 14, CARD_PAD_Y = 12;
    /** Chips: radius (dp) and text (sp). */
    static final int CHIP_RADIUS = 18;
    static final float T_CHIP = 13;

    // ---- titles and heads ----

    /** A tab's title at the top of its screen ("Hub", "Persons", "Routine"). */
    static TextView pageTitle(Context c, String s) {
        return Ui.heading(c, s, T_PAGE);
    }

    /** A screen's heading inside a page ("Today", "History"): the same serif, a little smaller, room under it. */
    static TextView screenTitle(Context c, String s) {
        TextView t = Ui.heading(c, s, 24);
        t.setPadding(0, Ui.dp(4), 0, Ui.dp(10));
        return t;
    }

    /** A section's small head in a side list ("PROJECTS", "CREATORS"): caps in G600; `top` for the first one. */
    static TextView caps(Context c, String text, boolean top) {
        TextView t = Ui.text(c, text, T_CAPS, Ui.G600);
        t.setTypeface(Ui.semi);
        t.setLetterSpacing(0.06f);
        t.setAllCaps(true);
        t.setPadding(Ui.dp(20), Ui.dp(top ? 6 : 16), Ui.dp(20), Ui.dp(4));
        return t;
    }

    /** A section's head that folds ("STORES ›"): the caps, the chevron, an unread pill on the right; a tap folds. */
    static LinearLayout sectionHead(Context c, String text, boolean open, int unread, View.OnClickListener toggle) {
        LinearLayout r = Ui.row(c);
        r.setMinimumHeight(Ui.dp(40));
        r.setPadding(Ui.dp(12), Ui.dp(14), Ui.dp(12), Ui.dp(4));
        r.setBackground(Ui.press(0, 0, ROW_RADIUS));
        TextView t = Ui.text(c, text, T_CAPS, Ui.G600);
        t.setTypeface(Ui.semi);
        t.setLetterSpacing(0.06f);
        t.setAllCaps(true);
        r.addView(t);
        r.addView(chevron(c, open), Ui.margins(new LinearLayout.LayoutParams(Ui.dp(18), Ui.dp(18)), 4, 0, 0, 0));
        r.addView(new View(c), Ui.weight());
        if (unread > 0) r.addView(pill(c, unread, true));
        if (toggle != null) r.setOnClickListener(toggle);
        r.setContentDescription(text + (open ? ", open" : ", folded"));
        return r;
    }

    // ---- the frame every tab shares: top bar, drawer (DESIGN.md "Android") ----

    /** The top bar's height (dp): every page of every tab, chats too. */
    static final int BAR_H = 52;
    /** A top bar's title (sp, semi-bold) and its second line. */
    static final float T_BAR = 16, T_BAR_SUB = 12;

    /** A page's top bar: `lead` (the side-panel button, or a back arrow on a sub-page) at the far left, the title
     *  (and an optional second line) beside it, the page's actions on the right. One hairline under it. */
    static final class TopBar {
        final LinearLayout view, row, actions, titles;
        final FrameLayout lead;
        final TextView title, sub;

        TopBar(Context c, View leadView, String text) {
            view = Ui.col(c);
            view.setBackgroundColor(Ui.BG);
            LinearLayout r = Ui.row(c);
            row = r;
            r.setGravity(Gravity.CENTER_VERTICAL);
            r.setPadding(Ui.dp(4), 0, Ui.dp(6), 0);
            r.setMinimumHeight(Ui.dp(BAR_H));
            lead = new FrameLayout(c);
            if (leadView != null) lead.addView(leadView, new FrameLayout.LayoutParams(Ui.dp(44), Ui.dp(44), Gravity.CENTER));
            r.addView(lead, new LinearLayout.LayoutParams(leadView == null ? Ui.dp(12) : Ui.dp(44), Ui.dp(44)));
            titles = Ui.col(c);
            titles.setGravity(Gravity.CENTER_VERTICAL);
            titles.setPadding(Ui.dp(leadView == null ? 4 : 6), 0, Ui.dp(6), 0);
            title = Ui.subtitle(Ui.bold(c, text == null ? "" : text, T_BAR, Ui.FG));
            sub = Ui.subtitle(Ui.text(c, "", T_BAR_SUB, Ui.G700));
            sub.setVisibility(View.GONE);
            titles.addView(title, Ui.fill());
            titles.addView(sub, Ui.fill());
            r.addView(titles, Ui.weight());
            actions = Ui.row(c);
            actions.setGravity(Gravity.END | Gravity.CENTER_VERTICAL);
            r.addView(actions, Ui.wrap());
            view.addView(r, Ui.fill());
            view.addView(hairline(c), new LinearLayout.LayoutParams(-1, Math.max(1, Ui.dp(0.5f))));
        }

        /** A mark before the title (a person's avatar, a store's square), `size` dp. */
        TopBar mark(View v, int size) {
            row.addView(v, row.indexOfChild(titles), Ui.margins(new LinearLayout.LayoutParams(Ui.dp(size), Ui.dp(size)), 4, 0, 4, 0));
            return this;
        }

        TopBar sub(CharSequence s, int color) {
            sub.setText(s == null ? "" : s);
            sub.setTextColor(color);
            sub.setVisibility(s == null || s.length() == 0 ? View.GONE : View.VISIBLE);
            return this;
        }

        /** A 40dp ghost icon button on the right. */
        TextView action(String glyph, String label, View.OnClickListener on) {
            TextView t = barButton(view.getContext(), glyph, on);
            t.setContentDescription(label);
            actions.addView(t);
            return t;
        }
    }

    static TopBar topBar(Context c, View lead, String title) { return new TopBar(c, lead, title); }

    /** The top bar's side-panel button (Lucide panel-left): opens the tab's drawer. */
    static TextView sideButton(Context c, View.OnClickListener on) {
        TextView t = barButton(c, Ui.I_PANEL_LEFT, on);
        t.setContentDescription("Open the side panel");
        return t;
    }

    /** A sub-page's back arrow, in the side-panel button's place. */
    static TextView backButton(Context c, View.OnClickListener on) {
        TextView t = barButton(c, Ui.I_LEFT, on);
        t.setContentDescription("Back");
        return t;
    }

    /** A top bar's icon button: 20dp glyph on a 40dp round press. */
    static TextView barButton(Context c, String glyph, View.OnClickListener on) {
        TextView t = Ui.icon(c, glyph, 20, Ui.FG);
        t.setBackground(Ui.press(0, 0, 20));
        t.setLayoutParams(new LinearLayout.LayoutParams(Ui.dp(40), Ui.dp(40)));
        t.setOnClickListener(on);
        return t;
    }

    static View hairline(Context c) {
        View v = new View(c);
        v.setBackgroundColor(Ui.LINE);
        return v;
    }

    /** The drawer's width: most of the screen, as Headquarters' sheet (at most 340dp). */
    static int drawerWidth(Context c) {
        return Math.min(c.getResources().getDisplayMetrics().widthPixels * 84 / 100, Ui.dp(340));
    }

    /** A drawer's head, the same for every tab and in line with the page's top bar: BAR_H tall, the tab's name in the
     *  top bar's title style at the rows' glyph column (20dp), its buttons (`action`) on the right, the same hairline
     *  under it as the top bar's, so the bar runs on across the drawer. */
    static final class DrawerHead {
        final LinearLayout view, row;
        final TextView title;

        DrawerHead(Context c, String text) {
            view = Ui.col(c);
            row = Ui.row(c);
            row.setGravity(Gravity.CENTER_VERTICAL);
            row.setMinimumHeight(Ui.dp(BAR_H));
            row.setPadding(Ui.dp(20), 0, Ui.dp(6), 0);
            title = Ui.subtitle(Ui.bold(c, text, T_BAR, Ui.FG));
            row.addView(title, Ui.weight());
            view.addView(row, Ui.fill());
            view.addView(hairline(c), new LinearLayout.LayoutParams(-1, Math.max(1, Ui.dp(0.5f))));
        }

        /** A 40dp ghost icon button on the right (the top bar's). */
        TextView action(String glyph, String label, View.OnClickListener on) {
            TextView t = barButton(view.getContext(), glyph, on);
            t.setContentDescription(label);
            row.addView(t);
            return t;
        }
    }

    static DrawerHead drawerHead(Context c, String title) { return new DrawerHead(c, title); }

    /** A tab's drawer: the page's own black (BG), its head (drawerHead) and `body` under it. Base.installTab draws
     *  the hairline down its right edge. */
    static LinearLayout drawer(Context c, String title, View body) {
        LinearLayout d = Ui.col(c);
        d.setBackgroundColor(Ui.BG);
        d.setClickable(true); // taps never fall through to the page
        d.addView(drawerHead(c, title).view, Ui.fill());
        if (body != null) d.addView(body, new LinearLayout.LayoutParams(-1, 0, 1));
        return d;
    }

    /** A drawer's page row (Routine's Today, Collector's Available): glyph, label, an optional count; G200 when it's
     *  the page on screen. */
    static View navRow(Context c, String glyph, String label, String count, boolean on, View.OnClickListener l) {
        LinearLayout r = row(c, false);
        r.setBackground(on ? Ui.press(Ui.G200, 0, ROW_RADIUS) : Ui.press(0, 0, ROW_RADIUS));
        r.setGravity(Gravity.CENTER_VERTICAL);
        r.addView(Ui.icon(c, glyph, 18, on ? Ui.FG : Ui.G700), new LinearLayout.LayoutParams(Ui.dp(22), Ui.dp(22)));
        r.addView(rowTitle(c, label, on, on ? Ui.FG : Ui.G900), Ui.margins(Ui.weight(), 12, 0, 0, 0));
        if (count != null && !count.isEmpty()) {
            TextView m = Ui.subtitle(meta(c, count));
            m.setMaxWidth(Ui.dp(160));
            r.addView(m, Ui.margins(Ui.wrap(), 10, 0, 0, 0));
        }
        r.setContentDescription(label + (on ? ", open" : ""));
        if (l != null) r.setOnClickListener(l);
        return inset(c, r, 0);
    }

    // ---- rows ----

    /** A side-list row: one line, ROW_H tall, the press fill rounded (G100 while selected). Lead marks, title and
     *  trailing views are added to it. */
    static LinearLayout row(Context c, boolean selected) {
        LinearLayout r = Ui.row(c);
        r.setMinimumHeight(Ui.dp(ROW_H));
        r.setPadding(Ui.dp(12), Ui.dp(6), Ui.dp(12), Ui.dp(6));
        r.setBackground(selected ? Ui.press(Ui.G100, 0, ROW_RADIUS) : Ui.press(0, 0, ROW_RADIUS));
        return r;
    }

    /** A row ROW_INSET in from the edges (its press fill rounded), `indent` more on the left. */
    static View inset(Context c, View r, float indent) {
        LinearLayout w = Ui.col(c);
        w.setPadding(Ui.dp(ROW_INSET + indent), 0, Ui.dp(ROW_INSET), 0);
        w.addView(r, Ui.fill());
        return w;
    }

    /** A row's title: one line, ellipsized; semi-bold when it's a head or unread. */
    static TextView rowTitle(Context c, CharSequence s, boolean strong, int color) {
        TextView t = Ui.subtitle(strong ? Ui.bold(c, s, T_ROW, color) : Ui.text(c, s, T_ROW, color));
        return t;
    }

    /** A row's right side: a count or when ("5", "13m ago"), quiet. */
    static TextView meta(Context c, CharSequence s) {
        return Ui.text(c, s, T_META, Ui.G600);
    }

    /** The fold's chevron: down while open, right while folded. */
    static TextView chevron(Context c, boolean open) {
        return Ui.icon(c, open ? Ui.I_DOWN : Ui.I_CHEV_RIGHT, 14, Ui.G600);
    }

    /** A project's or a store's lead square: its letter on a quiet square (`tint` 0), or on its colour. */
    static TextView letter(Context c, String letter, int tint, float size) {
        TextView t = Ui.bold(c, letter, size * 0.55f, tint == 0 ? Ui.FG : 0xffffffff);
        t.setGravity(Gravity.CENTER);
        t.setIncludeFontPadding(false);
        t.setBackground(Ui.round(tint != 0 ? tint : Ui.dark ? Ui.G300 : Ui.G200, 0, size / 4));
        t.setLayoutParams(new LinearLayout.LayoutParams(Ui.dp(size), Ui.dp(size)));
        return t;
    }

    /** A fold under a list ("Settled (12)"): the label, a hairline to the edge and the chevron (up open, down folded). */
    static LinearLayout foldBar(Context c, String label, boolean open, View.OnClickListener toggle) {
        LinearLayout h = Ui.row(c);
        h.setGravity(Gravity.CENTER_VERTICAL);
        h.setPadding(Ui.dp(20), Ui.dp(14), Ui.dp(18), Ui.dp(6));
        h.setBackground(Ui.press(0, 0, 0));
        h.setContentDescription(label + (open ? ", open" : ", folded"));
        h.addView(Ui.text(c, label, T_META, Ui.G700), Ui.wrap());
        View line = new View(c);
        line.setBackgroundColor(Ui.dark ? Ui.G400 : Ui.G300);
        h.addView(line, Ui.margins(new LinearLayout.LayoutParams(0, Math.max(1, Ui.dp(1)), 1), 12, 0, 12, 0));
        h.addView(Ui.icon(c, open ? Ui.I_UP_CHEVRON : Ui.I_DOWN, 15, Ui.G600), new LinearLayout.LayoutParams(Ui.dp(20), Ui.dp(20)));
        if (toggle != null) h.setOnClickListener(toggle);
        return h;
    }

    // ---- badges, chips, cards ----

    /** A count in a small round pill: ink (unread on a row) or blue (a section's total). */
    static TextView pill(Context c, int n, boolean blue) {
        TextView t = Ui.bold(c, n > 99 ? "99+" : String.valueOf(n), 11, blue ? 0xffffffff : Ui.ON_INK);
        t.setGravity(Gravity.CENTER);
        t.setIncludeFontPadding(false);
        t.setMinWidth(Ui.dp(18));
        t.setPadding(Ui.dp(5), Ui.dp(2), Ui.dp(5), Ui.dp(2));
        t.setBackground(Ui.round(blue ? Ui.BLUE : Ui.INK, 0, 9));
        t.setContentDescription(n + " unread");
        return t;
    }

    /** A pill choice or quick action (+250 ml, Start, a filter): G200, INK when on. */
    static TextView chip(Context c, String label, boolean on, View.OnClickListener l) {
        TextView t = Ui.bold(c, label, T_CHIP, on ? Ui.ON_INK : Ui.FG);
        t.setGravity(Gravity.CENTER);
        t.setPadding(Ui.dp(14), Ui.dp(8), Ui.dp(14), Ui.dp(8));
        t.setBackground(Ui.press(on ? Ui.INK : Ui.G200, 0, CHIP_RADIUS));
        if (l != null) t.setOnClickListener(l);
        return t;
    }

    /** A pill with a glyph before its label (a section switch, a connection). */
    static LinearLayout iconChip(Context c, String glyph, String label, boolean on, View.OnClickListener l) {
        LinearLayout r = Ui.row(c);
        r.setPadding(Ui.dp(12), Ui.dp(8), Ui.dp(14), Ui.dp(8));
        r.setBackground(Ui.press(on ? Ui.G200 : 0, 0, CHIP_RADIUS));
        r.addView(Ui.icon(c, glyph, 16, on ? Ui.FG : Ui.G700));
        TextView t = on ? Ui.bold(c, label, 14, Ui.FG) : Ui.text(c, label, 14, Ui.G700);
        t.setPadding(Ui.dp(6), 0, 0, 0);
        r.addView(t);
        if (l != null) r.setOnClickListener(l);
        r.setContentDescription(label + (on ? ", selected" : ""));
        return r;
    }

    /** A content card (a goal, a sign-in, a person's socials): CARD on LINE, 16dp round. */
    static LinearLayout card(Context c) {
        LinearLayout l = Ui.col(c);
        l.setBackground(Ui.round(Ui.CARD, Ui.LINE, CARD_RADIUS));
        l.setPadding(Ui.dp(CARD_PAD_X), Ui.dp(CARD_PAD_Y), Ui.dp(CARD_PAD_X), Ui.dp(CARD_PAD_Y));
        return l;
    }

    /** A centred quiet message in an empty page. */
    static TextView empty(Context c, String s) {
        TextView t = Ui.text(c, s, 15, Ui.G700);
        t.setGravity(Gravity.CENTER);
        t.setPadding(Ui.dp(12), Ui.dp(60), Ui.dp(12), 0);
        return t;
    }

    /** A view in a FrameLayout, centred (a dot in a lead column). */
    static View centred(Context c, View v) {
        FrameLayout f = new FrameLayout(c);
        ViewGroup.LayoutParams p = v.getLayoutParams();
        f.addView(v, new FrameLayout.LayoutParams(p == null ? -2 : p.width, p == null ? -2 : p.height, Gravity.CENTER));
        return f;
    }

    // ---- menus ----

    /** One entry of a menu: a glyph, a label, what it does; or a hairline between groups. */
    static final class Item {
        final String glyph, label;
        final boolean danger, sep;
        final Runnable run;
        Item(String glyph, String label, boolean danger, Runnable run) { this.glyph = glyph; this.label = label; this.danger = danger; this.sep = false; this.run = run; }
        Item() { glyph = ""; label = ""; danger = false; sep = true; run = null; }
    }

    static Item item(String glyph, String label, Runnable run) { return new Item(glyph, label, false, run); }
    static Item danger(String glyph, String label, Runnable run) { return new Item(glyph, label, true, run); }
    static Item sep() { return new Item(); }

    /** A compact menu (a message's long-press, Person Hub's context menu): a card of 48dp rows, each its glyph
     *  and label, hairlines between groups, red only for destructive entries; a tap outside closes it. */
    static void menu(Activity a, List<Item> items) {
        List<Item> list = new ArrayList<>();
        for (Item it : items) if (!it.sep || (!list.isEmpty() && !list.get(list.size() - 1).sep)) list.add(it);
        while (!list.isEmpty() && list.get(list.size() - 1).sep) list.remove(list.size() - 1);
        if (list.isEmpty()) return;
        android.app.Dialog d = new android.app.Dialog(a);
        d.requestWindowFeature(android.view.Window.FEATURE_NO_TITLE);
        LinearLayout box = Ui.col(a);
        box.setBackground(Ui.round(Ui.CARD, Ui.LINE, 16));
        box.setPadding(Ui.dp(6), Ui.dp(6), Ui.dp(6), Ui.dp(6));
        for (Item it : list) {
            if (it.sep) {
                View line = new View(a);
                line.setBackgroundColor(Ui.LINE);
                box.addView(line, Ui.margins(new LinearLayout.LayoutParams(-1, Ui.dp(1)), -6, 5, -6, 5));
                continue;
            }
            LinearLayout r = Ui.row(a);
            r.setGravity(Gravity.CENTER_VERTICAL);
            r.setMinimumHeight(Ui.dp(48));
            r.setPadding(Ui.dp(12), 0, Ui.dp(14), 0);
            r.setBackground(Ui.press(0, 0, 10));
            int ink = it.danger ? Ui.RED : Ui.FG;
            r.addView(Ui.icon(a, it.glyph, 18, it.danger ? Ui.RED : Ui.G700), new LinearLayout.LayoutParams(Ui.dp(22), Ui.dp(22)));
            r.addView(Ui.text(a, it.label, 15, ink), Ui.margins(Ui.weight(), 12, 0, 0, 0));
            r.setOnClickListener(v -> { d.dismiss(); if (it.run != null) it.run.run(); });
            box.addView(r, Ui.fill());
        }
        d.setContentView(box);
        android.view.Window w = d.getWindow();
        if (w != null) {
            w.setBackgroundDrawable(new android.graphics.drawable.ColorDrawable(android.graphics.Color.TRANSPARENT));
            w.setLayout(Ui.dp(280), ViewGroup.LayoutParams.WRAP_CONTENT);
            w.setDimAmount(0.3f);
        }
        d.setCanceledOnTouchOutside(true);
        d.show();
    }
}
