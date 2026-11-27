package dev.harbor.app;

import android.app.Activity;
import android.graphics.drawable.GradientDrawable;
import android.text.SpannableStringBuilder;
import android.text.Spanned;
import android.text.TextUtils;
import android.text.style.ForegroundColorSpan;
import android.text.util.Linkify;
import android.view.Gravity;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashMap;
import java.util.Map;

/**
 * The Person AI's card (the PC's persons.slint Bubble): the user's note "To the AI" (a forwarded message quoted over it)
 * or the AI's answer (its markdown as the hub's blocks, its ```reply drafts as cards with Copy and "Use as reply"),
 * older answers folded to two lines and their first draft. Drawn in a person's chat (PersonsChat) and in a site
 * request's pane (PersonsSr) at the point each note was sent.
 */
final class PersonsAiCard {
    private PersonsAiCard() {}

    /** What the card asks of the screen it's on. */
    interface Host {
        /** A draft into the composer, to send to the person (or the store). */
        void useReply(String text);
        /** The card's long-press menu: Use as reply (`use`) and Copy text. */
        void menu(String text, String use, boolean mine);
        /** Draw again (an answer folded or opened). */
        void rerender();
    }

    /** The answers the user folded (true) or opened (false), by id: kept while the app runs. */
    static final Map<String, Boolean> FOLD = new HashMap<>();

