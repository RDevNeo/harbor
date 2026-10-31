package dev.harbor.app;

import android.content.Context;
import android.media.MediaDataSource;
import android.util.Log;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.util.ArrayList;
import java.util.List;

/** A video of a PC as MediaPlayer reads it, so it plays while it arrives: bytes come by HTTP Range
 *  over the hub's pinned connection (with the token, which a player's own HTTP can't do) into a
 *  sparse file, and a read waits only for the part it wants. An index at the end of the file or a
 *  seek ahead moves the download there. It stops a while ahead of the reader, so a video nobody
 *  watches to the end isn't fetched to the end. A video that's all here is kept in the cache
 *  (oldest out, within {@link #CACHE}) and later plays from there, {@link #whole}. */
final class Stream extends MediaDataSource {
    private static final long MAX = 200L << 20; // the hub caps them too
    private static final long CACHE = 300L << 20;
    /** How far past the reader the download goes before it waits. */
    private static final long AHEAD = 32L << 20;
    /** A read this far past the download is reached by waiting; further, the download moves. */
    private static final long NEAR = 4L << 20;
    private static final int TIMEOUT = 30_000;
    private static final int RETRIES = 4;

    /** A kept copy, all here: play this instead of the stream. */
    final File whole;
    private final Hub hub;
    private final String url;
    private final long total;
    private final boolean ranged;
    private final Blocks blocks;
    private final File part, to, dir;
    private final RandomAccessFile file;
    private final FileChannel channel;
    private final Object lock = new Object();
    private long want;
    private volatile boolean closed;
    private volatile String failed;
    private volatile Net.Http now;
    /** A read is waiting for bytes: the viewer shows it's loading. */
    volatile boolean stalled;
    private long fetched;
    private final long born = System.currentTimeMillis();

    private Stream(File whole) {
        this.whole = whole;
        hub = null; url = null; total = whole.length(); ranged = false; blocks = null;
        part = to = dir = null; file = null; channel = null;
    }

    private Stream(Hub hub, String url, long total, boolean ranged, File to, Net.Http first) throws IOException {
        whole = null;
        this.hub = hub;
        this.url = url;
        this.total = total;
        this.ranged = ranged;
        this.to = to;
        dir = to.getParentFile();
        blocks = new Blocks(total);
        part = new File(dir, to.getName() + "." + System.nanoTime() + ".part");
        file = new RandomAccessFile(part, "rw");
        file.setLength(total);
        channel = file.getChannel();
        now = first;
        Thread t = new Thread(() -> fetch(first), "video-fetch");
        t.setDaemon(true);
        t.start();
    }

    /** Asks the hub for the video. Blocks on the network: never on the UI thread. */
    static Stream open(Context c, Hub hub, String url, String name) throws IOException {
        File dir = new File(c.getCacheDir(), "media");
        dir.mkdirs();
        int dot = name.lastIndexOf('.');
        String ext = dot >= 0 ? name.substring(dot).toLowerCase(java.util.Locale.ROOT) : "";
        if (!ext.matches("\\.(mp4|webm|mov)")) ext = ".mp4";
        File to = new File(dir, Integer.toHexString((hub.id + url).hashCode()) + ext);
        trim(dir, to.getName(), true);
        Net.Http h = null;
        try {
            h = hub.open("GET", url, TIMEOUT);
            h.header("Range", "bytes=0-");
            int code = h.code();
            if (code != 200 && code != 206) throw new IOException(code == 404 ? "it's gone, or the PC that has it is off" : "the PC answered " + code);
            long total = code == 206 ? Blocks.total(h.range()) : h.length();
            if (total <= 0) throw new IOException("the PC didn't say how long it is");
            if (total > MAX) throw new IOException("it's over 200 MB");
            // A kept copy of the same size is that video: no need for this answer.
            if (to.length() == total) {
                h.close();
                to.setLastModified(System.currentTimeMillis());
                return new Stream(to);
            }
            return new Stream(hub, url, total, code == 206, to, h);
        } catch (IOException e) {
            if (h != null) h.close();
            if (to.length() > 0) return new Stream(to);
            throw e;
        }
    }

    /** The oldest copies go, within {@link #CACHE}; with {@code parts}, the parts left behind too
     *  (only one video plays at a time, and this one has none yet). */
    private static void trim(File dir, String keep, boolean parts) {
        File[] all = dir.listFiles();
        if (all == null) return;
        List<Blocks.Kept> files = new ArrayList<>();
        for (File f : all) {
            if (!f.getName().endsWith(".part")) files.add(new Blocks.Kept(f.getName(), f.length(), f.lastModified()));
            else if (parts) f.delete();
        }
        for (String n : Blocks.over(files, CACHE, keep)) new File(dir, n).delete();
    }

