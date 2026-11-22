package dev.harbor.app;

/** What a file card (Files) says, apart from Android: tested on the build's JVM (test/FileTextTest.java). */
final class FileText {
    private FileText() { }

    /** "Downloading 34% · 4.2 of 12.4 MB". */
    static String progress(long done, long total) {
        if (total <= 0) return "Downloading… " + size(done);
        long pct = Math.min(100, done * 100 / total);
        return "Downloading " + pct + "% · " + size(done) + " of " + size(total);
    }

    /** A size as the desktop's card says it: 812 B, 14 KB, 3.4 MB. */
    static String size(long n) {
        if (n < 1024) return n + " B";
        String[] units = { "KB", "MB", "GB" };
        double v = n / 1024.0;
        int u = 0;
        while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
        String s = v < 10 ? String.format(java.util.Locale.ROOT, "%.1f", v).replaceAll("\\.0$", "") : String.valueOf(Math.round(v));
        return s + " " + units[u];
    }

    static boolean isApk(String name) {
        return name.toLowerCase(java.util.Locale.ROOT).endsWith(".apk");
    }
}
