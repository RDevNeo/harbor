package dev.harbor.shell;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.os.Process;

/** Opens Harbor again after Shell.restart ended its process for new code (an update tapped on a
 *  screen). Runs in a process of its own (":restart", the shell's code only): makes sure the old
 *  process is gone, starts the app's launcher screen in a new one, and ends. Shows nothing. */
public final class Restart extends Activity {
    static final String PID = "pid";

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        int pid = getIntent().getIntExtra(PID, -1);
        if (pid > 0 && pid != Process.myPid()) Process.killProcess(pid);
        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (open != null) startActivity(open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
        finish();
        Runtime.getRuntime().exit(0);
    }
}
