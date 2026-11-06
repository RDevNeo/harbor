package dev.harbor.app;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** A test build's stand-in for the sign-in (scripts/boat/phoneshot): android/build.sh with
 *  HARBOR_RIG_PORT set makes an app that is signed in to a fake account and knows one PC, a hub
 *  on 127.0.0.1:<port> (adb reverse) that takes HARBOR_RIG_TOKEN. The account's directory has
 *  that PC's workspace (ws:org_sam, as ts/rig/phonehub.ts seeds it) with made-up members, PCs
 *  and an invitation out, for Settings (none in: Invites would pop it up on every screen), and a
 *  second workspace, Kai's, shared with Sam, with one PC. In every other build Config.RIG_PORT
 *  is 0 and this is never used. */
final class Rig {
    private Rig() { }

    static boolean on() { return Config.RIG_PORT > 0; }

    static JSONObject account() {
        try {
            JSONArray members = new JSONArray()
                    .put(member("rig", "Sam Rivera", "sam@example.com", "owner").put("image", PHOTO + "sam"))
                    .put(member("u_alex", "Alex Kim", "alex@example.com", "member").put("image", PHOTO + "alex"))
                    .put(member("u_jordan", "Jordan Lee", "jordan@example.com", "member"));
            JSONArray pcs = new JSONArray()
                    .put(new JSONObject().put("id", "pc:rig-pc").put("name", "rig-pc").put("owner", "rig").put("owner_name", "Sam Rivera").put("version", "0.109.0.ts"))
                    .put(new JSONObject().put("id", "pc:laptop").put("name", "Laptop").put("owner", "u_alex").put("owner_name", "Alex Kim").put("version", "0.109.0.ts"));
            JSONObject ws = new JSONObject().put("id", "org_sam").put("name", "Sam's workspace").put("role", "owner").put("personal", true)
                    .put("members", members).put("pcs", pcs)
                    .put("invites", new JSONArray().put(new JSONObject().put("id", "inv_out").put("email", "taylor@example.com")));
            // A workspace someone else shares with Sam: its PC shows in Settings › PCs as "Kai's Workspace".
            JSONObject kai = new JSONObject().put("id", "org_kai").put("name", "Kai's workspace").put("role", "member").put("personal", false)
                    .put("members", new JSONArray().put(member("u_kai", "Kai Ono", "kai@example.com", "owner")).put(member("rig", "Sam Rivera", "sam@example.com", "member")))
                    .put("pcs", new JSONArray().put(new JSONObject().put("id", "pc:studio").put("name", "studio-pc").put("owner", "u_kai").put("owner_name", "Kai Ono").put("version", "0.109.0.ts")))
                    .put("invites", new JSONArray());
            JSONObject dir = new JSONObject().put("at", System.currentTimeMillis()).put("workspaces", new JSONArray().put(ws).put(kai));
            return new JSONObject().put("id", "rig").put("name", "Sam Rivera").put("email", "sam@example.com").put("image", PHOTO + "sam")
                    .put("token", Config.RIG_TOKEN).put("token_at", System.currentTimeMillis()).put("exp", 4102444800L)
                    .put("dir", dir);
        } catch (JSONException e) {
            return new JSONObject();
        }
    }

    private static JSONObject member(String id, String name, String email, String role) throws JSONException {
        return new JSONObject().put("id", id).put("name", name).put("email", email).put("role", role);
    }

    /** Made-up photos (Jordan has none: initials). Avatars asks photo() instead of the network. */
    private static final String PHOTO = "https://photos.example/";

    /** A placeholder "photo" for a rig URL: a soft two-colour background and a figure, as a PNG. */
    static byte[] photo(String url) {
        if (!url.startsWith(PHOTO)) return null;
        String who = url.substring(PHOTO.length());
        int a = who.equals("sam") ? 0xFF3B6EA8 : 0xFF8A5A9E, b = who.equals("sam") ? 0xFF7FB3D5 : 0xFFE3A06B;
        int n = 256;
        android.graphics.Bitmap bm = android.graphics.Bitmap.createBitmap(n, n, android.graphics.Bitmap.Config.ARGB_8888);
        android.graphics.Canvas c = new android.graphics.Canvas(bm);
        android.graphics.Paint p = new android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG);
        p.setShader(new android.graphics.LinearGradient(0, 0, n, n, a, b, android.graphics.Shader.TileMode.CLAMP));
        c.drawRect(0, 0, n, n, p);
        p.setShader(null);
        p.setColor(0xE6F4EDE4);
        c.drawCircle(n / 2f, n * 0.40f, n * 0.17f, p);
        c.drawOval(new android.graphics.RectF(n * 0.18f, n * 0.62f, n * 0.82f, n * 1.10f), p);
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        bm.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, out);
        return out.toByteArray();
    }

    /** The hub's id: the workspace's, as the directory names hubs. */
    static final String HUB = "ws:org_sam";

    static String hubs() {
        try {
            return new JSONArray().put(new JSONObject().put("id", HUB).put("name", "Sam's workspace").put("host", "127.0.0.1")
                    .put("port", Config.RIG_PORT).put("token", "").put("pc_name", "rig-pc")).toString();
        } catch (JSONException e) {
            return "[]";
        }
    }
}
