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
        hub = Tabs.hub(this);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        View content = new PersonsTab().view(this, hub);
        page = Ui.col(this);
        page.setBackgroundColor(Ui.BG);
        page.addView(content, new LinearLayout.LayoutParams(-1, 0, 1));
        setContentView(page);
        PersonsState ps = PersonsState.cur;
        installTab(Tabs.PERSONS, ps.drawer());
        ps.navigated = this::closeDrawer;
    }

    @Override
    public void onBackPressed() {
        if (drawerOpen() || rightOpen()) { closeDrawer(); return; }
        if (PersonsTab.back()) return;
        super.onBackPressed();
    }
}
