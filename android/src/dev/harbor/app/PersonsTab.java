package dev.harbor.app;

import android.app.Activity;
import android.content.Context;
import android.content.ContextWrapper;
import android.view.View;
import android.view.ViewGroup;

/** The Persons tab's content (hosted by the Persons activity under the tab bar): Person Hub's people,
 *  chats and details, natively (PersonsState). The static hooks are for the screen that hosts the tabs:
 *  {@link #back()} from its onBackPressed, {@link #unread()} for the tab's badge, {@link #deep()}
 *  to hide the tab bar while a chat or a person's details fill the screen, and {@link #listen}
 *  to hear when either changes. */
public final class PersonsTab {
    private static Runnable listener;

    public String id() { return "persons"; }

    /** The tab's root (the same view again for the same screen and PC, taken off its old parent). */
    public View view(Context c, Hub hub) {
        PersonsState p = PersonsState.of(activity(c), hub);
        if (p.root.getParent() != null) ((ViewGroup) p.root.getParent()).removeView(p.root);
        return p.root;
    }

    /** Android back: closes the top-most of details › chat › All people; false at the tab's home
     *  (the app's own back then). */
    public static boolean back() { return PersonsState.cur != null && PersonsState.cur.back(); }

    /** Everyone's unread messages (the tab's badge). */
    public static int unread() { return PersonsState.unread; }

    /** A chat or a person's details fills the screen: the host may hide the tab bar. */
    public static boolean deep() { return PersonsState.cur != null && PersonsState.cur.deep(); }

    /** Runs on the UI thread whenever unread() or deep() may have changed (null: none). */
    public static void listen(Runnable r) { listener = r; }

    static void changed() {
        Runnable r = listener;
        if (r != null) r.run();
    }

    private static Activity activity(Context c) {
        while (c instanceof ContextWrapper && !(c instanceof Activity)) c = ((ContextWrapper) c).getBaseContext();
        if (!(c instanceof Activity)) throw new IllegalArgumentException("the Persons tab needs an activity");
        return (Activity) c;
    }
}
