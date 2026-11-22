package dev.harbor.app;

/** What a reply's file card says while it downloads (Files, FileText): run on the build's JVM (android/build.sh). */
public final class FileTextTest {
    static int fails;

    static void eq(Object got, Object want, String what) {
        if (!got.equals(want)) { System.out.println("FAIL " + what + ": " + got + " != " + want); fails++; }
    }

    public static void main(String[] args) {
        eq(FileText.size(812), "812 B", "bytes");
        eq(FileText.size(14 * 1024), "14 KB", "KB, whole");
        eq(FileText.size((long) (3.44 * (1 << 20))), "3.4 MB", "MB, one decimal under 10");
        eq(FileText.size(12L << 20), "12 MB", "MB, whole from 10");
        eq(FileText.size(3L << 30), "3 GB", "GB");
        eq(FileText.progress(5L << 20, 20L << 20), "Downloading 25% · 5 MB of 20 MB", "with a total");
        eq(FileText.progress(2048, -1), "Downloading… 2 KB", "no total yet");
        eq(FileText.isApk("schedule-fixer-debug.APK"), true, "an APK");
        eq(FileText.isApk("notes.pdf"), false, "not an APK");
        if (fails > 0) System.exit(1);
    }
}