    /** The Person AI's note (mine, right) or answer (left), apart from the conversation. `newestAi`: the newest answer's
     *  id (it stays open; older ones fold until tapped). */
    static View view(Activity a, JSONObject e, String newestAi, int maxW, Host host) {
        boolean mine = "user".equals(PersonsUi.s(e, "role"));
        LinearLayout wrap = Ui.col(a);
        wrap.setGravity(mine ? Gravity.END : Gravity.START);
        wrap.setPadding(Ui.dp(mine ? 48 : 12), Ui.dp(8), Ui.dp(mine ? 12 : 24), 0);
        LinearLayout b = Ui.col(a);
        GradientDrawable g = Ui.round(PersonsUi.aiFill(), 0, 18);
        g.setStroke(Ui.dp(1), PersonsUi.aiLine(), Ui.dp(4), Ui.dp(3));
        b.setBackground(g);
        b.setPadding(Ui.dp(12), Ui.dp(8), Ui.dp(12), Ui.dp(10));
        LinearLayout h = Ui.row(a);
        TextView mark = Ui.icon(a, Ui.I_SPARKLES, 11, Ui.ON_INK);
        mark.setBackground(Ui.round(Ui.INK, 0, 9));
        h.addView(mark, new LinearLayout.LayoutParams(Ui.dp(18), Ui.dp(18)));
        long t = PersonsUi.ms(PersonsUi.s(e, "at"));
        h.addView(Ui.subtitle(Ui.bold(a, mine ? "To the AI" : "AI", 13, Ui.FG)), Ui.margins(Ui.wrap(), 6, 0, 0, 0));
        h.addView(Ui.subtitle(Ui.text(a, " · Only you see this" + (t > 0 ? " · " + PersonsUi.clock(t) : ""), 12, Ui.G600)));
        // An answer folds to its header, two lines and its first draft: tap the header (or the folded text) to toggle.
        JSONArray fparts = mine ? null : e.optJSONArray("parts");
        String aid = PersonsUi.s(e, "id");
        boolean foldable = fparts != null && fparts.length() > 0 && !e.optBoolean("streaming");
        Boolean toggled = FOLD.get(aid);
        boolean folded = foldable && (toggled != null ? toggled : !aid.equals(newestAi));
        if (foldable) {
            View.OnClickListener flip = v -> { FOLD.put(aid, !folded); host.rerender(); };
            h.setGravity(Gravity.CENTER_VERTICAL);
            h.addView(new View(a), Ui.spacer());
            h.addView(Ui.icon(a, folded ? Ui.I_DOWN : Ui.I_UP, 14, Ui.G600), Ui.margins(Ui.wrap(), 8, 0, 0, 0));
            h.setOnClickListener(flip);
            h.setContentDescription(folded ? "AI answer, folded: tap to show it all" : "AI answer: tap to fold it");
            b.addView(h, Ui.margins(Ui.fill(), 0, 0, 0, 4));
        } else b.addView(h, Ui.margins(Ui.wrap(), 0, 0, 0, 4));
        if (folded) {
            String draft = "";
            for (int i = 0; i < fparts.length(); i++) {
                JSONObject p = fparts.optJSONObject(i);
                if (p != null && "draft".equals(PersonsUi.s(p, "type"))) { draft = PersonsUi.s(p, "text"); break; }
            }
            View.OnClickListener flip = v -> { FOLD.put(aid, false); host.rerender(); };
            String pv = preview(fparts);
            if (!pv.isEmpty()) {
                TextView tv = Ui.text(a, pv, 15, Ui.G700);
                tv.setMaxLines(2);
                tv.setEllipsize(TextUtils.TruncateAt.END);
                tv.setOnClickListener(flip);
                b.addView(tv, Ui.fill());
            }
            if (!draft.isEmpty()) b.addView(draftLine(a, draft, flip, host), Ui.margins(Ui.fill(), 0, pv.isEmpty() ? 0 : 8, 0, 0));
            String all = PersonsUi.s(e, "text");
            String use = draft.isEmpty() ? all : draft;
            b.setOnLongClickListener(v -> { host.menu(all, use, false); return true; });
            wrap.addView(b, new LinearLayout.LayoutParams(maxW + Ui.dp(24), LinearLayout.LayoutParams.WRAP_CONTENT));
            return wrap;
        }
        String raw = PersonsUi.s(e, "text");
        // Forward to AI: the forwarded message quoted over the question (empty: the default one)
        JSONObject fw = mine ? PersonsUi.obj(e, "forwarded") : null;
        if (fw != null) {
            TextView q = Ui.subtitle(Ui.text(a, quote(PersonsUi.s(fw, "from"), PersonsUi.s(fw, "text")), 13, Ui.G700));
            q.setPadding(Ui.dp(8), Ui.dp(4), Ui.dp(8), Ui.dp(4));
            q.setBackground(Ui.round(Ui.BG, Ui.LINE, 8));
            q.setMaxWidth(maxW);
            b.addView(q, Ui.margins(Ui.wrap(), 0, 2, 0, 6));
        }
        String text = fw != null && raw.isEmpty() ? "What should I reply to this?" : raw;
        JSONArray parts = mine ? null : e.optJSONArray("parts");
        // "Use as reply" in the menu: the first draft it wrote, else the whole answer.
        String use = text;
        for (int i = 0; parts != null && i < parts.length(); i++) {
            JSONObject p = parts.optJSONObject(i);
            if (p != null && "draft".equals(PersonsUi.s(p, "type"))) { use = PersonsUi.s(p, "text"); break; }
        }
        String useText = use;
        View.OnLongClickListener lp = v -> { host.menu(text, useText, mine); return true; };
        b.setOnLongClickListener(lp);
        if (parts != null && parts.length() > 0) {
            // The answer's markdown as the hub's blocks (Projects' Render), its ```reply drafts as cards
            // (the engine's persons aiparts.ts splits them).
            boolean done = !e.optBoolean("streaming");
            Render r = new Render(a, lp);
            for (int i = 0; i < parts.length(); i++) {
                JSONObject p = parts.optJSONObject(i);
                if (p == null) continue;
                View v;
                if ("draft".equals(PersonsUi.s(p, "type"))) v = draftCard(a, PersonsUi.s(p, "text"), done, host);
                else {
                    LinearLayout col = Ui.col(a);
                    JSONArray bs = p.optJSONArray("blocks");
                    if (bs != null && bs.length() > 0) r.blocks(col, bs);
                    else col.addView(r.para(PersonsUi.s(p, "text")));
                    v = col;
                }
                b.addView(v, Ui.margins(Ui.fill(), 0, b.getChildCount() > 1 ? 10 : 0, 0, 0));
            }
            wrap.addView(b, new LinearLayout.LayoutParams(maxW + Ui.dp(24), LinearLayout.LayoutParams.WRAP_CONTENT));
            return wrap;
        }
        TextView tv = Ui.text(a, text.isEmpty() ? "…" : text, 15, Ui.FG);
        tv.setMaxWidth(maxW);
        tv.setLinkTextColor(Ui.BLUE);
        Linkify.addLinks(tv, Linkify.WEB_URLS);
        b.addView(tv);
        tv.setOnLongClickListener(lp);
        wrap.addView(b, Ui.wrap());
        return wrap;
    }

