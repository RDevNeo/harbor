package dev.harbor.shell;

import android.app.AppComponentFactory;
import android.content.pm.ApplicationInfo;
import android.util.Log;

/** Android 9+ asks this, once per process, for the class loader every component of the app
 *  (activities, services, receivers, the provider) is made from (the manifest's
 *  appComponentFactory): the newest good downloaded code's, or the APK's own (Shell.boot). The
 *  components keep the manifest's names, so the code's classes stand in for the APK's. Never
 *  throws: anything wrong is the APK's own code. */
public final class Factory extends AppComponentFactory {
    @Override
    public ClassLoader instantiateClassLoader(ClassLoader cl, ApplicationInfo ai) {
        try {
            ClassLoader code = Shell.boot(cl, ai);
            if (code != null) return code;
        } catch (Throwable t) {
            Log.w(Shell.TAG, "boot: " + t);
        }
        return cl;
    }
}
