package dev.harbor.app;

import android.app.Activity;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashSet;
import java.util.Set;

/** An invitation to a workspace as a dialog over whatever screen is open, as the desktop's
 *  top-right card: "Sam invited you to Team", Accept, Decline or Later (the Hubs screen keeps
 *  it). While a screen of the app is open the phone listens to the service's pushes
 *  (GET /v1/events, a long poll): an invitation, or a change of who is in a workspace, shows
 *  the moment it's made. */
final class Invites {
    private Invites() { }

    /** Shown this run: Later doesn't bring it back until the app starts again. */
    private static final Set<String> asked = new HashSet<>();
    private static int gen;
    /** The last change the service told (its `seq`); -1: none yet. */
    private static volatile long since = -1;

    static void resumed(Activity a) {
        final int my = ++gen;
        Ui.pool.execute(() -> listen(a, my));
    }

    static void paused() {
        gen++;
    }

    private static boolean live(Activity a, int my) {
        return my == gen && !a.isFinishing();
    }

    /** Fetches once (what changed while no screen was open), then follows the pushes until the
     *  screen goes. Errors back off from 2 s to a minute; meanwhile the minute's fallback check. */
    private static void listen(Activity a, int my) {
        fetch(a, my, false);
        if (Rig.on()) return;
        long wait = 2_000;
        while (live(a, my)) {
            try {
                JSONObject r = Account.events(a, since);
                wait = 2_000;
                if (!r.has("seq")) continue; // nothing changed in ~20 s
                long seq = r.optLong("seq");
                String what = r.optString("what");
                boolean news = !"hello".equals(what) || (since >= 0 && seq != since);
                since = seq;
                if (news && live(a, my)) fetch(a, my, !"invites".equals(what));
            } catch (Exception e) {
                try { Thread.sleep(wait); } catch (InterruptedException x) { return; }
                wait = Math.min(wait * 2, 60_000);
                if (live(a, my)) fetch(a, my, false);
            }
        }
    }

    /** The invitations (and with `dir` the directory, its PCs), then the dialog or the screen. */
    private static void fetch(Activity a, int my, boolean dir) {
        String before = Account.invites(a).toString();
        try { Account.checkInvites(a, true); } catch (Exception ignored) { }
        if (dir) try { Account.directory(a, true); } catch (Exception ignored) { }
        boolean changed = dir || !before.equals(Account.invites(a).toString());
        Ui.main.post(() -> { if (live(a, my)) show(a, changed); });
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
