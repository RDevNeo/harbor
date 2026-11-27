package dev.harbor.app;

import java.io.UnsupportedEncodingException;
import java.net.URLEncoder;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Emoji in Persons' messages, plain logic (no Android: PersonsEmojiTest), as the PC's emoji.ts: Discord's custom
 *  emoji (`<:name:id>`, animated `<a:name:id>`) found in a text, their pictures, `:name:` for one-line quotes, and
 *  whether a message is nothing but 1-3 emoji (drawn big, Discord's "jumbo"). */
final class PersonsEmoji {
    private PersonsEmoji() { }

    static final Pattern CUSTOM = Pattern.compile("<(a?):([\\w~]{1,32}):(\\d{15,21})>");

    /** One custom emoji in a text: where it is (UTF-16 indexes), its name, id and whether it's animated. */
    static final class Custom {
        final int start, end;
        final String name, id;
        final boolean animated;

        Custom(int start, int end, String name, String id, boolean animated) {
            this.start = start;
            this.end = end;
            this.name = name;
            this.id = id;
            this.animated = animated;
        }
    }

    static List<Custom> customs(String text) {
        List<Custom> out = new ArrayList<>();
        if (text == null || text.indexOf('<') < 0) return out;
        Matcher m = CUSTOM.matcher(text);
        while (m.find()) out.add(new Custom(m.start(), m.end(), m.group(2), m.group(3), !m.group(1).isEmpty()));
        return out;
    }

    /** Its picture on Discord's CDN (an animated one as its GIF: the first frame shows). */
    static String cdn(Custom c, int size) {
        return "https://cdn.discordapp.com/emojis/" + c.id + (c.animated ? ".gif" : ".webp") + "?size=" + size;
    }

    /** The same picture through the PC's picture cache (PersonsUi.bitmap loads it). */
    static String route(Custom c, int size) {
        try {
            return "/v1/persons/img/url?u=" + URLEncoder.encode(cdn(c, size), "UTF-8");
        } catch (UnsupportedEncodingException e) {
            throw new IllegalStateException(e);
        }
    }

    /** One-line text (reply quotes): each custom emoji as `:name:`. */
    static String plain(String text) {
        if (text == null || text.indexOf('<') < 0) return text == null ? "" : text;
        return CUSTOM.matcher(text).replaceAll(":$2:");
    }

    /** How many emoji a message of nothing but 1-`max` emoji (custom or Unicode, spaces between) holds; 0 when it has
     *  anything else or more. A ZWJ sequence, a flag, a keycap or a skin-toned hand counts as one. */
    static int jumbo(String text, int max) {
        if (text == null || text.trim().isEmpty() || text.length() > 400) return 0;
        int n = 0;
        StringBuilder rest = new StringBuilder();
        int last = 0;
        Matcher m = CUSTOM.matcher(text);
        while (m.find()) {
            n++;
            rest.append(text, last, m.start()).append(' ');
            last = m.end();
        }
        rest.append(text.substring(last));
        String s = rest.toString();
        int i = 0;
        while (i < s.length()) {
            int cp = s.codePointAt(i);
            if (Character.isWhitespace(cp)) { i += Character.charCount(cp); continue; }
            boolean ri = regional(cp);
            boolean keycap = (cp >= '0' && cp <= '9') || cp == '#' || cp == '*';
            if (!ri && !keycap && !pictographic(cp)) return 0;
            boolean shown = ri || presented(cp);
            boolean capped = false;
            i += Character.charCount(cp);
            if (ri && i < s.length() && regional(s.codePointAt(i))) i += 2;
            while (i < s.length()) {
                int c = s.codePointAt(i);
                if (c == 0xFE0F) { shown = true; i++; }
                else if (c == 0x20E3) { shown = true; capped = true; i++; }
                else if ((c >= 0x1F3FB && c <= 0x1F3FF) || (c >= 0xE0020 && c <= 0xE007F)) i += 2;
                else if (c == 0x200D && i + 1 < s.length() && pictographic(s.codePointAt(i + 1))) {
                    i += 1 + Character.charCount(s.codePointAt(i + 1));
                    shown = true;
                } else break;
            }
            if ((keycap && !capped) || !shown) return 0;
            if (++n > max) return 0;
        }
        return n;
    }

    private static boolean regional(int cp) {
        return cp >= 0x1F1E6 && cp <= 0x1F1FF;
    }

    /** Extended_Pictographic, near enough: the emoji blocks and the older symbols that have an emoji form. */
    static boolean pictographic(int cp) {
        return (cp >= 0x1F000 && cp <= 0x1FAFF) || (cp >= 0x2600 && cp <= 0x27BF) || (cp >= 0x2300 && cp <= 0x23FF)
                || (cp >= 0x2B00 && cp <= 0x2BFF) || (cp >= 0x2194 && cp <= 0x21AA) || (cp >= 0x25AA && cp <= 0x25FE)
                || cp == 0xA9 || cp == 0xAE || cp == 0x203C || cp == 0x2049 || cp == 0x2122 || cp == 0x2139
                || cp == 0x2934 || cp == 0x2935 || cp == 0x3030 || cp == 0x303D || cp == 0x3297 || cp == 0x3299;
    }

    /** Drawn as an emoji even without U+FE0F (©, ™, a bare arrow stay text); the dingbats count, as Discord draws them. */
    private static boolean presented(int cp) {
        return cp >= 0x1F000 || (cp >= 0x2600 && cp <= 0x27BF) || cp == 0x231A || cp == 0x231B || (cp >= 0x23E9 && cp <= 0x23EC)
                || cp == 0x23F0 || cp == 0x23F3 || cp == 0x25FD || cp == 0x25FE || cp == 0x2B1B || cp == 0x2B1C || cp == 0x2B50 || cp == 0x2B55;
    }
}
