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
