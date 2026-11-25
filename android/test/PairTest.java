package dev.harbor.app;

/** Hub pairing links (PairLink), as the PC's QR code holds them: run on the build's JVM. */
public final class PairTest {
    static int fails;

    static void eq(Object got, Object want, String what) {
        if (got == null ? want != null : !got.equals(want)) { System.out.println("FAIL " + what + ": " + got + " != " + want); fails++; }
    }

    static String parsed(String s) {
        PairLink l = PairLink.parse(s);
        return l == null ? null : l.fp.substring(0, 4) + "|" + String.join(",", l.addrs) + "|" + l.name + "|" + l.id + "|" + l.code;
    }

    public static void main(String[] args) {
        String fp = "ab".repeat(32);
        eq(parsed("hub://pair?fp=" + fp + "&addrs=192.168.1.5:47940,100.64.0.2:47940&name=Igor-Omarchy&id=ts%3Adesk&code=k7Q2"),
                "abab|192.168.1.5:47940,100.64.0.2:47940|Igor-Omarchy|ts:desk|k7Q2", "a full link");
        eq(parsed("HUB://Pair/?fp=" + fp.toUpperCase() + "&addrs=%5Bfd00%3A%3A1%5D%3A47940&code=x#y"), "abab|[fd00::1]:47940|||x", "case, slash, IPv6, fragment");
        eq(parsed("hub://pair?fp=AB:" + fp.substring(2) + "&addrs=h&code=c&name=My+PC"), "abab|h|My PC||c", "colons in fp, + as space");
        eq(parsed("hub://pair?fp=" + fp + "&addrs=h"), null, "no code");
        eq(parsed("hub://pair?fp=" + fp + "&code=c"), null, "no address");
        eq(parsed("hub://pair?fp=abc&addrs=h&code=c"), null, "a bad key");
        eq(parsed("harbor://pair?fp=" + fp + "&addrs=h&code=c"), null, "Harbor's scheme");
        eq(parsed("hub://chat/abc"), null, "a chat link");
        eq(parsed(null), null, "nothing");
        eq(PairLink.label(PairLink.parse("hub://pair?fp=" + fp + "&addrs=h&code=c")), "PC abababab", "label without a name");
        if (fails > 0) { System.out.println(fails + " pairing link check(s) failed"); System.exit(1); }
        System.out.println("PairTest ok");
    }
}
