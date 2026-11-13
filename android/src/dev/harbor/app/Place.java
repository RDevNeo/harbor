package dev.harbor.app;

import org.json.JSONArray;
import org.json.JSONObject;

/** Where a project's folder is, as the desktop says it (ts/packages/ui/src/logic/projectplace.ts):
 *  `/v1/state` projects' `here`, `pc`, `pc_name` and `pc_online`. A project whose folder isn't
 *  on the PC names the PC that holds it, so two projects with one name are told apart, and a
 *  new chat in it starts there. Hubs that don't send `here` have every folder on them. */
final class Place {
    private Place() {}

    static JSONObject project(JSONObject st, String pid) {
        JSONArray ps = st == null ? null : st.optJSONArray("projects");
        for (int i = 0; ps != null && pid != null && i < ps.length(); i++) {
            JSONObject p = ps.optJSONObject(i);
            if (p != null && pid.equals(p.optString("id"))) return p;
        }
        return null;
    }

    /** The folder isn't on the PC. */
    static boolean elsewhere(JSONObject p) {
        return p != null && !p.optBoolean("here", true);
    }

    /** The small hint after a project's name: the PC that holds it; for one of the PC's own
     *  projects whose name another has, its folder's parent; else "". */
    static String hint(JSONObject st, String pid) {
        JSONObject p = project(st, pid);
        if (p == null) return "";
        // No PC is named after a project (a chat runs on the PC it's typed on): only two of one name get their folders.
        String name = p.optString("name");
        JSONArray ps = st.optJSONArray("projects");
        int same = 0;
        for (int i = 0; ps != null && i < ps.length(); i++) {
            JSONObject o = ps.optJSONObject(i);
            if (o != null && name.equals(o.optString("name"))) same++;
        }
        if (same < 2) return "";
        String path = p.optString("path");
        int cut = path.lastIndexOf('/');
        return cut > 0 ? path.substring(0, cut) : path;
    }

    /** A project's line in a list: its folder, with where it is when it isn't on the PC. */
    static String line(JSONObject p) {
        if (p == null) return "";
        String path = p.optString("path");
        if (!elsewhere(p)) return path;
        return p.optString("pc_name").isEmpty() ? "Not on this PC: " + path : "On " + p.optString("pc_name") + ": " + path;
    }

    /** The PC a new chat in project `pid` starts on: the one that holds its folder, while it's on
     *  and it's one of the state's devices (null: none, the chat starts on the PC). */
    static String startOn(JSONObject st, String pid) {
        JSONObject p = project(st, pid);
        if (!elsewhere(p) || p.optString("pc").isEmpty() || !p.optBoolean("pc_online")) return null;
        String pc = p.optString("pc");
        JSONArray ds = st.optJSONArray("devices");
        for (int i = 0; ds != null && i < ds.length(); i++) {
            JSONObject d = ds.optJSONObject(i);
            if (d != null && pc.equals(d.optString("id")) && d.optBoolean("online", true)) return pc;
        }
        return null;
    }

    /** The line over a new chat in project `pid` whose folder isn't on the PC ("" when it is, or once a device is picked:
     *  the Device chip already says where the chat runs). */
    static String note(JSONObject st, String pid, String device) {
        JSONObject p = project(st, pid);
        if (!elsewhere(p)) return "";
        String name = p.optString("name"), pc = p.optString("pc_name");
        if (!device.isEmpty()) return "";
        if (pc.isEmpty()) return name + "’s folder isn’t on this PC: pick the PC that has it under Device";
        // Its PC is off: the hub says where the chat starts instead (another PC that has the project), or that it can't now.
        if (!p.optBoolean("pc_online") && !p.optString("failover").isEmpty()) return p.optString("failover");
        if (!p.optBoolean("pc_online")) return name + "’s folder is on " + pc + ", which is off: the chat can start there once it’s back";
        return name + "’s folder is on " + pc + ", not on this PC: pick " + pc + " under Device to start there";
    }
}
