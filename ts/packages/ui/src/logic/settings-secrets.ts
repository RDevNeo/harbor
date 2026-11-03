import { agoShort } from "@harbor/net";
import { secrets, type Store } from "@harbor/store";
import { btn, copy, field, form, list, row, title, type Block, type BlockRow, type BlockTab } from "./settings-blocks.ts";

export interface SecretsHost {
  store: Store;
  /** Where the keys are kept (shown at the bottom). */
  path: string;
  /** A chat's name as the grants list shows it ("" when it's gone). */
  chatLabel(chat: number): string;
  /** A revoked grant whose chat still exists: it hears about it. */
  told(chat: number, name: string): void;
  /** Unix seconds. */
  now(): number;
}

const ABOUT =
  "Agents see only the names, and use a key only after you allow it, for the time you pick. Harbor's run_with_secrets tool runs their command on this PC with the key set and hides it in what comes back, as is and in common encodings (base64, URL, hex). That keeps keys out of chats by mistake; it is not a lock: a command that changes the value on purpose gets it through, and agents run as you, so one could read the file it's kept in. A key you let Harbor write to a project's .env file is plain text there, readable by the agent's own tools.";

/** secrets.rs's `until`: what is left of a grant. */
export function secretsLeft(until: number, at: number): string {
  const d = Math.max(until - at, 0);
  if (d < 60) return "<1m";
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  return `${Math.floor(d / 3600)}h${String(Math.floor((d % 3600) / 60)).padStart(2, "0")}m`;
}

/** secretsui.rs `secrets_tab` and `grants_section`; `replacing` is the secret whose new value is being typed. */
export function secretsBlocks(host: SecretsHost, replacing: string | null): Block[] {
  const at = host.now();
  const out: Block[] = [
    title("Add a secret", 11),
    form("add", [field("name", "Name", { mono: true, min: 1 }), field("value", "Value", { password: true, min: 1 }), field("description", "What it's for")], btn("save", "Save", { variant: "primary" })),
  ];
  const grants = secrets.loadGrants(host.store).filter((g) => g.until > at);
  if (grants.length > 0) {
    out.push(title("Allowed now"));
    out.push(
      list(
        grants.map((g) =>
          row(g.name, { mono_title: true, desc: `${host.chatLabel(g.chat)}  ·  ${secretsLeft(g.until, at)} left`, buttons: [btn(`revoke:${g.chat}:${g.name}`, "Revoke", { variant: "destructive", tip: "It can't use the key from now on" })] }),
        ),
        "",
      ),
    );
  }
  out.push(title("Saved"));
  const saved: BlockRow[] = secrets.names(host.path).map((x) => {
    const about = x.description === "" ? "••••••••" : `••••••••  ·  ${x.description}`;
    const open = replacing === x.name;
    return row(x.name, {
      mono_title: true,
      desc: `${about}  ·  ${agoShort(x.updated, at)}`,
      buttons: [...(open ? [] : [btn(`replace:${x.name}`, "Replace", { variant: "ghost" })]), btn(`delete:${x.name}`, "Delete", { variant: "destructive" })],
      edit: open ? [{ kind: "replace", label: "", fields: [field("value", "New value", { password: true, min: secrets.MIN_LEN })], buttons: [btn(`save:${x.name}`, "Save", { variant: "primary" }), btn("cancel", "Cancel", { variant: "ghost" })], toggles: [], text: "" }] : [],
    });
  });
  out.push(list(saved, "None yet. Add one above, or an agent asks for one when it needs it."));
  out.push(copy(ABOUT, 12, { before: 19 }));
  out.push(copy(`Kept in ${host.path} (only you can read it), on this PC only: never synced to your other PCs or phones.`, 12, { before: 12 }));
  return out;
}

/** The tab's controls: adding, replacing and deleting keys, revoking grants. */
export function secretsTab(host: SecretsHost): BlockTab {
  let replacing: string | null = null;
  const fail = (e: unknown) => (e instanceof Error ? e.message : String(e));
  return {
    blocks: () => secretsBlocks(host, replacing),
    pressed(key) {
      const [verb = "", a = "", ...rest] = key.split(":");
      if (verb === "replace") replacing = a;
      else if (verb === "cancel") replacing = null;
      else if (verb === "delete") {
        const name = [a, ...rest].join(":");
        secrets.remove(name, host.path);
        secrets.saveGrants(host.store, secrets.loadGrants(host.store).filter((g) => g.name !== name));
      } else if (verb === "revoke") {
        const chat = Number(a);
        const name = rest.join(":");
        secrets.saveGrants(host.store, secrets.loadGrants(host.store).filter((g) => !(g.chat === chat && g.name === name)));
        if (host.chatLabel(chat) !== "") host.told(chat, name);
      }
    },
    toggled: () => {},
    edited: () => {},
    submitted(key, values) {
      try {
        if (key === "add") secrets.save(values[0] ?? "", values[1] ?? "", values[2] ?? "", host.path);
        else if (key.startsWith("save:")) {
          secrets.save(key.slice(5), values[0] ?? "", "", host.path);
          replacing = null;
        }
      } catch (e) {
        return fail(e);
      }
      return "";
    },
  };
}
