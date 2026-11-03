package dev.harbor.app;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** The chat list's filter by account workspace, the desktop's rule (logic/sidebar.ts
 *  `inWorkspaces`): a chat is in the workspace Move to workspace… put it in (its `workspace`, from
 *  the hub: its own, its lead's or its project's), else in its home PC's, by the directory's PC →
 *  workspace, so a PC in none shows only under All. A project is in the workspace it was moved to,
 *  else the answering PC's; it also stays in another one while one of its unsettled chats is there.
 *  Plain JVM, no Android: build.sh runs WsFilterTest before packaging. */
final class WsFilter {
    private final Set<String> ws;
    private final String hub, here;
    private final Map<String, String> pcs;
    private final Set<String> projects = new HashSet<>();

    /** `ws` are the workspaces shown (none: all), `hub` the answering PC, `here` its workspace. */
    WsFilter(Collection<String> ws, String hub, String here, Map<String, String> pcs) {
        this.ws = new HashSet<>(ws); this.hub = hub; this.here = here; this.pcs = pcs;
    }

    /** What's picked of `stored` (ids joined by commas) among `all`, the workspaces there are:
     *  ids that are gone drop out, none is All (empty), every one isn't. */
    static List<String> picked(String stored, Collection<String> all) {
        List<String> on = new ArrayList<>(all);
        on.retainAll(Arrays.asList(stored.split(",")));
        return on;
    }

    /** `stored` with workspace `id` turned on or off (All turns it on alone). */
    static String toggled(String stored, String id, Collection<String> all) {
        List<String> on = picked(stored, all);
        if (!on.remove(id)) on.add(id);
        return String.join(",", picked(String.join(",", on), all));
    }

    boolean active() { return !ws.isEmpty(); }

    /** Whether a chat of PC `home` shows. */
    boolean shows(String home) { return shows(home, ""); }

    /** Whether a chat of PC `home` moved to workspace `moved` ("": not moved) shows. */
    boolean shows(String home, String moved) {
        if (!active()) return true;
        if (moved != null && !moved.isEmpty()) return ws.contains(moved);
        return ws.contains(home.isEmpty() || home.equals(hub) ? here : pcs.get(home));
    }

    /** Takes an unsettled lead of `project` ("": none) into account for `showsProject`. */
    void saw(String home, String project) { saw(home, "", project); }

    void saw(String home, String moved, String project) {
        if (shows(home, moved) && !project.isEmpty()) projects.add(project);
    }

    boolean showsProject(String id) { return showsProject(id, ""); }

    /** Project `id`, moved to workspace `moved` ("": not moved, the answering PC's). */
    boolean showsProject(String id, String moved) {
        return !active() || ws.contains(moved != null && !moved.isEmpty() ? moved : here) || projects.contains(id);
    }
}
