package dev.harbor.app;

import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/** The chat list's filter by account workspace, the desktop's rule (src/sidebar.rs
 *  `in_workspace`): a chat is in the workspace of its home PC, by the directory's PC → workspace,
 *  so a PC in none shows only under All. The answering PC's projects are in its workspace; a
 *  project stays in another one while one of its unsettled chats is there.
 *  Plain JVM, no Android: build.sh runs WsFilterTest before packaging. */
final class WsFilter {
    private final String ws, hub, here;
    private final Map<String, String> pcs;
    private final Set<String> projects = new HashSet<>();

    /** `ws` is the workspace shown ("": all), `hub` the answering PC, `here` its workspace. */
    WsFilter(String ws, String hub, String here, Map<String, String> pcs) {
        this.ws = ws; this.hub = hub; this.here = here; this.pcs = pcs;
    }

    boolean active() { return !ws.isEmpty(); }

    /** Whether a chat of PC `home` shows. */
    boolean shows(String home) {
        return !active() || ws.equals(home.isEmpty() || home.equals(hub) ? here : pcs.get(home));
    }

    /** Takes an unsettled lead of `project` ("": none) into account for `showsProject`. */
    void saw(String home, String project) {
        if (shows(home) && !project.isEmpty()) projects.add(project);
    }

    boolean showsProject(String id) {
        return !active() || ws.equals(here) || projects.contains(id);
    }
}
