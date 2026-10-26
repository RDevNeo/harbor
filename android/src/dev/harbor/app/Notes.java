package dev.harbor.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.RemoteInput;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Calendar;

/** The PCs' notifications on this phone (android/PROTOCOL.md, "Notifications"): what the hub
 *  noticed (an agent needs you, a lead chat finished, CI failed, a usage limit, a PC offline),
 *  taken with the background pings (Alive, Listen) even with the app closed. One Android
 *  notification per chat (or project, account, PC): a new note replaces it, so bursts never
 *  pile up. Open, Reply (straight into the chat) and Continue (a chat waiting after a usage
 *  limit). What to show is this phone's own choice (Settings › Notifications). */
final class Notes {
    private Notes() { }

    /** The kinds, their labels and their Android channels' importance. */
    static final String[] KINDS = { "input", "done", "agent", "ci", "limit", "pc" };
    static final String[] LABELS = { "An agent needs you", "A lead chat finished", "A sub-agent finished",
            "CI or PR checks failed", "Usage limit hit or back", "Another PC went offline" };
    private static final int[] IMPORTANCE = { NotificationManager.IMPORTANCE_HIGH, NotificationManager.IMPORTANCE_DEFAULT,
            NotificationManager.IMPORTANCE_LOW, NotificationManager.IMPORTANCE_DEFAULT, NotificationManager.IMPORTANCE_DEFAULT,
            NotificationManager.IMPORTANCE_LOW };

    static SharedPreferences prefs(Context c) { return c.getSharedPreferences("notify", Context.MODE_PRIVATE); }

    /** Sub-agents are off unless asked for; the rest on. */
    static boolean on(Context c, String kind) {
        if ("test".equals(kind)) return true;
        return prefs(c).getBoolean("k." + kind, !"agent".equals(kind));
    }

    static void set(Context c, String kind, boolean v) { prefs(c).edit().putBoolean("k." + kind, v).apply(); }

    static boolean awayOnly(Context c) { return prefs(c).getBoolean("away", false); }
    static boolean instant(Context c) { return prefs(c).getBoolean("instant", false); }
    /** Quiet hours as minutes since midnight, or -1 when off. */
    static int quietFrom(Context c) { return prefs(c).getInt("qfrom", -1); }
    static int quietTo(Context c) { return prefs(c).getInt("qto", -1); }

    static boolean quietNow(Context c) {
        int a = quietFrom(c), b = quietTo(c);
        if (a < 0 || b < 0 || a == b) return false;
        Calendar k = Calendar.getInstance();
        int m = k.get(Calendar.HOUR_OF_DAY) * 60 + k.get(Calendar.MINUTE);
        return a < b ? m >= a && m < b : m >= a || m < b;
    }

    static String hm(int m) { return String.format(java.util.Locale.ROOT, "%02d:%02d", m / 60, m % 60); }

    /** The last note id taken from PC v of pairing h (ids are per PC). 0: none yet. */
    static long since(Context c, Hub h, String v) { return prefs(c).getLong("s." + h.id + "/" + v, 0); }

    /** May notifications be posted (Android 13 asks)? */
    static boolean allowed(Context c) {
        return Build.VERSION.SDK_INT < 33 || c.checkSelfPermission("android.permission.POST_NOTIFICATIONS") == PackageManager.PERMISSION_GRANTED;
    }

    /** PC v's answer to a ping: its notes since the last ones taken. Shown unless Harbor is
     *  in front (the screen shows it then), off in the settings, quiet hours, or (away only)
     *  the user was at that PC. */
    static void take(Context c, Hub h, String v, JSONObject r) {
        if (r == null || !r.has("last")) return;
        prefs(c).edit().putLong("s." + h.id + "/" + v, r.optLong("last")).apply();
        JSONArray a = r.optJSONArray("notes");
        if (a == null || a.length() == 0 || Base.resumed > 0 || !allowed(c)) return;
        boolean quiet = quietNow(c), away = awayOnly(c);
        for (int i = 0; i < a.length(); i++) {
            JSONObject n = a.optJSONObject(i);
            if (n == null) continue;
            String kind = n.optString("kind");
            if (!on(c, kind) || (quiet && !"test".equals(kind)) || (away && !n.optBoolean("away") && !"test".equals(kind))) continue;
            try { show(c, h, n); } catch (Exception ignored) { }
        }
    }

