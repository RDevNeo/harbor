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
import android.content.pm.ShortcutInfo;
import android.content.pm.ShortcutManager;
import android.graphics.Bitmap;
import android.graphics.BitmapShader;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Rect;
import android.graphics.Shader;
import android.graphics.Typeface;
import android.graphics.drawable.Icon;
import android.net.Uri;
import android.os.Build;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Calendar;
import java.util.HashMap;
import java.util.Map;

/** The PCs' notifications on this phone (android/PROTOCOL.md, "Notifications"), taken with the
 *  background pings (Alive, Listen) even with the app closed. Only four kinds ring here: an agent
 *  needs you (Open, Reply, Continue), a usage limit was hit, a PC went offline, and a person of the
 *  Persons tab wrote (a WhatsApp-like conversation: their picture, their unread lines stacked,
 *  Reply and Mark as read). Every other note a PC keeps (a chat finished, CI, a limit reset, a PC
 *  back, `"phone": false`…) is skipped. One Android notification per chat, account, PC or person:
 *  a new note replaces it. What to show is this phone's own choice (Settings › Notifications). */
final class Notes {
    private Notes() { }

    /** The kinds this phone posts, their labels (Settings) and their Android channels. */
    static final String[] KINDS = { "input", "limit", "pc", "person" };
    static final String[] LABELS = { "An agent needs you", "Usage limit hit", "My PC went offline", "Messages from people" };
    private static final String[] CHANNELS = { "n.input", "n.limit", "n.pcoff", "n.person" };
    private static final int[] IMPORTANCE = { NotificationManager.IMPORTANCE_HIGH, NotificationManager.IMPORTANCE_DEFAULT,
            NotificationManager.IMPORTANCE_DEFAULT, NotificationManager.IMPORTANCE_HIGH };
    /** Channels of earlier versions, deleted so they leave Android's settings: kinds that no longer
     *  ring (a chat finished, a sub-agent, CI, Discord, WhatsApp, Collector, tests, Reply's status),
     *  files received, app updates, the old PC channel (low importance) and the old Listen one. */
    private static final String[] DEAD = { "n.done", "n.agent", "n.ci", "n.discord", "n.whatsapp", "n.collector", "n.test",
            "n.pc", "received", "update", "listen" };
    private static volatile boolean setUp;

    static SharedPreferences prefs(Context c) { return c.getSharedPreferences("notify", Context.MODE_PRIVATE); }

    static boolean kind(String k) {
        for (String x : KINDS) if (x.equals(k)) return true;
        return false;
    }

    static boolean on(Context c, String kind) { return kind(kind) && prefs(c).getBoolean("k." + kind, true); }

    static void set(Context c, String kind, boolean v) { prefs(c).edit().putBoolean("k." + kind, v).apply(); }

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

