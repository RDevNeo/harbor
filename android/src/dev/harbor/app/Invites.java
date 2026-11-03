package dev.harbor.app;

import android.app.Activity;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashSet;
import java.util.Set;

/** An invitation to a workspace as a dialog over whatever screen is open, as the desktop's
 *  top-right card: "Sam invited you to Team", Accept, Decline or Later (the Hubs screen keeps
 *  it). Asked for every 15 s while a screen of the app is in front. */
final class Invites {
    private Invites() { }

    /** Shown this run: Later doesn't bring it back until the app starts again. */
    private static final Set<String> asked = new HashSet<>();
    private static int gen;

    static void resumed(Activity a) {
        tick(a, ++gen);
    }

    static void paused() {
        gen++;
    }

    private static void tick(Activity a, int my) {
        Ui.pool.execute(() -> {
            String before = Account.invites(a).toString();
            try { Account.checkInvites(a); } catch (Exception ignored) { }
            boolean changed = !before.equals(Account.invites(a).toString());
            Ui.main.post(() -> {
                if (my != gen || a.isFinishing()) return;
                show(a, changed);
                Ui.main.postDelayed(() -> { if (my == gen && !a.isFinishing()) tick(a, my); }, 15_000);
            });
        });
    }

    /** The title the desktop's card has (invitecard.ts `inviteCard`). */
    static String title(String by, String ws) {
        String w = ws.isEmpty() ? "a workspace" : ws;
        return by.isEmpty() ? "You're invited to " + w : by + " invited you to " + w;
    }

    private static void show(Activity a, boolean changed) {
        // The Hubs screen lists them as cards of its own.
        if (a instanceof Hubs) { if (changed) ((Hubs) a).refresh(); return; }
        JSONArray inv = Account.invites(a);
        for (int i = 0; i < inv.length(); i++) {
            JSONObject x = inv.optJSONObject(i);
            if (x == null) continue;
            String id = x.optString("id");
            if (id.isEmpty() || !asked.add(id)) continue;
            Ui.dialog(a).setTitle(title(x.optString("inviter_name"), x.optString("ws_name")))
                    .setMessage("Accept to use its PCs and see its chats on all your devices.")
                    .setNegativeButton("Later", null)
                    .setNeutralButton("Decline", (d, w) -> answer(a, id, false))
                    .setPositiveButton("Accept", (d, w) -> answer(a, id, true))
                    .show();
            return;
        }
    }

    private static void answer(Activity a, String id, boolean accept) {
        Ui.pool.execute(() -> {
            String e = null, joined = null;
            try { joined = Account.answer(a, id, accept); } catch (Exception x) { e = Hub.why(x); }
            final String fe = e, fj = joined;
            Ui.main.post(() -> {
                if (a.isFinishing()) return;
                if (fe != null) Ui.toast(a, fe);
                else if (fj != null) Ui.toast(a, "You joined " + fj);
                if (a instanceof Base) ((Base) a).refresh();
            });
        });
    }
}