    private static void channels(NotificationManager nm) {
        for (int i = 0; i < KINDS.length; i++) {
            NotificationChannel ch = new NotificationChannel("n." + KINDS[i], LABELS[i], IMPORTANCE[i]);
            nm.createNotificationChannel(ch);
        }
        nm.createNotificationChannel(new NotificationChannel("n.test", "Tests from your PC", NotificationManager.IMPORTANCE_DEFAULT));
    }

    /** The notification's tag: one per pairing and key (chat, project, account, PC). */
    static String tag(Hub h, String key) { return h.id + "|" + key; }

    static void show(Context c, Hub h, JSONObject n) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm == null) return;
        channels(nm);
        String kind = n.optString("kind"), key = n.optString("key"), chat = n.optString("chat"), url = n.optString("url");
        String tag = tag(h, key);
        int code = tag.hashCode();
        int count = n.optInt("count", 1);
        String title = n.optString("title") + (count > 1 ? " (" + count + ")" : "");
        String from = n.optString("from");
        Intent open;
        if (!chat.isEmpty()) open = new Intent(c, Chat.class).putExtra("hub", h.id).putExtra("chat", chat);
        else if (!url.isEmpty()) open = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        else open = new Intent(c, Hubs.class);
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(c, code, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder b = new Notification.Builder(c, "n." + ("test".equals(kind) ? "test" : kind))
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle(title).setContentText(n.optString("body"))
                .setStyle(new Notification.BigTextStyle().bigText(n.optString("body")))
                .setSubText(from.isEmpty() ? h.label() : from)
                .setWhen(n.optLong("at") * 1000).setShowWhen(true)
                .setGroup("harbor:" + h.id)
                .setContentIntent(pi).setAutoCancel(true)
                // A coalesced update (count > 1) changes the text without ringing again.
                .setOnlyAlertOnce(count > 1);
        if (!chat.isEmpty() && n.optBoolean("reply")) b.addAction(replyAction(c, h, chat, tag, code));
        if ("continue".equals(n.optString("act")) && !chat.isEmpty())
            b.addAction(new Notification.Action.Builder(null, "Continue", act(c, h, chat, tag, NoteAction.CONTINUE, code + 2, false)).build());
        nm.notify(tag, 1, b.build());
    }

    /** Reply: typed in the notification, sent into the chat. With three factors Android
     *  unlocks the phone first (the presence key signs only after an unlock). */
    private static Notification.Action replyAction(Context c, Hub h, String chat, String tag, int code) {
        RemoteInput ri = new RemoteInput.Builder(NoteAction.TEXT).setLabel("Reply to the chat").build();
        Notification.Action.Builder a = new Notification.Action.Builder(null, "Reply", act(c, h, chat, tag, NoteAction.REPLY, code + 1, true)).addRemoteInput(ri);
        if (Build.VERSION.SDK_INT >= 31) a.setAuthenticationRequired(h.factors() == 3);
        return a.build();
    }

    private static PendingIntent act(Context c, Hub h, String chat, String tag, String what, int code, boolean mutable) {
        Intent i = new Intent(c, NoteAction.class).setAction(what).putExtra("hub", h.id).putExtra("chat", chat).putExtra("tag", tag);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | (mutable && Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : mutable ? 0 : PendingIntent.FLAG_IMMUTABLE);
        return PendingIntent.getBroadcast(c, code, i, flags);
    }

    /** After Reply or Continue: the notification says how it went (and opens the chat). */
    static void after(Context c, String hubId, String chat, String tag, String title, String text) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm == null) return;
        channels(nm);
        Intent open = new Intent(c, Chat.class).putExtra("hub", hubId).putExtra("chat", chat).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(c, tag.hashCode(), open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        nm.notify(tag, 1, new Notification.Builder(c, "n.done").setSmallIcon(R.drawable.ic_stat)
                .setContentTitle(title).setContentText(text).setContentIntent(pi).setAutoCancel(true).setOnlyAlertOnce(true).build());
    }

    static void cancel(Context c, String tag) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm != null) nm.cancel(tag, 1);
    }
}