    /** Once per process: this version's channels made, earlier versions' dead ones deleted. */
    static void setUp(Context c) {
        if (setUp) return;
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm == null) return;
        try {
            channels(nm);
            for (String id : DEAD) nm.deleteNotificationChannel(id);
            setUp = true;
        } catch (RuntimeException ignored) { }
    }

    /** PC v's answer to a ping: its notes since the last ones taken. Shown unless Hub is in front
     *  (the screen shows it then), not one of this phone's kinds, marked `"phone": false`, off in
     *  the settings, or quiet hours. */
    static void take(Context c, Hub h, String v, JSONObject r) {
        if (r == null || !r.has("last")) return;
        prefs(c).edit().putLong("s." + h.id + "/" + v, r.optLong("last")).apply();
        JSONArray a = r.optJSONArray("notes");
        if (a == null || a.length() == 0 || Base.resumed > 0 || !allowed(c)) return;
        boolean quiet = quietNow(c);
        for (int i = 0; i < a.length(); i++) {
            JSONObject n = a.optJSONObject(i);
            if (n == null) continue;
            if (!n.optBoolean("phone", true) || !on(c, n.optString("kind")) || quiet) continue;
            try { show(c, h, v, n); } catch (Exception ignored) { }
        }
    }

    private static void channels(NotificationManager nm) {
        for (int i = 0; i < KINDS.length; i++) {
            NotificationChannel ch = new NotificationChannel(CHANNELS[i], LABELS[i], IMPORTANCE[i]);
            nm.createNotificationChannel(ch);
        }
    }

    private static String channel(String kind) {
        for (int i = 0; i < KINDS.length; i++) if (KINDS[i].equals(kind)) return CHANNELS[i];
        return CHANNELS[0];
    }

    /** The notification's tag: one per pairing and key (chat, account, PC; a person: "person:<id>"). */
    static String tag(Hub h, String key) { return h.id + "|" + key; }

    /** v: the PC the note was taken from. */
    static void show(Context c, Hub h, String v, JSONObject n) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm == null) return;
        setUp(c);
        channels(nm);
        String kind = n.optString("kind");
        if ("person".equals(kind)) { person(c, nm, h, n); return; }
        String key = n.optString("key"), chat = n.optString("chat"), url = n.optString("url");
        String tag = tag(h, key);
        int code = tag.hashCode();
        int count = n.optInt("count", 1);
        String title = n.optString("title") + (count > 1 ? " (" + count + ")" : "");
        String from = n.optString("from");
        String body = n.optString("body");
        String err = n.optString("error");
        if (!err.isEmpty()) body = err + (body.isEmpty() ? "" : "\n" + body);
        Intent open;
        if (!chat.isEmpty()) open = new Intent(c, Chat.class).putExtra("hub", h.id).putExtra("chat", chat);
        else if (!url.isEmpty()) open = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        else open = new Intent(c, Hubs.class);
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(c, code, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder b = new Notification.Builder(c, channel(kind))
                .setSmallIcon(Ui.statIcon(c))
                .setContentTitle(title).setContentText(body)
                .setStyle(new Notification.BigTextStyle().bigText(body))
                .setSubText(from.isEmpty() ? h.label() : from)
                .setWhen(n.optLong("at") * 1000).setShowWhen(true)
                .setGroup("harbor:" + h.id)
                .setContentIntent(pi).setAutoCancel(true)
                // A coalesced update (count > 1) or a failed Reply changes the text without ringing again.
                .setOnlyAlertOnce(count > 1 || !err.isEmpty());
        if (!chat.isEmpty() && n.optBoolean("reply")) b.addAction(replyAction(c, h, v, n, chat, tag, code));
        if ("continue".equals(n.optString("act")) && !chat.isEmpty())
            b.addAction(new Notification.Action.Builder(null, "Continue", act(c, h, v, n, chat, tag, NoteAction.CONTINUE, code + 2, false)).build());
        nm.notify(tag, 1, b.build());
    }

    /** The PC a note happened on: `from` (another PC of the mesh, by name) when one of h's has
     *  that name, else v, the PC it was taken from. */
    static String pcOf(Hub h, String v, String from) {
        if (from == null || from.isEmpty()) return v;
        for (String x : h.endpoints()) if (from.equals(h.labelOn(x))) return x;
        return v;
    }

    /** Reply: typed in the notification, sent into the chat. Android unlocks the phone first
     *  (12+): a locked phone's notification can't drive the PCs. */
    private static Notification.Action replyAction(Context c, Hub h, String v, JSONObject n, String chat, String tag, int code) {
        RemoteInput ri = new RemoteInput.Builder(NoteAction.TEXT).setLabel("Reply to the chat").build();
        Notification.Action.Builder a = new Notification.Action.Builder(null, "Reply", act(c, h, v, n, chat, tag, NoteAction.REPLY, code + 1, true)).addRemoteInput(ri);
        if (Build.VERSION.SDK_INT >= 28) a.setSemanticAction(Notification.Action.SEMANTIC_ACTION_REPLY);
        if (Build.VERSION.SDK_INT >= 31) a.setAuthenticationRequired(true);
        return a.build();
    }

    /** A notification action's broadcast to NoteAction; the note goes along, so a failure can show it again with why. */
    private static PendingIntent act(Context c, Hub h, String v, JSONObject n, String chat, String tag, String what, int code, boolean mutable) {
        Intent i = new Intent(c, NoteAction.class).setAction(what).putExtra("hub", h.id).putExtra("pc", v)
                .putExtra("chat", chat).putExtra("tag", tag).putExtra("note", n.toString());
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | (mutable && Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : mutable ? 0 : PendingIntent.FLAG_IMMUTABLE);
        return PendingIntent.getBroadcast(c, code, i, flags);
    }

    /** Reply or Continue failed: the toast says why, and the notification comes back (quietly)
     *  with the reason on top, so its actions can be tried again. */
    static void failed(Context c, String hubId, String v, String note, String why) {
        Ui.main.post(() -> Toast.makeText(c.getApplicationContext(), why, Toast.LENGTH_LONG).show());
        try {
            Hub h = Hub.get(c, hubId);
            if (h == null || note == null) return;
            JSONObject n = new JSONObject(note).put("error", why);
            show(c, h, v == null ? "" : v, n);
        } catch (Exception ignored) { }
    }

    static void cancel(Context c, String tag) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm != null) nm.cancel(tag, 1);
    }

    // ---- a person wrote: one conversation per person, like WhatsApp's ----

    /** The unread lines a person's notification stacks, per tag: [{id, text, at}], the newest last. */
    private static final int KEEP_LINES = 12;
    private static final Map<String, Bitmap> faces = new HashMap<>();

    static String personTag(String hubId, String personId) { return hubId + "|person:" + personId; }

    private static JSONArray lines(Context c, String tag) {
        try { return new JSONArray(prefs(c).getString("pl." + tag, "[]")); } catch (Exception e) { return new JSONArray(); }
    }

    /** The person's notification is gone (read, replied, opened, swiped away): its lines too. */
    static void clearPerson(Context c, String hubId, String personId) {
        String tag = personTag(hubId, personId);
        prefs(c).edit().remove("pl." + tag).remove("pp." + tag).apply();
        cancel(c, tag);
    }

    /** A Reply to them failed: their conversation again, its lines kept, with why on top. */
    static void repostPerson(Context c, String hubId, String personId, String why) {
        try {
            Hub h = Hub.get(c, hubId);
            NotificationManager nm = c.getSystemService(NotificationManager.class);
            String saved = prefs(c).getString("pp." + personTag(hubId, personId), null);
            if (h == null || nm == null || saved == null) return;
            JSONObject p = new JSONObject(saved).put("lines", new JSONArray());
            person(c, nm, h, new JSONObject().put("kind", "person").put("person", p).put("error", why));
        } catch (Exception ignored) { }
    }

    private static void person(Context c, NotificationManager nm, Hub h, JSONObject n) {
        JSONObject p = n.optJSONObject("person");
        if (p == null || p.optString("id").isEmpty()) return;
        String pid = p.optString("id"), name = p.optString("name", n.optString("title")), section = p.optString("section"), account = p.optString("account");
        String tag = personTag(h.id, pid);
        int code = tag.hashCode();
        // This person's unread lines so far, with the new ones (a line two PCs both sent counts once).
        JSONArray have = lines(c, tag);
        java.util.Set<String> ids = new java.util.HashSet<>();
        for (int i = 0; i < have.length(); i++) ids.add(have.optJSONObject(i) == null ? "" : have.optJSONObject(i).optString("id"));
        JSONArray add = p.optJSONArray("lines");
        boolean fresh = false;
        String err = n.optString("error");
        if ((add == null || add.length() == 0) && err.isEmpty()) add = new JSONArray().put(new JSONObject(map("id", n.optString("key"), "text", n.optString("body"), "at", n.optLong("at"))));
        for (int i = 0; add != null && i < add.length(); i++) {
            JSONObject l = add.optJSONObject(i);
            if (l == null || ids.contains(l.optString("id"))) continue;
            have.put(l);
            ids.add(l.optString("id"));
            fresh = true;
        }
        if (!fresh && err.isEmpty()) return;
        JSONArray kept = new JSONArray();
        for (int i = Math.max(0, have.length() - KEEP_LINES); i < have.length(); i++) kept.put(have.opt(i));
        JSONObject who = new JSONObject();
        try {
            for (String k : new String[] { "id", "name", "section", "account", "channel", "pic", "color" }) who.put(k, p.optString(k));
        } catch (org.json.JSONException ignored) { }
        prefs(c).edit().putString("pl." + tag, kept.toString()).putString("pp." + tag, who.toString()).apply();

        Bitmap face = face(h, p.optString("pic"), name, p.optString("color"));
        Icon icon = Icon.createWithBitmap(face);
        Intent open = new Intent(c, Persons.class).setAction(Intent.ACTION_VIEW).putExtra("hub", h.id).putExtra("person", pid).putExtra("section", section)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(c, code, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        String channelName = channelLabel(p.optString("channel"));
        JSONObject last = kept.optJSONObject(kept.length() - 1);
        Notification.Builder b = new Notification.Builder(c, "n.person")
                .setSmallIcon(Ui.statIcon(c))
                .setContentTitle(name).setContentText(last == null ? n.optString("body") : last.optString("text"))
                .setSubText(err.isEmpty() ? channelName : err)
                .setCategory(Notification.CATEGORY_MESSAGE)
                .setWhen((last == null ? n.optLong("at") : last.optLong("at")) * 1000).setShowWhen(true)
                .setNumber(kept.length())
                .setContentIntent(pi).setAutoCancel(true)
                .setDeleteIntent(personAct(c, h, pid, section, account, tag, NoteAction.P_DISMISS, code + 3, false))
                .setOnlyAlertOnce(!fresh);
        if (kept.length() == 0) {
            b.setContentText(err).setStyle(new Notification.BigTextStyle().bigText(err));
        } else if (Build.VERSION.SDK_INT >= 28) {
            android.app.Person me = new android.app.Person.Builder().setName("You").setKey("me").build();
            android.app.Person them = new android.app.Person.Builder().setName(name).setIcon(icon).setKey(h.id + ":" + pid).build();
            Notification.MessagingStyle st = new Notification.MessagingStyle(me);
            for (int i = 0; i < kept.length(); i++) {
                JSONObject l = kept.optJSONObject(i);
                if (l != null) st.addMessage(new Notification.MessagingStyle.Message(l.optString("text"), l.optLong("at") * 1000, them));
            }
            b.setStyle(st);
            String sid = shortcut(c, h, pid, name, icon, them, open);
            if (sid != null) b.setShortcutId(sid);
        } else {
            Notification.InboxStyle st = new Notification.InboxStyle();
            for (int i = 0; i < kept.length(); i++) {
                JSONObject l = kept.optJSONObject(i);
                if (l != null) st.addLine(l.optString("text"));
            }
            b.setStyle(st).setLargeIcon(face);
        }
        RemoteInput ri = new RemoteInput.Builder(NoteAction.TEXT).setLabel("Message " + name).build();
        Notification.Action.Builder reply = new Notification.Action.Builder(null, "Reply",
                personAct(c, h, pid, section, account, tag, NoteAction.P_REPLY, code + 1, true)).addRemoteInput(ri);
        Notification.Action.Builder read = new Notification.Action.Builder(null, "Mark as read",
                personAct(c, h, pid, section, account, tag, NoteAction.P_READ, code + 2, false));
        if (Build.VERSION.SDK_INT >= 28) {
            reply.setSemanticAction(Notification.Action.SEMANTIC_ACTION_REPLY);
            read.setSemanticAction(Notification.Action.SEMANTIC_ACTION_MARK_AS_READ);
        }
        if (Build.VERSION.SDK_INT >= 31) reply.setAuthenticationRequired(true);
        b.addAction(reply.build()).addAction(read.build());
        nm.notify(tag, 1, b.build());
    }

    private static Map<String, Object> map(Object... kv) {
        Map<String, Object> m = new HashMap<>();
        for (int i = 0; i + 1 < kv.length; i += 2) m.put((String) kv[i], kv[i + 1]);
        return m;
    }

    static String channelLabel(String ch) {
        switch (ch == null ? "" : ch) {
            case "discord": return "Discord";
            case "gmail": return "Gmail";
            case "whatsapp": return "WhatsApp";
            case "instagram": return "Instagram";
            default: return "Message";
        }
    }

    private static PendingIntent personAct(Context c, Hub h, String pid, String section, String account, String tag, String what, int code, boolean mutable) {
        Intent i = new Intent(c, NoteAction.class).setAction(what).putExtra("hub", h.id).putExtra("person", pid)
                .putExtra("section", section).putExtra("account", account).putExtra("tag", tag);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | (mutable && Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : mutable ? 0 : PendingIntent.FLAG_IMMUTABLE);
        return PendingIntent.getBroadcast(c, code, i, flags);
    }

    /** The person's conversation shortcut (Android 11+ shows the notification as a conversation
     *  then: their picture big, in the Conversations section, can be made a priority one). */
    private static String shortcut(Context c, Hub h, String pid, String name, Icon icon, android.app.Person them, Intent open) {
        if (Build.VERSION.SDK_INT < 30) return null;
        try {
            ShortcutManager sm = c.getSystemService(ShortcutManager.class);
            if (sm == null) return null;
            String id = "person:" + h.id + ":" + pid;
            ShortcutInfo si = new ShortcutInfo.Builder(c, id).setShortLabel(name.isEmpty() ? "Message" : name).setLongLived(true)
                    .setIcon(icon).setPerson(them).setIntent(new Intent(open).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP))
                    .setCategories(java.util.Collections.singleton("dev.harbor.app.category.PERSON")).build();
            sm.pushDynamicShortcut(si);
            return id;
        } catch (RuntimeException e) {
            return null;
        }
    }

    /** Their picture from the PC, round (cached per picture); a letter avatar on their colour when
     *  they have none or it can't be loaded. Called off the main thread (the pings' threads). */
    private static Bitmap face(Hub h, String pic, String name, String color) {
        int px = 192;
        if (pic != null && !pic.isEmpty()) {
            synchronized (faces) {
                Bitmap b = faces.get(pic);
                if (b != null) return b;
            }
            try {
                String u = pic + (pic.contains("?") ? "&" : "?") + "size=256";
                Bitmap src = PersonsUi.decode(PersonsUi.bytes(h, u), px);
                if (src != null) {
                    Bitmap round = round(src, px);
                    synchronized (faces) {
                        if (faces.size() > 40) faces.clear();
                        faces.put(pic, round);
                    }
                    return round;
                }
            } catch (Exception | OutOfMemoryError ignored) { }
        }
        return letter(name, color, px);
    }

    private static Bitmap round(Bitmap src, int px) {
        Bitmap out = Bitmap.createBitmap(px, px, Bitmap.Config.ARGB_8888);
        Canvas cv = new Canvas(out);
        int s = Math.min(src.getWidth(), src.getHeight());
        Bitmap sq = Bitmap.createBitmap(src, (src.getWidth() - s) / 2, (src.getHeight() - s) / 2, s, s);
        Bitmap scaled = Bitmap.createScaledBitmap(sq, px, px, true);
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        p.setShader(new BitmapShader(scaled, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP));
        cv.drawCircle(px / 2f, px / 2f, px / 2f, p);
        return out;
    }

    static Bitmap letter(String name, String color, int px) {
        Bitmap out = Bitmap.createBitmap(px, px, Bitmap.Config.ARGB_8888);
        Canvas cv = new Canvas(out);
        Paint bg = new Paint(Paint.ANTI_ALIAS_FLAG);
        int col;
        try { col = Color.parseColor(color == null || color.isEmpty() ? "#64748b" : color); } catch (IllegalArgumentException e) { col = 0xff64748b; }
        bg.setColor(col);
        cv.drawCircle(px / 2f, px / 2f, px / 2f, bg);
        String t = initials(name);
        Paint fg = new Paint(Paint.ANTI_ALIAS_FLAG);
        fg.setColor(Color.WHITE);
        fg.setTypeface(Typeface.create(Typeface.DEFAULT, Typeface.BOLD));
        fg.setTextSize(px * (t.length() > 1 ? 0.38f : 0.46f));
        fg.setTextAlign(Paint.Align.CENTER);
        Rect r = new Rect();
        fg.getTextBounds(t, 0, t.length(), r);
        cv.drawText(t, px / 2f, px / 2f + r.height() / 2f, fg);
        return out;
    }

    static String initials(String name) {
        java.util.List<String> w = new java.util.ArrayList<>();
        for (String x : (name == null ? "" : name.trim()).split("\\s+")) if (!x.isEmpty()) w.add(x);
        if (w.isEmpty()) return "?";
        StringBuilder s = new StringBuilder().appendCodePoint(Character.toUpperCase(w.get(0).codePointAt(0)));
        if (w.size() > 1) s.appendCodePoint(Character.toUpperCase(w.get(w.size() - 1).codePointAt(0)));
        return s.toString();
    }
}
