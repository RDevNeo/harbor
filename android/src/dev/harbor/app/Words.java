package dev.harbor.app;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/** Dictation's dictionary and spoken commands for the phone's offline fallback: the hub's
 *  src/dictwords.rs, rule for rule (the hub applies them to everything it transcribes; this only
 *  runs on phrases the phone transcribed itself). Both check android/test/dictation-cases.txt. */
final class Words {
    private Words() { }

    /** A dictionary entry: the exact spelling, and how it may come out of the transcriber. */
    static final class Entry {
        final String term;
        final List<String> sounds;
        Entry(String term, List<String> sounds) { this.term = term; this.sounds = sounds; }
    }

    // ---- dictionary ----

    private static List<int[]> wordSpans(String t) {
        List<int[]> out = new ArrayList<>();
        int start = -1;
        for (int i = 0; i < t.length(); ) {
            int c = t.codePointAt(i);
            if (Character.isLetterOrDigit(c)) { if (start < 0) start = i; }
            else if (start >= 0) { out.add(new int[]{start, i}); start = -1; }
            i += Character.charCount(c);
        }
        if (start >= 0) out.add(new int[]{start, t.length()});
        return out;
    }

    private static char fold(char c) {
        switch (c) {
            case 'á': case 'à': case 'â': case 'ã': case 'ä': return 'a';
            case 'é': case 'è': case 'ê': case 'ë': return 'e';
            case 'í': case 'ì': case 'î': case 'ï': return 'i';
            case 'ó': case 'ò': case 'ô': case 'õ': case 'ö': return 'o';
            case 'ú': case 'ù': case 'û': case 'ü': return 'u';
            case 'ç': return 's';
            case 'ñ': return 'n';
            default: return c;
        }
    }

