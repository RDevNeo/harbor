package dev.harbor.app;

import android.app.Activity;
import android.app.Dialog;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.List;

/** A bottom sheet: grab handle, an X, a centred title, and scrolling content of grouped cards
 *  (the reference's "Add to session"). */
final class Sheet {
    final Dialog dialog;
    final LinearLayout body;

    Sheet(Activity a, String title) {
        dialog = new Dialog(a);
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE);
        LinearLayout root = Ui.col(a);
        root.setBackground(Ui.top(Ui.BG, 28));
        root.setPadding(0, Ui.dp(8), 0, Ui.dp(12));
        View handle = new View(a);
        handle.setBackground(Ui.round(Ui.G400, 0, 2));
        LinearLayout.LayoutParams hp = new LinearLayout.LayoutParams(Ui.dp(40), Ui.dp(4));
        hp.gravity = Gravity.CENTER_HORIZONTAL;
        root.addView(handle, hp);

        FrameLayout head = new FrameLayout(a);
        head.setMinimumHeight(Ui.dp(56));
        TextView x = Ui.iconButton(a, Ui.I_X, Ui.FG, v -> dialog.dismiss());
        head.addView(x, new FrameLayout.LayoutParams(Ui.dp(44), Ui.dp(44), Gravity.START | Gravity.CENTER_VERTICAL));
        TextView t = Ui.bold(a, title, 18, Ui.FG);
        t.setGravity(Gravity.CENTER);
        head.addView(t, new FrameLayout.LayoutParams(-2, -2, Gravity.CENTER));
        head.setPadding(Ui.dp(12), 0, Ui.dp(12), 0);
        root.addView(head, Ui.fill());

        ScrollView sv = new ScrollView(a);
        body = Ui.col(a);
        body.setPadding(Ui.dp(14), Ui.dp(4), Ui.dp(14), Ui.dp(8));
        sv.addView(body);
        root.addView(sv, Ui.fill());
        dialog.setContentView(root);
        Window w = dialog.getWindow();
        if (w != null) {
            w.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
            w.setGravity(Gravity.BOTTOM);
            w.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            w.setWindowAnimations(android.R.style.Animation_InputMethod);
            w.setDimAmount(0.35f);
            w.addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);
        }
    }

    /** Adds a card (with 12 dp below) and returns it. */
    LinearLayout card() {
        LinearLayout c = Ui.card(body.getContext());
        body.addView(c, Ui.margins(Ui.fill(), 0, 0, 0, 12));
        return c;
    }

    Sheet show() {
        dialog.show();
        return this;
    }

    void dismiss() { dialog.dismiss(); }

    // ---- a single-choice list ----

    static final class Option {
        final String id, label, sub; final boolean enabled;
        Option(String id, String label, String sub, boolean enabled) { this.id = id; this.label = label; this.sub = sub; this.enabled = enabled; }
    }

    interface Chosen { void on(String id); }

    /** One card of options, a check on the current one; disabled ones are greyed. */
    static Sheet pick(Activity a, String title, String note, List<Option> opts, String current, Chosen chosen) {
        Sheet s = new Sheet(a, title);
        if (note != null && !note.isEmpty()) {
            TextView n = Ui.text(a, note, 14, Ui.G700);
            n.setPadding(Ui.dp(6), 0, Ui.dp(6), Ui.dp(10));
            s.body.addView(n);
        }
        LinearLayout c = s.card();
        boolean first = true;
        for (Option o : opts) {
            if (!first) c.addView(Ui.gap(a));
            first = false;
            LinearLayout r = Ui.cardRow(a, null, o.label, o.sub, o.enabled ? Ui.FG : Ui.G600,
                    o.enabled ? v -> { s.dismiss(); chosen.on(o.id); } : null);
            if (o.id.equals(current)) r.addView(Ui.icon(a, Ui.I_CHECK, 20, Ui.FG), new LinearLayout.LayoutParams(Ui.dp(24), Ui.dp(24)));
            c.addView(r, Ui.fill());
        }
        return s.show();
    }
}
