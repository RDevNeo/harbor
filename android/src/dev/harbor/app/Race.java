package dev.harbor.app;

import java.io.IOException;
import java.io.InterruptedIOException;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Executor;

/** Connecting to one of several addresses of a PC (Hub.connect), staggered: the first starts at
 *  once, each next one when the one before failed or stagger ms passed without it connecting;
 *  the first to connect wins and the others' connections are dropped once they're made. Tried one
 *  after another, a stale address (the Wi-Fi's after the phone went on mobile data) cost its whole
 *  timeout, 3 to 6 s each, before the address that works was even tried.
 *  Plain Java, no Android: android/test/RaceTest.java runs it on the JVM. */
final class Race {
    interface Try<T> { T run(int i) throws IOException; }
    interface Drop<T> { void drop(T t); }

    /** All of them failed: their errors, in the addresses' order. */
    static final class Lost extends IOException {
        final List<IOException> errors;
        Lost(List<IOException> errors) {
            super(errors.isEmpty() ? "no address" : errors.get(errors.size() - 1).getMessage(), errors.isEmpty() ? null : errors.get(errors.size() - 1));
            this.errors = errors;
        }
    }

    private Race() { }

    /** The first of n tries to succeed (see above); a try that succeeds after it is dropped. */
    static <T> T first(int n, long stagger, Executor ex, Try<T> t, Drop<T> drop) throws IOException {
        if (n <= 0) throw new Lost(new ArrayList<>());
        final Object lock = new Object();
        final IOException[] errs = new IOException[n];
        final Object[] won = { null };
        final boolean[] over = { false };
        final int[] failed = { 0 };
        int started = 0;
        long lastStart = 0;
        synchronized (lock) {
            while (true) {
                if (won[0] != null) {
                    over[0] = true;
                    @SuppressWarnings("unchecked") T w = (T) won[0];
                    return w;
                }
                if (failed[0] == n) {
                    over[0] = true;
                    List<IOException> out = new ArrayList<>();
                    for (IOException e : errs) if (e != null) out.add(e);
                    throw new Lost(out);
                }
                long now = System.nanoTime() / 1_000_000;
                if (started < n && (started == 0 || failed[0] == started || now - lastStart >= stagger)) {
                    final int i = started++;
                    lastStart = now;
                    ex.execute(() -> {
                        T r = null;
                        IOException bad = null;
                        try {
                            r = t.run(i);
                        } catch (IOException e) {
                            bad = e;
                        } catch (RuntimeException e) {
                            bad = new IOException(String.valueOf(e.getMessage()), e);
                        }
                        boolean keep;
                        synchronized (lock) {
                            if (bad != null || r == null) {
                                errs[i] = bad != null ? bad : new IOException("no connection");
                                failed[0]++;
                                keep = false;
                            } else {
                                keep = won[0] == null && !over[0];
                                if (keep) won[0] = r;
                            }
                            lock.notifyAll();
                        }
                        if (r != null && !keep) drop.drop(r);
                    });
                    continue;
                }
                long wait = started < n ? Math.max(1, stagger - (now - lastStart)) : 0;
                try {
                    lock.wait(wait);
                } catch (InterruptedException e) {
                    over[0] = true;
                    throw new InterruptedIOException("interrupted");
                }
            }
        }
    }
}