    private void fetch(Net.Http first) {
        Net.Http c = first;
        long at = 0;
        int fails = 0;
        byte[] buf = new byte[Blocks.SIZE];
        while (!closed) {
            try {
                if (c == null) {
                    at = next();
                    if (at < 0) break;
                    c = hub.open("GET", url, TIMEOUT);
                    now = c;
                    if (ranged) c.header("Range", "bytes=" + at + "-");
                    int code = c.code();
                    if (code != (ranged ? 206 : 200)) throw new IOException("the PC answered " + code);
                }
                InputStream in = c.in();
                long began = at;
                while (!closed) {
                    int len = blocks.length(at), got = 0;
                    if (len <= 0) break;
                    while (got < len) {
                        int n = in.read(buf, got, len - got);
                        if (n <= 0) break;
                        got += n;
                    }
                    // A part ends here, or the connection did: the rest comes on the next one.
                    if (got < len) break;
                    channel.write(ByteBuffer.wrap(buf, 0, len), at);
                    synchronized (lock) {
                        blocks.mark(at);
                        fetched += len;
                        lock.notifyAll();
                    }
                    at += len;
                    fails = 0;
                    if (blocks.has(at) || moved(at)) break;
                }
                if (at == began && blocks.length(at) > 0) throw new IOException("the PC stopped sending it");
            } catch (IOException e) {
                if (closed) break;
                if (++fails >= RETRIES) {
                    failed = e.getMessage() == null ? "the connection to the PC broke" : e.getMessage();
                    synchronized (lock) { lock.notifyAll(); }
                    break;
                }
                try { Thread.sleep(400L * fails); } catch (InterruptedException x) { break; }
            } finally {
                if (c != null) c.close();
                c = null;
            }
        }
        if (!closed && blocks.complete()) keep();
    }

    /** True when this download should stop: the reader went elsewhere, or it's far enough ahead. */
    private boolean moved(long at) {
        synchronized (lock) {
            if (!blocks.has(want) && (want < at || want >= at + NEAR)) return ranged;
            return ranged && at - want > AHEAD;
        }
    }

    /** Where the next download starts, once one is due; -1 when it's all here or closed. */
    private long next() {
        synchronized (lock) {
            while (!closed) {
                long from = blocks.missing(want);
                if (from < 0) return -1;
                if (!ranged) return 0;
                // What's missing is close ahead of the reader. What it skipped stays missing,
                // so a seek doesn't fetch the rest of the file: it comes if the reader goes there.
                if (from > want - Blocks.SIZE && from - want <= AHEAD / 2) return from;
                try { lock.wait(1000); } catch (InterruptedException e) { return -1; }
            }
            return -1;
        }
    }

    /** All of it arrived: kept for the next time. Reads go on through the open file. */
    private void keep() {
        if (part.renameTo(to)) {
            to.setLastModified(System.currentTimeMillis());
            trim(dir, to.getName(), false);
        }
    }

    @Override public int readAt(long pos, byte[] b, int off, int size) throws IOException {
        if (closed) throw new IOException("closed");
        if (pos >= total) return -1;
        if (size <= 0) return 0;
        int n;
        synchronized (lock) {
            want = pos;
            lock.notifyAll();
            long until = System.currentTimeMillis() + TIMEOUT, seen = fetched;
            while (!closed && !blocks.has(pos)) {
                if (failed != null) throw new IOException(failed);
                // (As long as bytes come it waits: a slow network isn't a failure.)
                if (fetched != seen) {
                    seen = fetched;
                    until = System.currentTimeMillis() + TIMEOUT;
                }
                if (System.currentTimeMillis() > until) throw new IOException("the PC stopped sending it");
                stalled = true;
                try { lock.wait(250); } catch (InterruptedException e) { throw new IOException("interrupted"); }
            }
            stalled = false;
            if (closed) throw new IOException("closed");
            n = blocks.run(pos, size);
        }
        return channel.read(ByteBuffer.wrap(b, off, n), pos);
    }

    @Override public long getSize() { return total; }

    /** What came from the PC so far, in KB. */
    long fetchedKb() { synchronized (lock) { return fetched >> 10; } }

    /** Lets go of everything; a part that isn't all here is dropped. MediaPlayer calls this too. */
    @Override public void close() {
        if (closed) return;
        closed = true;
        synchronized (lock) { lock.notifyAll(); }
        if (whole != null) return;
        Net.Http c = now;
        if (c != null) c.close();
        try { file.close(); } catch (IOException ignored) { }
        boolean all;
        synchronized (lock) { all = blocks.complete(); }
        if (all) keep(); else part.delete();
        Log.i("HarborVideo", "stream closed: fetched " + (fetched >> 10) + " of " + (total >> 10) + " KB in " + (System.currentTimeMillis() - born) + " ms");
    }
}
