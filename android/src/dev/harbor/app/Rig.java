package dev.harbor.app;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** A test build's stand-in for the sign-in (scripts/boat/phoneshot): android/build.sh with
 *  HARBOR_RIG_PORT set makes an app that is signed in to a fake account and knows one PC, a hub
 *  on 127.0.0.1:<port> (adb reverse) that takes HARBOR_RIG_TOKEN. In every other build
 *  Config.RIG_PORT is 0 and this is never used. */
final class Rig {
    private Rig() { }

    static boolean on() { return Config.RIG_PORT > 0; }

    static JSONObject account() {
        try {
            return new JSONObject().put("id", "rig").put("name", "Sam Rivera").put("email", "sam@example.com")
                    .put("token", Config.RIG_TOKEN).put("token_at", System.currentTimeMillis()).put("exp", 4102444800L);
        } catch (JSONException e) {
            return new JSONObject();
        }
    }

    static String hubs() {
        try {
            return new JSONArray().put(new JSONObject().put("id", "rig").put("name", "Rig").put("host", "127.0.0.1")
                    .put("port", Config.RIG_PORT).put("token", "").put("pc_name", "rig-pc")).toString();
        } catch (JSONException e) {
            return "[]";
        }
    }
}
