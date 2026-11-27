package dev.harbor.app;

import android.app.RemoteInput;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.widget.Toast;

import org.json.JSONObject;

/** A notification's actions (Notes), sent like the app would, over a session with the pairing's
 *  factors. Without a recent unlock a three-factor pairing can't sign: Android unlocks first on 12+
 *  (setAuthenticationRequired); older phones are told to open Hub.
 *  <ul><li>An agent that needs you: Reply (into the chat) and Continue (after a usage limit).</li>
 *  <li>A person wrote: Reply (to them, through the account Persons talks to them on:
 *  POST /v1/persons/chat/&lt;id&gt;/send), Mark as read (…/read), and the notification swiped away.</li></ul>
 *  Done: the notification goes. Failed: a toast says why and the notification comes back with the
 *  reason, so it can be tried again. */
public class NoteAction extends BroadcastReceiver {
    static final String REPLY = "dev.harbor.app.REPLY", CONTINUE = "dev.harbor.app.CONTINUE", TEXT = "text";
    static final String P_REPLY = "dev.harbor.app.P_REPLY", P_READ = "dev.harbor.app.P_READ", P_DISMISS = "dev.harbor.app.P_DISMISS";

    @Override
    public void onReceive(Context c, Intent i) {
        if (Ui.app == null) Ui.app = c.getApplicationContext();
        String what = i.getAction();
        if (P_REPLY.equals(what) || P_READ.equals(what) || P_DISMISS.equals(what)) { person(c, i, what); return; }
        String hubId = i.getStringExtra("hub"), chat = i.getStringExtra("chat"), tag = i.getStringExtra("tag");
        String pc = i.getStringExtra("pc"), note = i.getStringExtra("note");
        if (hubId == null || chat == null || tag == null) return;
        String text = null;
        if (REPLY.equals(what)) {
            text = typed(i);
            if (text == null) return;
        } else if (!CONTINUE.equals(what)) {
            return;
        }
        final String said = text;
        PendingResult done = goAsync();
        Ui.pool.execute(() -> {
            try {
                Hub h = Hub.get(c, hubId);
                if (h == null) throw new java.io.IOException("This PC isn't paired any more.");
                if (said != null) h.call("POST", "/v1/chats/" + chat + "/send", new JSONObject().put("text", said));
                else h.call("POST", "/v1/chats/" + chat + "/continue", new JSONObject());
                Notes.cancel(c, tag);
            } catch (Exception e) {
                Notes.failed(c, hubId, pc, note, (said != null ? "Not sent: " : "Not continued: ") + Hub.why(e));
            } finally {
                done.finish();
            }
        });
    }

    private static String typed(Intent i) {
        Bundle r = RemoteInput.getResultsFromIntent(i);
        CharSequence t = r == null ? null : r.getCharSequence(TEXT);
        return t == null || t.toString().trim().isEmpty() ? null : t.toString().trim();
    }

    private void person(Context c, Intent i, String what) {
        String hubId = i.getStringExtra("hub"), pid = i.getStringExtra("person");
        String section = i.getStringExtra("section"), account = i.getStringExtra("account");
        if (hubId == null || pid == null) return;
        if (P_DISMISS.equals(what)) { Notes.clearPerson(c, hubId, pid); return; }
        String text = P_REPLY.equals(what) ? typed(i) : null;
        if (P_REPLY.equals(what) && text == null) return;
        // Mark as read goes at once (the PC catches up); a reply waits for the PC's answer.
        if (P_READ.equals(what)) Notes.clearPerson(c, hubId, pid);
        PendingResult done = goAsync();
        Ui.pool.execute(() -> {
            try {
                Hub h = Hub.get(c, hubId);
                if (h == null) throw new java.io.IOException("This PC isn't paired any more.");
                JSONObject b = new JSONObject().put("section", section == null ? "" : section).put("account", account == null ? "" : account);
                String path = "/v1/persons/chat/" + android.net.Uri.encode(pid);
                if (text != null) {
                    JSONObject r = h.call("POST", path + "/send", b.put("text", text));
                    if (r != null && r.has("ok") && !r.optBoolean("ok")) throw new java.io.IOException(r.optString("error", "The PC couldn't send it."));
                    Notes.clearPerson(c, hubId, pid);
                } else {
                    h.call("POST", path + "/read", b);
                }
            } catch (Exception e) {
                String why = Hub.why(e);
                if (text != null) personFailed(c, hubId, pid, text, why);
                else Ui.main.post(() -> Toast.makeText(c.getApplicationContext(), "Not marked as read: " + why, Toast.LENGTH_LONG).show());
            } finally {
                done.finish();
            }
        });
    }

    /** A reply that didn't go: the toast, and the conversation again (its lines kept) with why. */
    private static void personFailed(Context c, String hubId, String pid, String text, String why) {
        Ui.main.post(() -> Toast.makeText(c.getApplicationContext(), "Not sent: " + why, Toast.LENGTH_LONG).show());
        Notes.repostPerson(c, hubId, pid, "Not sent: “" + text + "”: " + why);
    }
}
