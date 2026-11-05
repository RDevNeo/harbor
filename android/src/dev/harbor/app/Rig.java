package dev.harbor.app;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** A test build's stand-in for the sign-in (scripts/boat/phoneshot): android/build.sh with
 *  HARBOR_RIG_PORT set makes an app that is signed in to a fake account and knows one PC, a hub
 *  on 127.0.0.1:<port> (adb reverse) that takes HARBOR_RIG_TOKEN. The account's directory has
 *  that PC's workspace (ws:org_sam, as ts/rig/phonehub.ts seeds it) with made-up members, PCs
 *  and an invitation out, for Settings (none in: Invites would pop it up on every screen). In
 *  every other build Config.RIG_PORT is 0 and this is never used. */
final class Rig {
    private Rig() { }

    static boolean on() { return Config.RIG_PORT > 0; }

    static JSONObject account() {
        try {
            JSONArray members = new JSONArray()
                    .put(member("rig", "Sam Rivera", "sam@example.com", "owner"))
                    .put(member("u_alex", "Alex Kim", "alex@example.com", "member"))
                    .put(member("u_jordan", "Jordan Lee", "jordan@example.com", "member"));
            JSONArray pcs = new JSONArray()
                    .put(new JSONObject().put("id", "pc:rig-pc").put("name", "rig-pc").put("owner", "rig").put("owner_name", "Sam Rivera").put("version", "0.109.0.ts"))
                    .put(new JSONObject().put("id", "pc:laptop").put("name", "Laptop").put("owner", "u_alex").put("owner_name", "Alex Kim").put("version", "0.109.0.ts"));
            JSONObject ws = new JSONObject().put("id", "org_sam").put("name", "Sam's workspace").put("role", "owner").put("personal", true)
                    .put("members", members).put("pcs", pcs)
                    .put("invites", new JSONArray().put(new JSONObject().put("id", "inv_out").put("email", "taylor@example.com")));
            JSONObject dir = new JSONObject().put("at", System.currentTimeMillis()).put("workspaces", new JSONArray().put(ws));
            return new JSONObject().put("id", "rig").put("name", "Sam Rivera").put("email", "sam@example.com")
                    .put("token", Config.RIG_TOKEN).put("token_at", System.currentTimeMillis()).put("exp", 4102444800L)
                    .put("dir", dir);
        } catch (JSONException e) {
            return new JSONObject();
        }
    }

    private static JSONObject member(String id, String name, String email, String role) throws JSONException {
        return new JSONObject().put("id", id).put("name", name).put("email", email).put("role", role);
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
