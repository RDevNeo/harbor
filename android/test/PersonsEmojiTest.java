package dev.harbor.app;

import java.util.List;

/** Persons' emoji logic (PersonsEmoji): Discord's custom emoji, `:name:` quotes and big emoji-only messages. Plain JVM,
 *  no Android: build.sh runs it before packaging. */
public class PersonsEmojiTest {
    private static int failed;

    private static void same(Object got, Object want, String what) {
        if (String.valueOf(got).equals(String.valueOf(want))) return;
        failed++;
        System.err.println("FAIL " + what + ": got " + got + ", want " + want);
    }

    public static void main(String[] args) {
        String cat = "<:CatSou:1296274311606435873>";
        List<PersonsEmoji.Custom> cs = PersonsEmoji.customs("hi " + cat + " <a:party_blob:123456789012345678>!");
        same(cs.size(), 2, "two custom emoji");
        same(cs.get(0).name + "/" + cs.get(0).id + "/" + cs.get(0).animated + "/" + cs.get(0).start + "-" + cs.get(0).end, "CatSou/1296274311606435873/false/3-32", "the first");
        same(cs.get(1).animated, true, "the second is animated");
        same(PersonsEmoji.cdn(cs.get(0), 48), "https://cdn.discordapp.com/emojis/1296274311606435873.webp?size=48", "webp");
        same(PersonsEmoji.cdn(cs.get(1), 96), "https://cdn.discordapp.com/emojis/123456789012345678.gif?size=96", "animated: gif");
        same(PersonsEmoji.route(cs.get(0), 48), "/v1/persons/img/url?u=https%3A%2F%2Fcdn.discordapp.com%2Femojis%2F1296274311606435873.webp%3Fsize%3D48", "through the PC");
        same(PersonsEmoji.plain("ok " + cat + "!"), "ok :CatSou:!", "plain");
        for (String t : new String[] { "<@1296274311606435873>", "<#1296274311606435873>", "<t:1700000000:R>", "<:short:12>", "a < b" }) {
            same(PersonsEmoji.customs(t).size(), 0, "not an emoji: " + t);
            same(PersonsEmoji.plain(t), t, "kept: " + t);
        }
        same(PersonsEmoji.plain(null), "", "null");

        same(PersonsEmoji.jumbo(cat, 3), 1, "a custom emoji alone");
        same(PersonsEmoji.jumbo("😂", 3), 1, "one emoji");
        same(PersonsEmoji.jumbo(" 👍🏽 " + cat + "\n❤️ ", 3), 3, "three, with spaces");
        same(PersonsEmoji.jumbo("👨‍👩‍👧 🇧🇷 1️⃣", 3), 3, "a ZWJ family, a flag, a keycap");
        same(PersonsEmoji.jumbo("❤", 3), 1, "a bare dingbat");
        same(PersonsEmoji.jumbo("ok 👍", 3), 0, "with text");
        same(PersonsEmoji.jumbo("😀😀😀😀", 3), 0, "four");
        same(PersonsEmoji.jumbo(cat + " hi", 3), 0, "custom with text");
        same(PersonsEmoji.jumbo("1", 3), 0, "a digit");
        same(PersonsEmoji.jumbo("©", 3), 0, "a text symbol");
        same(PersonsEmoji.jumbo("   ", 3), 0, "blank");
        same(PersonsEmoji.jumbo(null, 3), 0, "null");

        if (failed > 0) {
            System.err.println(failed + " failed");
            System.exit(1);
        }
        System.out.println("PersonsEmojiTest ok");
    }
}
