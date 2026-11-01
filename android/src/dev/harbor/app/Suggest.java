package dev.harbor.app;

import android.content.Context;
import android.view.Gravity;
import android.view.View;
import android.widget.TextView;

/** The hub's prompt suggestion (recap.rs, PROTOCOL.md "status"): only the "⇥ Use" chip in the empty
 *  composer, which puts it into the text (the desktop's Tab). The suggestion itself isn't shown as a
 *  grayed placeholder (the owner's call: the gray text was noise); the box keeps its usual hint.
 *  The session recap beside it in the same reply is the desktop's alone. */
final class Suggest {
    private Suggest() { }

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
    static void set(Composer comp, String s) {
        comp.ghost = s == null || s.isEmpty() ? null : s;
        refresh(comp);
    }

    /** The chip follows the text: typing anything hides it. */
    static void refresh(Composer comp) {
        if (comp.use == null) return;
        boolean show = comp.ghost != null && comp.edit.getText().length() == 0;
        comp.use.setVisibility(show ? View.VISIBLE : View.GONE);
        // The text keeps clear of the chip in the corner.
        int right = show ? Ui.dp(10) + Math.max(comp.use.getWidth(), Ui.dp(64)) : Ui.dp(10);
        if (comp.edit.getPaddingRight() != right) comp.edit.setPadding(comp.edit.getPaddingLeft(), comp.edit.getPaddingTop(), right, comp.edit.getPaddingBottom());
    }
}