    /** How a word or words sound, roughly (see dictwords.rs `key`). */
    static String key(String s) {
        StringBuilder base = new StringBuilder();
        for (char c : s.toLowerCase(java.util.Locale.ROOT).toCharArray()) {
            char f = fold(c);
            if (Character.isLetterOrDigit(f)) base.append(f);
        }
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < base.length(); ) {
            char c = base.charAt(i), next = i + 1 < base.length() ? base.charAt(i + 1) : 0;
            char k;
            int skip = 1;
            if (c == 'p' && next == 'h') { k = 'f'; skip = 2; }
            else if (c == 'c' && next == 'k') { k = 'k'; skip = 2; }
            else if (c == 'c' || c == 'q' || c == 'k') k = 'k';
            else if (c == 'x') { push(out, 'k'); k = 's'; }
            else if (c == 'z') k = 's';
            else if (c == 'y') k = 'i';
            else k = c;
            push(out, k);
            i += skip;
        }
        return out.toString();
    }

    private static void push(StringBuilder b, char c) {
        if (b.length() == 0 || b.charAt(b.length() - 1) != c) b.append(c);
    }

    private static int distance(String a, String b) {
        int[] prev = new int[b.length() + 1];
        for (int j = 0; j <= b.length(); j++) prev[j] = j;
        for (int i = 0; i < a.length(); i++) {
            int[] cur = new int[b.length() + 1];
            cur[0] = i + 1;
            for (int j = 0; j < b.length(); j++)
                cur[j + 1] = Math.min(Math.min(prev[j] + (a.charAt(i) == b.charAt(j) ? 0 : 1), prev[j + 1] + 1), cur[j] + 1);
            prev = cur;
        }
        return prev[b.length()];
    }

    /** How far `heard` (in `words` words) is from `form`; -1 when not close enough. */
    private static int closeness(String heard, int words, String form) {
        if (heard.isEmpty() || form.isEmpty()) return -1;
        if (heard.equals(form)) return 0;
        int n = form.length();
        boolean fuzzy = n >= 7 || (n >= 6 && words >= 2);
        if (!fuzzy || heard.charAt(0) != form.charAt(0)) return -1;
        int d = distance(heard, form);
        return d <= (n >= 10 ? 2 : 1) ? d : -1;
    }

    /** The text with the dictionary's terms spelled exactly. */
    static String apply(String text, List<Entry> dict) {
        if (dict == null || dict.isEmpty()) return text;
        List<Integer> owner = new ArrayList<>();
        List<String> forms = new ArrayList<>();
        for (int i = 0; i < dict.size(); i++) {
            owner.add(i); forms.add(key(dict.get(i).term));
            for (String s : dict.get(i).sounds) { owner.add(i); forms.add(key(s)); }
        }
        List<int[]> spans = wordSpans(text);
        StringBuilder out = new StringBuilder();
        int copied = 0;
        for (int i = 0; i < spans.size(); ) {
            int bestD = -1, bestK = 0, bestE = -1;
            StringBuilder joined = new StringBuilder();
            for (int k = 1; k <= Math.min(6, spans.size() - i); k++) {
                if (k > 1) {
                    String gap = text.substring(spans.get(i + k - 2)[1], spans.get(i + k - 1)[0]);
                    if (!(gap.trim().isEmpty() || gap.equals("-"))) break;
                }
                int[] s = spans.get(i + k - 1);
                joined.append(text, s[0], s[1]);
                String heard = key(joined.toString());
                for (int f = 0; f < forms.size(); f++) {
                    int d = closeness(heard, k, forms.get(f));
                    if (d >= 0 && (bestD < 0 || d <= bestD)) { bestD = d; bestK = k; bestE = owner.get(f); }
                }
            }
            if (bestE >= 0) {
                out.append(text, copied, spans.get(i)[0]).append(dict.get(bestE).term);
                copied = spans.get(i + bestK - 1)[1];
                i += bestK;
            } else i++;
        }
        return out.append(text.substring(copied)).toString();
    }

    // ---- commands ----

    static final List<String> SEND_ALONE = Arrays.asList(
            "send", "send it", "send message", "send the message", "enter", "press enter", "hit enter", "enviar", "envia", "envie", "enviar mensagem", "manda", "mandar", "pode enviar", "pode mandar",
            "aperta enter", "aperte enter", "apertar enter", "pressiona enter", "pressione enter", "da enter", "dar enter");
    static final List<String> SEND_TAIL = Arrays.asList("press enter", "hit enter", "aperta enter", "aperte enter", "apertar enter", "pressiona enter", "pressione enter", "da enter", "dar enter");
    static final List<String> NEW_LINE = Arrays.asList("new line", "newline", "next line", "nova linha", "proxima linha", "quebra de linha", "pula linha", "pular linha");
    static final List<String> NEW_PARAGRAPH = Arrays.asList("new paragraph", "next paragraph", "novo paragrafo", "proximo paragrafo");

    private static String norm(String s) {
        StringBuilder b = new StringBuilder();
        for (char c : s.toLowerCase(java.util.Locale.ROOT).toCharArray()) {
            char f = fold(c);
            b.append(Character.isLetterOrDigit(f) ? f : ' ');
        }
        return b.toString().trim().replaceAll("\\s+", " ");
    }

    private static boolean ender(char c) { return c == '.' || c == '!' || c == '?' || c == '…'; }

    private static List<int[]> sentences(String t) {
        List<int[]> out = new ArrayList<>();
        int start = 0;
        for (int i = 0; i < t.length(); i++) {
            char c = t.charAt(i);
            int end = -1;
            if (c == '\n') end = i;
            else if (ender(c)) {
                while (i + 1 < t.length() && ender(t.charAt(i + 1))) i++;
                if (i + 1 >= t.length() || Character.isWhitespace(t.charAt(i + 1))) end = i + 1;
            }
            if (end >= 0) { out.add(new int[]{start, end}); start = c == '\n' ? i + 1 : end; }
        }
        out.add(new int[]{start, t.length()});
        List<int[]> kept = new ArrayList<>();
        for (int[] s : out) if (!t.substring(s[0], s[1]).trim().isEmpty()) kept.add(s);
        return kept;
    }

    private static String trimEnd(String s, String chars) {
        int e = s.length();
        while (e > 0 && (Character.isWhitespace(s.charAt(e - 1)) || chars.indexOf(s.charAt(e - 1)) >= 0)) e--;
        return s.substring(0, e);
    }

    private static String trimSpacesEnd(String s) {
        int e = s.length();
        while (e > 0 && (s.charAt(e - 1) == ' ' || s.charAt(e - 1) == '\t')) e--;
        return s.substring(0, e);
    }

    /** What the spoken commands do to a transcript: {text without them, "1" when it sends}. */
    static String[] commands(String text) {
        StringBuilder t = new StringBuilder();
        int copied = 0;
        for (int[] s : sentences(text)) {
            String n = norm(text.substring(s[0], s[1]));
            String brk = NEW_LINE.contains(n) ? "\n" : NEW_PARAGRAPH.contains(n) ? "\n\n" : null;
            if (brk == null) continue;
            t.append(trimSpacesEnd(text.substring(copied, s[0]))).append(brk);
            copied = s[1];
            while (copied < text.length() && (text.charAt(copied) == ' ' || text.charAt(copied) == '\t')) copied++;
        }
        t.append(text.substring(copied));
        String all = t.toString();
        String trimmed = trimEnd(all, "");
        List<int[]> ss = sentences(trimmed);
        if (!ss.isEmpty()) {
            int[] last = ss.get(ss.size() - 1);
            if (SEND_ALONE.contains(norm(trimmed.substring(last[0], last[1]))))
                return new String[]{trimEnd(trimmed.substring(0, last[0]), ","), "1"};
        }
        String n = norm(trimmed);
        for (String c : SEND_TAIL) {
            if (!n.equals(c) && !n.endsWith(" " + c)) continue;
            List<int[]> spans = wordSpans(trimmed);
            int words = c.split(" ").length;
            if (spans.size() >= words) return new String[]{trimEnd(trimmed.substring(0, spans.get(spans.size() - words)[0]), ","), "1"};
        }
        return new String[]{all, "0"};
    }
}
