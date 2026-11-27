package dev.harbor.app;

import android.content.Context;
import android.view.Gravity;
import android.view.View;
import android.view.animation.DecelerateInterpolator;
import android.widget.FrameLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.HashMap;
import java.util.Map;

/** WhatsApp's way of moving through a chat, shared by Persons' and Projects' chats on the phone: the round "↓" over
 *  the transcript's lower right corner with the count of messages that came in while scrolled up, the short entry of
 *  a new message (fade and slide, ~180 ms), the floating day pill on top while scrolling, and where each chat was
 *  left (for this run of the app: back to the same message and offset, or the end). */
final class ChatFlow {
    private ChatFlow() { }

    /** How long a new message's entry takes. */
    static final long ENTER_MS = 180;

    /** A new message coming in: from 12 dp lower and transparent to its place. */
    static void enter(View v) {
        v.setAlpha(0f);
        v.setTranslationY(Ui.dp(12));
        v.animate().alpha(1f).translationY(0f).setDuration(ENTER_MS).setInterpolator(new DecelerateInterpolator()).start();
    }

    /** Runs `r` right before the next frame is drawn (a scroll it makes is in that frame), not after it as post()
     *  does: a correction after a layout change (a picture, a note, the keyboard) never shows a frame at the old
     *  place first, which flickered while a chat opened. */
    static void beforeDraw(View v, Runnable r) {
        android.view.ViewTreeObserver o = v.getViewTreeObserver();
        o.addOnPreDrawListener(new android.view.ViewTreeObserver.OnPreDrawListener() {
            @Override public boolean onPreDraw() {
                android.view.ViewTreeObserver now = v.getViewTreeObserver();
                if (now.isAlive()) now.removeOnPreDrawListener(this);
                if (o.isAlive() && o != now) o.removeOnPreDrawListener(this);
                r.run();
                return true;
            }
        });
        v.invalidate();
    }

    /** Whether the transcript shows its end (within `slack` px). */
    static boolean atEnd(ScrollView sv, View content, int slack) {
        return content.getHeight() == 0 || sv.getScrollY() + sv.getHeight() >= content.getHeight() - slack;
    }

    /** How far above its end the transcript is scrolled, in px. */
    static int fromEnd(ScrollView sv, View content) {
        return Math.max(0, content.getHeight() - sv.getScrollY() - sv.getHeight());
    }

    /** The "↓" button: 44 dp round, a count badge on its top-left while messages came in unseen. */
    static final class Jump {
        final FrameLayout view;
        private final TextView badge;
        private boolean shown;
        private int count;

        Jump(Context c, View.OnClickListener on) {
            view = new FrameLayout(c);
            view.setClipChildren(false);
            FrameLayout btn = Ui.roundButton(c, Ui.I_DOWN, Ui.CARD, Ui.FG, 44, on);
            btn.setBackground(Ui.press(Ui.CARD, Ui.LINE, 22));
            btn.setElevation(Ui.dp(3));
            btn.setContentDescription("Scroll to the latest message");
            view.addView(btn, new FrameLayout.LayoutParams(Ui.dp(44), Ui.dp(44), Gravity.BOTTOM | Gravity.END));
            badge = Ui.bold(c, "", 11.5f, 0xffffffff);
            badge.setGravity(Gravity.CENTER);
            badge.setMinWidth(Ui.dp(20));
            badge.setPadding(Ui.dp(5), 0, Ui.dp(5), 0);
            badge.setBackground(Ui.round(0xff25a35a, 0, 10));
            badge.setElevation(Ui.dp(4));
            badge.setVisibility(View.GONE);
            view.addView(badge, new FrameLayout.LayoutParams(-2, Ui.dp(20), Gravity.TOP | Gravity.START));
            view.setVisibility(View.GONE);
        }

        /** Where it sits in a FrameLayout over the transcript: bottom right, 12 dp in. */
        FrameLayout.LayoutParams params() {
            FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(Ui.dp(54), Ui.dp(54), Gravity.BOTTOM | Gravity.END);
            lp.setMargins(0, 0, Ui.dp(10), Ui.dp(10));
            return lp;
        }

        int count() { return count; }

        void count(int n) {
            count = Math.max(0, n);
            badge.setText(count > 99 ? "99+" : String.valueOf(count));
            badge.setVisibility(count > 0 ? View.VISIBLE : View.GONE);
            view.setContentDescription(count > 0 ? count + " new: scroll to them" : "Scroll to the latest message");
        }

        /** Fades and scales in or out (150 ms). */
        void show(boolean on) {
            if (on == shown) return;
            shown = on;
            view.animate().cancel();
            if (on) {
                view.setVisibility(View.VISIBLE);
                view.setAlpha(0f);
                view.setScaleX(0.8f);
                view.setScaleY(0.8f);
                view.animate().alpha(1f).scaleX(1f).scaleY(1f).setDuration(150).start();
            } else {
                view.animate().alpha(0f).scaleX(0.8f).scaleY(0.8f).setDuration(150).withEndAction(() -> { if (!shown) view.setVisibility(View.GONE); }).start();
            }
        }
    }

    /** The day of what's at the top of the transcript, as a pill floating there while it scrolls (WhatsApp's). */
    static final class DayPill {
        final TextView view;
        private final Runnable hide;
        private String label = "";

        DayPill(Context c) {
            view = Ui.subtitle(Ui.bold(c, "", 12, Ui.G700));
            view.setPadding(Ui.dp(10), Ui.dp(3), Ui.dp(10), Ui.dp(3));
            view.setBackground(Ui.round(Ui.G100, Ui.LINE, 10));
            view.setElevation(Ui.dp(2));
            view.setVisibility(View.GONE);
            hide = () -> view.animate().alpha(0f).setDuration(200).withEndAction(() -> view.setVisibility(View.GONE)).start();
        }

        FrameLayout.LayoutParams params() {
            FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(-2, -2, Gravity.TOP | Gravity.CENTER_HORIZONTAL);
            lp.setMargins(0, Ui.dp(8), 0, 0);
            return lp;
        }

        /** Shows `day` ("" hides it) for a moment; scrolling keeps it up. */
        void show(String day) {
            Ui.main.removeCallbacks(hide);
            if (day == null || day.isEmpty()) {
                if (view.getVisibility() == View.VISIBLE) hide.run();
                return;
            }
            if (!day.equals(label)) { label = day; view.setText(day); }
            if (view.getVisibility() != View.VISIBLE || view.getAlpha() < 1f) {
                view.animate().cancel();
                view.setVisibility(View.VISIBLE);
                view.animate().alpha(1f).setDuration(120).start();
            }
            Ui.main.postDelayed(hide, Rig.on() ? 6000 : 1400);
        }
    }

    /** Where a chat was left: at its end, or `anchor` (a message's id or seq, the lowest one on screen) whose bottom was
     *  `off` px above the transcript's bottom edge (negative: cut off by it), and the
     *  newest message it had then (Projects: its last seq, for "N new messages" on the way back). */
    static final class Pos {
        final boolean end;
        final String anchor;
        final int off;
        final int last;

        Pos(boolean end, String anchor, int off, int last) {
            this.end = end; this.anchor = anchor; this.off = off; this.last = last;
        }
    }

    private static final Map<String, Pos> places = new HashMap<>();

    static Pos place(String key) { return places.get(key); }

    static void place(String key, Pos p) {
        if (p == null) places.remove(key);
        else places.put(key, p);
    }
}
