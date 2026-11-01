package dev.harbor.app;

import android.content.Context;
import android.view.Gravity;
import android.view.View;
import android.widget.TextView;

/** The hub's prompt suggestion (recap.rs, PROTOCOL.md "status"), drawn like the desktop: the empty
 *  composer's grayer placeholder, which the "⇥ Use" chip puts into the text (the desktop's Tab).
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

    /** A tap on the grayed suggestion itself takes it, like the chip (anywhere else in the empty
     *  box only focuses it, for typing something else). */
    static void tapToUse(Composer comp) {
        comp.edit.setOnTouchListener((v, e) -> {
            if (e.getAction() != android.view.MotionEvent.ACTION_UP || comp.ghost == null || comp.edit.getText().length() > 0) return false;
            android.text.Layout l = comp.edit.getLayout();
            float hintW = comp.edit.getPaint().measureText(comp.ghost);
            float x = e.getX() - comp.edit.getTotalPaddingLeft();
            float y = e.getY() - comp.edit.getTotalPaddingTop();
            int lines = l == null ? 1 : Math.max(1, l.getLineCount());
            if (x >= 0 && x <= Math.min(hintW, comp.edit.getWidth()) && y >= 0 && y <= comp.edit.getLineHeight() * lines) {
                comp.use.performClick();
            }
            return false;
        });
    }

    /** The hub's suggestion for this chat ("" or null: none). */
    static void set(Composer comp, String s) {
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
        // The text keeps clear of the chip in the corner.
        int right = show ? Ui.dp(10) + Math.max(comp.use.getWidth(), Ui.dp(64)) : Ui.dp(10);
        if (comp.edit.getPaddingRight() != right) comp.edit.setPadding(comp.edit.getPaddingLeft(), comp.edit.getPaddingTop(), right, comp.edit.getPaddingBottom());
    }
}
