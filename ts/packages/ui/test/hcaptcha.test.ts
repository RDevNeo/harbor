// The overlay's source of Discord's captcha (hcaptcha.ts) with a stand-in page: no browser, no hCaptcha.
import { expect, it } from "bun:test";
import { join } from "node:path";
import { type CaptchaJob, type CaptchaPage, DiscordCaptchaSource, type OpenPage, PAGE_H, PAGE_W, profileDir } from "../src/hcaptcha.ts";

const job: CaptchaJob = { html: "<p>x</p>", url: "https://discord.com/hub-captcha", intro: "To add Ana as a friend…", cancel: "Don't add", pill: "Add Ana" };

type Fake = { open: OpenPage; ev: Parameters<OpenPage>[1] | null; page: CaptchaPage & { mice: unknown[]; closed: number }; fail: string | undefined };

function fake(): Fake {
  const f: Fake = {
    ev: null as Parameters<OpenPage>[1] | null,
    fail: undefined as string | undefined,
    page: {
      mice: [] as unknown[],
      closed: 0,
      shot: async () => "SlBFRw==",
      async mouse(type: string, x: number, y: number) {
        f.page.mice.push([type, x, y]);
      },
      close() {
        f.page.closed++;
      },
    },
    open: (async (_j, ev) => {
      f.ev = ev;
      if (f.fail) throw new Error(f.fail);
      return f.page;
    }) as OpenPage,
  };
  return f;
}

it("shows the page once hCaptcha is drawn, passes the pointer on, and ends with the person's token", async () => {
  const f = fake();
  const s = new DiscordCaptchaSource(f.open);
  let woke = 0;
  s.wake = () => woke++;
  expect(s.signedIn()).toBe(false);
  expect(await s.frame()).toBeUndefined();
  const end = s.show(job);
  expect(woke).toBe(1);
  expect(s.signedIn()).toBe(true);
  await Bun.sleep(0);
  // loading: the overlay's words and a spinner, no image
  expect(await s.frame()).toEqual({ guild: "Add Ana", intro: job.intro, cancel: "Don't add", width: 0, height: 0, rect: null });
  f.ev!.ready();
  expect(await s.frame()).toMatchObject({ data: "SlBFRw==", width: PAGE_W, height: PAGE_H, intro: job.intro });
  await s.input("down", 140, 62);
  await s.input("up", 140, 62);
  await s.input("move", PAGE_W + 5, 10); // off the page: dropped
  expect(f.page.mice).toEqual([
    ["mousePressed", 140, 62],
    ["mouseReleased", 140, 62],
  ]);
  f.ev!.solved("P1_token");
  expect(await end).toEqual({ token: "P1_token" });
  expect(f.page.closed).toBe(1);
  expect(s.signedIn()).toBe(false);
  expect(woke).toBe(2);
});

it("a give-up, a page that can't start, or hCaptcha failing before it's drawn end it with no token", async () => {
  const a = fake();
  const s = new DiscordCaptchaSource(a.open);
  const e1 = s.show(job);
  await Bun.sleep(0);
  await s.cancel();
  expect(await e1).toEqual({ cancelled: true });
  expect(a.page.closed).toBe(1);

  const b = fake();
  b.fail = "no Chrome or Chromium on this PC";
  expect(await new DiscordCaptchaSource(b.open).show(job)).toEqual({ error: "no Chrome or Chromium on this PC" });

  const c = fake();
  const s3 = new DiscordCaptchaSource(c.open);
  const e3 = s3.show(job);
  await Bun.sleep(0);
  c.ev!.error("hCaptcha didn't load");
  expect(await e3).toEqual({ error: "hCaptcha didn't load" });

  // a new captcha gives up the one before
  const d = fake();
  const s4 = new DiscordCaptchaSource(d.open);
  const first = s4.show(job);
  const second = s4.show({ ...job, pill: "Message to Ana" });
  expect(await first).toEqual({ cancelled: true });
  await Bun.sleep(0);
  d.ev!.ready();
  d.ev!.solved("t2");
  expect(await second).toEqual({ token: "t2" });
});

it("keeps the hidden browser's profile out of /tmp, in one folder", () => {
  expect(profileDir({ XDG_CACHE_HOME: "/c", HOME: "/h" })).toBe(join("/c", "hub", "captcha-browser"));
  expect(profileDir({ HOME: "/h" })).not.toContain("/tmp");
  expect(profileDir({ HOME: "/h" }).endsWith(join("hub", "captcha-browser"))).toBe(true);
});
