import { expect, test } from "bun:test";
import { inviteCard } from "../src/logic/invitecard.ts";

const inv = { id: "i1", ws_name: "Team", inviter_name: "Sam", email: "a@example.org" };

test("the invitation card names who invited you to what", () => {
  const c = inviteCard([inv], []);
  expect(c?.id).toBe("i1");
  expect(c?.title).toBe("Sam invited you to Team");
  expect(c?.body).toStartWith("Accept to use its PCs and see its chats");
  expect(inviteCard([{ ...inv, ws_name: "", inviter_name: "" }], [])?.title).toBe("You're invited to a workspace");
});

test("one card at a time; a closed one gives way to the next, none is left once all are closed", () => {
  const two = [inv, { ...inv, id: "i2", ws_name: "Lab" }];
  expect(inviteCard(two, [])?.body).toContain("1 more invitation waits in Settings › Workspace.");
  expect(inviteCard(two, ["i1"])?.title).toBe("Sam invited you to Lab");
  expect(inviteCard(two, ["i1"])?.body).not.toContain("more");
  expect(inviteCard(two, ["i1", "i2"])).toBeNull();
  expect(inviteCard([], [])).toBeNull();
});
