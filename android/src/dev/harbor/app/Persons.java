package dev.harbor.app;

import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.widget.LinearLayout;

/** Hub's Persons tab: Person Hub's people, chats and details, natively (PersonsTab / PersonsState),
 *  over the tab bar. Its data is the PC's: the routes under /v1/persons/… (ts/tabs/persons/engine.ts),
 *  on Tabs.hub(this). Every page (the list, All people, a chat, a request, the details) has the shared top bar;
 *  the people list is the tab's drawer too (its button, or a swipe right anywhere), and the tab bar stays. */
public class Persons extends Base {
    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        // A person's notification (Notes): their PC's pairing, then their chat once the tab is up.
        String hid = getIntent().getStringExtra("hub");
        Hub given = hid == null ? null : Hub.get(this, hid);
        hub = given != null ? given : Tabs.hub(this);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        View content = new PersonsTab().view(this, hub);
        page = Ui.col(this);
        page.setBackgroundColor(Ui.BG);
        page.addView(content, new LinearLayout.LayoutParams(-1, 0, 1));
        setContentView(page);
        PersonsState ps = PersonsState.cur;
        installTab(Tabs.PERSONS, ps.drawer());
        ps.navigated = this::closeDrawer;
        openPerson(getIntent());
    }

    /** Opened from a person's notification: their conversation (Hub was already on Persons, or not). */
    @Override
    protected void onNewIntent(android.content.Intent i) {
        super.onNewIntent(i);
        setIntent(i);
        openPerson(i);
    }

    private void openPerson(android.content.Intent i) {
        String pid = i == null ? null : i.getStringExtra("person");
        PersonsState ps = PersonsState.cur;
        if (pid == null || pid.isEmpty() || ps == null) return;
        i.removeExtra("person");
        ps.openChat(pid, i.getStringExtra("section"));
    }

    @Override
    public void onBackPressed() {
        if (drawerOpen() || rightOpen()) { closeDrawer(); return; }
        if (PersonsTab.back()) return;
        super.onBackPressed();
    }
}
