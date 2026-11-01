import { readFileSync, writeFileSync } from "node:fs";
import { connect, generateIdentity, type Identity, parseIdentity, peerFp, server } from "./tls.ts";

function identity(): Identity {
  const path = process.env.HTS_IDENTITY;
  if (!path) return generateIdentity();
  return parseIdentity(readFileSync(path, "utf8"));
}

const [mode, target, pin] = process.argv.slice(2);
const id = identity();

if (mode === "new") {
  if (!target) throw new Error("new PATH");
  writeFileSync(target, id.pem, { mode: 0o600 });
  console.log(id.fp);
} else if (mode === "fp") {
  console.log(id.fp);
} else if (mode === "serve") {
  const s = server({
    id,
    onConnection: (sock, peer) => {
      console.log(`peer ${peer ?? "none"} ${sock.getProtocol()} ${sock.getCipher().name}`);
      sock.on("data", () => {
        sock.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: application/json\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}`);
      });
      sock.on("error", () => {});
    },
  });
  s.listen(Number(target), "127.0.0.1", () => console.log(`listening ${id.fp}`));
} else if (mode === "dial") {
  if (!target || !pin) throw new Error("dial HOST:PORT PIN");
  const [host, port] = target.split(":");
  for (const maxVersion of ["TLSv1.3", "TLSv1.2"] as const) {
    const c = await connect({ id, pin, host: host ?? "127.0.0.1", port: Number(port), maxVersion });
    const answer = new Promise<string>((resolve) => c.once("data", (d) => resolve(d.toString())));
    c.write("GET /v1/app HTTP/1.1\r\nhost: harbor\r\nconnection: close\r\n\r\n");
    console.log(`${c.getProtocol()} ${c.getCipher().name} server ${peerFp(c)} -> ${(await answer).split("\r\n")[0]}`);
    c.destroy();
  }
} else {
  throw new Error("new|fp|serve|dial");
}
