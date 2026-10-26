package dev.harbor.app;

import android.app.RemoteInput;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;

import org.json.JSONObject;

/** A notification's Reply or Continue (Notes): sent to the chat like the app would, over a
 *  session with the pairing's factors. Without a recent unlock a three-factor pairing can't
 *  sign: Android unlocks first on 12+ (setAuthenticationRequired); older phones are told to
 *  open Harbor. */
public class NoteAction extends BroadcastReceiver {
    static final String REPLY = "dev.harbor.app.REPLY", CONTINUE = "dev.harbor.app.CONTINUE", TEXT = "text";

    @Override
    public void onReceive(Context c, Intent i) {
        if (Ui.app == null) Ui.app = c.getApplicationContext();
        String hubId = i.getStringExtra("hub"), chat = i.getStringExtra("chat"), tag = i.getStringExtra("tag");
        if (hubId == null || chat == null || tag == null) return;
        String text = null;
        if (REPLY.equals(i.getAction())) {
            Bundle r = RemoteInput.getResultsFromIntent(i);
            CharSequence t = r == null ? null : r.getCharSequence(TEXT);
            if (t == null || t.toString().trim().isEmpty()) return;
            text = t.toString().trim();
        } else if (!CONTINUE.equals(i.getAction())) {
            return;
        }
        final String said = text;
        PendingResult done = goAsync();
        Ui.pool.execute(() -> {
            try {
                Hub h = Hub.get(c, hubId);
                if (h == null) throw new java.io.IOException("This PC isn't paired any more.");
                if (said != null) {
                    h.call("POST", "/v1/chats/" + chat + "/send", new JSONObject().put("text", said));
                    Notes.after(c, hubId, chat, tag, "Sent", said);
                } else {
                    h.call("POST", "/v1/chats/" + chat + "/continue", new JSONObject());
                    Notes.after(c, hubId, chat, tag, "Continuing", "The chat continues on " + h.label() + ".");
                }
            } catch (Exception e) {
                String why = Hub.why(e);
                Notes.after(c, hubId, chat, tag, said != null ? "Not sent" : "Not continued",
                        (said != null ? "“" + said + "”: " : "") + why + " Tap to open the chat.");
            } finally {
                done.finish();
            }
        });
    }
}
