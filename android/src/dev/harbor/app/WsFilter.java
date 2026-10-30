package dev.harbor.app;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** The chat list's filter by account workspace, the desktop's rule (src/sidebar.rs
 *  `in_workspace`): a chat is in the workspace of its home PC, by the directory's PC → workspace,
 *  so a PC in none shows only under All. The answering PC's projects are in its workspace; a
 *  project stays in another one while one of its unsettled chats is there.
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
     *  ids that are gone drop out, and none or every one of them is All (empty). */
    static List<String> picked(String stored, Collection<String> all) {
        List<String> on = new ArrayList<>(all);
        on.retainAll(Arrays.asList(stored.split(",")));
        return on.size() == all.size() ? new ArrayList<>() : on;
    }

    /** `stored` with workspace `id` turned on or off (All turns it on alone). */
    static String toggled(String stored, String id, Collection<String> all) {
        List<String> on = picked(stored, all);
        if (!on.remove(id)) on.add(id);
        return String.join(",", picked(String.join(",", on), all));
    }

    boolean active() { return !ws.isEmpty(); }

    /** Whether a chat of PC `home` shows. */
    boolean shows(String home) {
        return !active() || ws.contains(home.isEmpty() || home.equals(hub) ? here : pcs.get(home));
    }

    /** Takes an unsettled lead of `project` ("": none) into account for `showsProject`. */
    void saw(String home, String project) {
        if (shows(home) && !project.isEmpty()) projects.add(project);
    }

    boolean showsProject(String id) {
        return !active() || ws.contains(here) || projects.contains(id);
    }
}
