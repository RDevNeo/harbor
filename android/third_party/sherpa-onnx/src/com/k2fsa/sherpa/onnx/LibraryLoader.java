package com.k2fsa.sherpa.onnx;

/** Harbor: Android loads the JNI library from the APK's lib/<abi>/ (upstream's LibraryUtils
 *  unpacks it from a desktop jar instead). */
public class LibraryLoader {
    private static volatile boolean autoLoadEnabled = true;
    private static volatile boolean isLoaded = false;

    static synchronized void loadLibrary() {
        if (!isLoaded) {
            System.loadLibrary("sherpa-onnx-jni");
            isLoaded = true;
        }
    }

    public static void setAutoLoadEnabled(boolean enabled) {
        autoLoadEnabled = enabled;
    }

    static void maybeLoad() {
        if (autoLoadEnabled) {
            loadLibrary();
        }
    }
}
