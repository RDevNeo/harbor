import { expect, test } from "bun:test";
import { fixOnPeer, fixOutcome, localDevice, updateToast, type PeerFixer } from "../src/logic/hubseam.ts";

test("localDevice names this PC by its mesh id, else its hostname", () => {
  expect(localDevice({ HARBOR_MESH_ID: "ts:desk" }, "box")).toBe("pc:ts:desk");
  expect(localDevice({ HARBOR_MESH_ID: "" }, "box")).toBe("pc:box");
  expect(localDevice({}, "box")).toBe("pc:box");
});

test("fixOutcome opens the copy, or says why there is none", () => {
  expect(fixOutcome({ status: 200, body: { id: 12, gid: "g" } }, "laptop")).toEqual({ chat: 12 });
  expect(fixOutcome({ status: 200, body: { id: null } }, "laptop")).toEqual({ toast: "The chat started on laptop. It opens here once it has arrived." });
  expect(fixOutcome({ status: 409, body: { error: "refresh the list first" } }, "laptop")).toEqual({ toast: "Couldn't start the chat: refresh the list first" });
  expect(fixOutcome({ status: 502, body: null }, "laptop")).toEqual({ toast: "Couldn't start the chat: it didn't work" });
});

test("updateToast shows the updater's status line", () => {
  expect(updateToast("up to date")).toBe("Up to date");
  expect(updateToast("update failed: offline")).toBe("Update failed: offline");
  expect(updateToast("built from source, doesn't update itself")).toBe("Built from source, doesn't update itself");
  expect(updateToast("")).toBe("Update check finished");
});

function fixer(reply: () => Promise<{ status: number; body: unknown }>, peer: string | undefined = "laptop") {
  const asked: unknown[][] = [];
  const gh: PeerFixer = {
    pcName: "desk",
    issuePeer: () => (peer === undefined ? undefined : { name: peer }),
    fixAway: (...a) => {
      asked.push(a);
      return reply();
    },
  };
  const said: string[] = [];
  return { gh, asked, said, out: { toast: (m: string) => said.push(`toast ${m}`), open: (c: number) => said.push(`open ${c}`) } };
}

const issue = "https://github.com/o/r/issues/3";

test("fixOnPeer sends the issue to the other PC under this PC's name, then opens the copy", async () => {
  const f = fixer(() => Promise.resolve({ status: 200, body: { id: 9 } }));
  await fixOnPeer(f.gh, issue, "be careful", "ana", "pc:desk", f.out);
  expect(f.asked).toEqual([[issue, "be careful", "ana", ["desk", "pc:desk"], false]]);
  expect(f.said).toEqual(["open 9"]);
});

test("fixOnPeer says what the other PC answered when it won't", async () => {
  const f = fixer(() => Promise.resolve({ status: 409, body: { error: "Add this repo as a Harbor project to let an agent work on it" } }), undefined);
  await fixOnPeer(f.gh, issue, "", undefined, "pc:desk", f.out);
  expect(f.said).toEqual(["toast Couldn't start the chat: Add this repo as a Harbor project to let an agent work on it"]);
  const down = fixer(() => Promise.reject(new Error("Connection refused")));
  await fixOnPeer(down.gh, issue, "", undefined, "pc:desk", down.out);
  expect(down.said).toEqual(["toast Couldn't start the chat: Connection refused"]);
  const late = fixer(() => Promise.resolve({ status: 200, body: { id: null } }));
  await fixOnPeer(late.gh, issue, "", undefined, "pc:desk", late.out);
  expect(late.said).toEqual(["toast The chat started on laptop. It opens here once it has arrived."]);
});