    /** A folded answer's text as one plain paragraph (markdown marks, links' urls and fences dropped; the PC's
     *  view.ts aiPreview): the bubble shows its first two lines. */
    static String preview(JSONArray parts) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < parts.length(); i++) {
            JSONObject p = parts.optJSONObject(i);
            if (p == null || "draft".equals(PersonsUi.s(p, "type"))) continue;
            sb.append(PersonsUi.s(p, "text")).append('\n');
        }
        String t = sb.toString()
                .replaceAll("(?m)^```.*$", "")
                .replaceAll("(?m)^\\s{0,3}(#{1,6}|>+|[-*+]|\\d+[.)])\\s+", "")
                .replaceAll("!?\\[([^\\]]*)\\]\\([^)]*\\)", "$1")
                .replaceAll("(\\*\\*|__|~~|`)", "")
                .replaceAll("\\s+", " ")
                .trim();
        return t.length() > 400 ? t.substring(0, 399).trim() + "…" : t;
    }

    /** A folded answer's draft on one line (DraftCard's colours) with "Use as reply"; a tap elsewhere opens the answer. */
    static View draftLine(Activity a, String draft, View.OnClickListener open, Host host) {
        LinearLayout r = Ui.row(a);
        r.setGravity(Gravity.CENTER_VERTICAL);
        r.setBackground(Ui.round(Ui.G100, Ui.LINE, 14));
        r.setPadding(Ui.dp(12), Ui.dp(6), Ui.dp(6), Ui.dp(6));
        r.addView(Ui.icon(a, Ui.I_SEND, 12, Ui.G600));
        TextView t = Ui.text(a, draft, 14, Ui.FG);
        t.setSingleLine(true);
        t.setEllipsize(TextUtils.TruncateAt.END);
        r.addView(t, Ui.margins(Ui.weight(), 8, 0, 8, 0));
        r.addView(Ds.chip(a, "Use as reply", true, v -> host.useReply(draft)));
        r.setOnClickListener(open);
        return r;
    }

    /** A message the AI drafted for the person (a ```reply block): in the user's own bubble colour, as it
     *  would go out, with "Use as reply" (into the composer) and Copy once the answer is done. */
    static View draftCard(Activity a, String draft, boolean done, Host host) {
        LinearLayout card = Ui.col(a);
        card.setBackground(Ui.round(Ui.G100, Ui.LINE, 14));
        card.setPadding(Ui.dp(12), Ui.dp(8), Ui.dp(12), Ui.dp(10));
        LinearLayout h = Ui.row(a);
        h.setGravity(Gravity.CENTER_VERTICAL);
        h.addView(Ui.icon(a, Ui.I_SEND, 12, Ui.G600));
        TextView label = Ui.bold(a, done ? "REPLY DRAFT" : "REPLY DRAFT · WRITING…", 11.5f, Ui.G600);
        label.setLetterSpacing(0.06f);
        h.addView(label, Ui.margins(Ui.wrap(), 6, 0, 0, 0));
        card.addView(h);
        TextView t = Ui.text(a, draft, 15, Ui.FG);
        t.setTextIsSelectable(true);
        card.addView(t, Ui.margins(Ui.fill(), 0, 6, 0, 0));
        if (done) {
            LinearLayout acts = Ui.row(a);
            acts.setGravity(Gravity.END);
            acts.addView(Ds.chip(a, "Copy", false, v -> Ui.copy(a, draft)));
            acts.addView(Ds.chip(a, "Use as reply", true, v -> host.useReply(draft)), Ui.margins(Ui.wrap(), 8, 0, 0, 0));
            card.addView(acts, Ui.margins(Ui.fill(), 0, 10, 0, 0));
        }
        return card;
    }

    /** "<b>Name</b>  text": a forwarded message over the note. */
    static CharSequence quote(String name, String text) {
        SpannableStringBuilder b = new SpannableStringBuilder();
        b.append(name);
        b.setSpan(new ForegroundColorSpan(Ui.FG), 0, b.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        b.setSpan(new android.text.style.StyleSpan(android.graphics.Typeface.BOLD), 0, b.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        if (!text.isEmpty()) b.append("  ").append(text.replace('\n', ' '));
        return b;
    }
}
