package dev.harbor.app;

import android.content.Context;
import android.text.SpannableStringBuilder;
import android.text.Spanned;
import android.view.Gravity;
import android.view.View;
import android.widget.TextView;

import org.json.JSONObject;

/** The hub's session recap and prompt suggestion (recap.rs, PROTOCOL.md "status"), drawn like the
 *  desktop: "recap: …" dim over the composer, the text in italics; the suggestion as the empty
 *  composer's grayer placeholder, which the "⇥ Use" chip puts into the text (the desktop's Tab). */
final class Recap {
    private Recap() { }

    /** The recap line, or null when the hub has none. */
    static TextView line(Context c, JSONObject status) {
        String text = status == null ? "" : status.optString("recap", "");
        if (text.isEmpty()) return null;
        SpannableStringBuilder s = new SpannableStringBuilder("recap: ");
        s.setSpan(new Ui.Font(Ui.semi, 0), 0, s.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        int at = s.length();
        s.append(text);
        s.setSpan(new Ui.Font(Ui.sans, -0.2f), at, s.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        return Ui.text(c, s, 14, Ui.G900);
    }

    /** The chip that takes the suggestion; hidden until there is one. */
    static TextView useChip(Context c, Composer comp) {
        TextView t = Ui.text(c, "⇥ Use", 13, Ui.G700);
        t.setGravity(Gravity.CENTER);
        t.setSingleLine(true);
        t.setPadding(Ui.dp(10), 0, Ui.dp(10), 0);
        t.setBackground(Ui.press(Ui.G100, Ui.LINE, 8));
        t.setContentDescription("Use the suggested message");
        t.setVisibility(View.GONE);
        t.setOnClickListener(v -> {
            if (comp.ghost == null) return;
            comp.edit.setText(comp.ghost);
            comp.edit.setSelection(comp.edit.getText().length());
            comp.edit.requestFocus();
        });
        return t;
    }

    /** The hub's suggestion for this chat ("" or null: none). */
    static void suggest(Composer comp, String s) {
        comp.ghost = s == null || s.isEmpty() ? null : s;
        refresh(comp);
    }

    /** Placeholder and chip follow the text: typing anything hides both. */
    static void refresh(Composer comp) {
        if (comp.use == null) return;
        boolean show = comp.ghost != null && comp.edit.getText().length() == 0;
        comp.edit.setHint(show ? comp.ghost : comp.hint);
        comp.edit.setHintTextColor(show ? Ui.G700 : Ui.G600);
        comp.use.setVisibility(show ? View.VISIBLE : View.GONE);
    }
}
