package dev.harbor.app;

import android.content.Context;
import android.view.View;

/** One of Hub's top-level tabs (Projects, Persons, Routine) in the phone's bottom tab bar.
 *  Placeholder until the tab bar's own definition lands (agent "fork"): the same shape. */
interface HubTab {
    /** "projects", "persons", "routine". */
    String id();
    /** The tab's root view for this screen and PC. */
    View view(Context c, Hub hub);
}
