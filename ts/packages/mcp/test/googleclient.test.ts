import { expect, test } from "bun:test";
import { googleBuiltinFromEnv, googleWebFromEnv } from "../src/apps.ts";

const built = { id: "baked.apps", secret: "baked-secret", webId: "baked-web.apps", webSecret: "baked-web-secret" };

test("a release build's own Google clients serve when the environment names none", () => {
  expect(googleBuiltinFromEnv({}, built)).toEqual({ id: "baked.apps", secret: "baked-secret" });
  expect(googleWebFromEnv({}, built)).toEqual({ id: "baked-web.apps", secret: "baked-web-secret" });
});

test("the environment wins over the baked clients", () => {
  const env = { HARBOR_GOOGLE_CLIENT_ID: "env.apps", HARBOR_GOOGLE_CLIENT_SECRET: "env-secret", HARBOR_GOOGLE_WEB_CLIENT_ID: "envweb.apps", HARBOR_GOOGLE_WEB_CLIENT_SECRET: "envweb-secret" };
  expect(googleBuiltinFromEnv(env, built)).toEqual({ id: "env.apps", secret: "env-secret" });
  expect(googleWebFromEnv(env, built)).toEqual({ id: "envweb.apps", secret: "envweb-secret" });
});

test("a build without them has no built-in client: each user brings their own", () => {
  expect(googleBuiltinFromEnv({}, {})).toBeUndefined();
  expect(googleWebFromEnv({ HARBOR_GOOGLE_WEB_CLIENT_ID: "only-an-id" }, {})).toBeUndefined();
});
