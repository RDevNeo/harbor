package dev.harbor.app;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/** Words (the phone's offline dictionary and commands) against the cases src/dictwords.rs checks. */
public class WordsTest {
    public static void main(String[] args) throws Exception {
        List<Words.Entry> dict = new ArrayList<>();
        int n = 0, bad = 0;
        for (String line : Files.readAllLines(Paths.get(args[0]), StandardCharsets.UTF_8)) {
            if (line.trim().isEmpty() || line.startsWith("#")) continue;
            String[] f = line.split("\\|", -1);
            for (int i = 0; i < f.length; i++) f[i] = f[i].replace("\\n", "\n");
            switch (f[0]) {
                case "entry":
                    dict.add(new Words.Entry(f[1], f.length > 2 && !f[2].isEmpty() ? Arrays.asList(f[2].split(",")) : new ArrayList<>()));
                    break;
                case "dict": {
                    String got = Words.apply(f[1], dict);
                    if (!got.equals(f[2])) { System.err.println("dict: " + line + " → " + got); bad++; }
                    break;
                }
                case "cmd": {
                    String[] got = Words.commands(f[1]);
                    if (!got[0].equals(f[2]) || !got[1].equals(f[3])) { System.err.println("cmd: " + line + " → " + got[0] + "|" + got[1]); bad++; }
                    break;
                }
                default: throw new IllegalStateException("unknown case " + f[0]);
            }
            n++;
        }
        if (bad > 0 || n < 20) { System.err.println(bad + " of " + n + " cases failed"); System.exit(1); }
        System.out.println("WordsTest ok (" + n + " cases)");
    }
}
