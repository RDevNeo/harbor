#!/usr/bin/env python3
"""End-to-end test: fakeclerk + the real Worker under `wrangler dev --local`.

usage: python3 test/run.py [WORKER_DIR]   (or `npm test`; needs Python 3 with `cryptography`)
Logs and state go to test/.tmp (gitignored).
"""
import base64, hashlib, json, os, shutil, signal, subprocess, sys, threading, time, urllib.request, urllib.error
from urllib.parse import urlencode, urlparse, parse_qs

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, ed25519
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

SRC = os.path.dirname(os.path.abspath(__file__))
WORKER = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.dirname(SRC)
HERE = os.path.join(SRC, ".tmp")
os.makedirs(HERE, exist_ok=True)
CP, WP = 47995, 47996
CLERK, W = f"http://127.0.0.1:{CP}", f"http://127.0.0.1:{WP}"
TMP = os.path.join(HERE, "tmp")
os.makedirs(TMP, exist_ok=True)
ENV = dict(os.environ, TMPDIR=TMP, WRANGLER_SEND_METRICS="false", WRANGLER_LOG_PATH=TMP,
           npm_config_cache=os.path.join(HERE, "npm"), CI="1")
procs, results = [], []


def b64u(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def unb64u(s):
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def check(name, cond, extra=""):
    results.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name + (f"  [{extra}]" if not cond and extra else ""), flush=True)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


OPENER = urllib.request.build_opener(NoRedirect)


def http(method, url, body=None, token=None, form=None, raw=None):
    data, headers = None, {}
    if form is not None:
        data, headers["content-type"] = urlencode(form).encode(), "application/x-www-form-urlencoded"
    elif raw is not None:
        data, headers["content-type"] = raw, "application/json"
    elif body is not None:
        data, headers["content-type"] = json.dumps(body).encode(), "application/json"
    if token:
        headers["authorization"] = "Bearer " + token
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        r = OPENER.open(req, timeout=60)
    except urllib.error.HTTPError as e:
        r = e
    text = r.read().decode()
    try:
        js = json.loads(text)
    except ValueError:
        js = None
    return r.status if hasattr(r, "status") else r.code, js, {k.title(): v for k, v in r.headers.items()}, text


def start(cmd, log, cwd):
    f = open(os.path.join(HERE, log), "w")
    p = subprocess.Popen(cmd, cwd=cwd, env=ENV, stdout=f, stderr=subprocess.STDOUT, start_new_session=True)
    procs.append(p)
    return p


def stop_all():
    for p in procs:
        try:
            os.killpg(p.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    time.sleep(1)
    for p in procs:
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def wait_http(url, secs=240):
    end = time.time() + secs
    while time.time() < end:
        try:
            OPENER.open(url, timeout=3).read()
            return True
        except urllib.error.HTTPError:
            return True
        except Exception:
            time.sleep(1)
    return False


# ---- client side helpers

def login(email):
    http("POST", CLERK + "/test/login", {"email": email})
    verifier = b64u(os.urandom(32))
    chal = b64u(hashlib.sha256(verifier.encode()).digest())
    redir = "http://127.0.0.1:51234/callback"
    q = dict(response_type="code", client_id="harbor-test-client", redirect_uri=redir,
             scope="openid profile email offline_access", code_challenge=chal, code_challenge_method="S256",
             state="st123", prompt="login")
    st, _, h, _ = http("GET", CLERK + "/oauth/authorize?" + urlencode(q))
    assert st == 302, st
    loc = urlparse(h["Location"])
    assert h["Location"].startswith(redir) and parse_qs(loc.query)["state"] == ["st123"]
    code = parse_qs(loc.query)["code"][0]
    st, js, _, _ = http("POST", CLERK + "/oauth/token", form=dict(
        grant_type="authorization_code", code=code, redirect_uri=redir, client_id="harbor-test-client",
        code_verifier=verifier))
    assert st == 200, js
    return js["access_token"], verifier, code, redir


class Device:
    def __init__(self, kind, name):
        self.kind, self.name = kind, name
        self.key = ec.generate_private_key(ec.SECP256R1())
        self.spki = self.key.public_key().public_bytes(serialization.Encoding.DER,
                                                       serialization.PublicFormat.SubjectPublicKeyInfo)
        self.fp = hashlib.sha256(self.spki).hexdigest()

    def proof(self, ct, ts=None, raw=False, sign_text=None):
        ts = int(time.time()) if ts is None else ts
        text = sign_text or f"harbor-device-v1\n{ts}\n{hashlib.sha256(ct.encode()).hexdigest()}"
        der = self.key.sign(text.encode(), ec.ECDSA(hashes.SHA256()))
        sig = der
        if raw:
            r, s = decode_dss_signature(der)
            sig = r.to_bytes(32, "big") + s.to_bytes(32, "big")
        return {"kind": self.kind, "name": self.name, "spki": base64.b64encode(self.spki).decode(),
                "ts": ts, "sig": base64.b64encode(sig).decode()}


def session(ct, dev, **kw):
    return http("POST", W + "/v1/session", {"device": dev.proof(ct, **kw), "app": "0.80.0"}, token=ct)


def sess_ok(email, dev, **kw):
    ct = login(email)[0]
    st, js, _, _ = session(ct, dev, **kw)
    assert st == 200, (st, js)
    return js, ct


def verify_jwt(tok, x):
    h, p, s = tok.split(".")
    ed25519.Ed25519PublicKey.from_public_bytes(unb64u(x)).verify(unb64u(s), f"{h}.{p}".encode())
    return json.loads(unb64u(h)), json.loads(unb64u(p))


def main():
    # fake clerk
    state = os.path.join(HERE, "state.json")
    if os.path.exists(state):
        os.remove(state)
    start([sys.executable, os.path.join(SRC, "fakeclerk.py"), str(CP), "--state", state,
           "--redirect", W + "/oauth/android"], "fakeclerk.log", HERE)
    assert wait_http(CLERK + "/test/emails", 20), "fakeclerk did not start"

    # worker config
    sk = ed25519.Ed25519PrivateKey.generate()
    pkcs8 = base64.b64encode(sk.private_bytes(serialization.Encoding.DER, serialization.PrivateFormat.PKCS8,
                                              serialization.NoEncryption())).decode()
    with open(os.path.join(WORKER, ".dev.vars"), "w") as f:
        f.write(f"CLERK_FRONTEND_URL={CLERK}\nCLERK_API_URL={CLERK}/v1\nCLERK_SECRET_KEY=sk_test_fake\n"
                f"HARBOR_SIGNING_KEY={pkcs8}\nPUBLIC_URL={W}\n")
    shutil.rmtree(os.path.join(WORKER, ".wrangler/state"), ignore_errors=True)
    m = subprocess.run(["nice", "-n", "19", "npx", "wrangler", "d1", "migrations", "apply", "harbor-accounts", "--local"],
                       cwd=WORKER, env=ENV, capture_output=True, text=True, timeout=300)
    if m.returncode:
        print(m.stdout[-2000:], m.stderr[-2000:])
        raise SystemExit("migrations failed")
    start(["nice", "-n", "19", "npx", "wrangler", "dev", "--local", "--port", str(WP), "--ip", "127.0.0.1"],
          "wrangler.log", WORKER)
    if not wait_http(W + "/invite", 240):
        raise SystemExit("wrangler dev did not start; see " + os.path.join(HERE, "wrangler.log"))

    # keys + basic routes
    st, js, _, _ = http("GET", W + "/v1/keys")
    key = js["keys"][0] if js else {}
    pub = sk.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    check("keys: kid k1, EdDSA, x is the public key",
          st == 200 and key.get("kid") == "k1" and key.get("alg") == "EdDSA" and unb64u(key["x"]) == pub)
    st, _, h, t = http("GET", W + "/invite")
    check("invite page", st == 200 and "invited to a Harbor workspace" in t)
    st, _, h, t = http("GET", W + "/oauth/android?code=c1&state=s%201")
    check("oauth/android redirects to harbor://oauth with the query",
          st == 302 and h.get("Location") == "harbor://oauth?code=c1&state=s%201", h.get("Location"))
    st, js, _, _ = http("GET", W + "/v1/directory")
    check("directory without token is 401", st == 401)

    for e, f, l in [("sam@example.com", "Sam", "Rig"), ("alice@example.com", "Alice", "Example"),
                    ("pat@example.com", "Pat", "Invitee"), ("eve@example.com", "Eve", "Third")]:
        http("POST", CLERK + "/test/users", {"email": e, "first_name": f, "last_name": l})

    pc, phone = Device("pc", "desk"), Device("phone", "pixel")

    # OAuth through the fake (client side of the flow)
    ct, verifier, code, redir = login("sam@example.com")
    st, js, _, _ = http("POST", CLERK + "/oauth/token", form=dict(
        grant_type="authorization_code", code=code, redirect_uri=redir, client_id="harbor-test-client", code_verifier=verifier))
    check("fake clerk: code is single use", st == 400 and js["error"] == "invalid_grant")

    # sessions
    st, js, _, _ = session(ct, pc)
    check("session (pc, DER sig) ok", st == 200 and js["account"]["email"] == "sam@example.com", js)
    sam_pc = js["token"]
    ws0 = js["workspaces"]
    check("personal workspace: one, owner, personal, named after first name",
          len(ws0) == 1 and ws0[0]["role"] == "owner" and ws0[0]["personal"] and ws0[0]["name"] == "Sam's workspace", ws0)
    sam_ws = ws0[0]["id"]
    st, js2, _, _ = session(ct, phone)
    check("session (phone, DER sig) ok", st == 200 and js2["workspaces"][0]["id"] == sam_ws, js2)
    sam_phone = js2["token"]
    check("session answer: device fp, no pc for unknown fp, joined empty",
          js["device"]["fp"] == pc.fp and "pc" not in js and js["joined"] == [])
    st, js3, _, _ = session(ct, Device("pc", "raw"), raw=True)
    check("session accepts raw r||s signatures", st == 200, js3)
    st, js3, _, _ = session(ct, pc, ts=int(time.time()) - 3600)
    check("stale ts refused", st == 400 and "error" in js3, js3)
    d2 = Device("pc", "x")
    bad = d2.proof(ct)
    bad["spki"] = base64.b64encode(pc.spki).decode()
    st, js3, _, _ = http("POST", W + "/v1/session", {"device": bad}, token=ct)
    check("bad proof (other key) refused", st == 400 and "error" in js3, js3)
    st, js3, _, _ = session(ct, pc, sign_text="harbor-device-v1\n1\nabc")
    check("bad proof (wrong message) refused", st == 400, js3)
    st, js3, _, _ = http("POST", W + "/v1/session", {"device": pc.proof("at_bogus")}, token="at_bogus")
    check("unknown Clerk token: 401 with signin", st == 401 and js3.get("signin") is True, js3)

    # token
    x = key["x"]
    hd, pl = verify_jwt(sam_pc, x)
    now = time.time()
    check("token header", hd == {"alg": "EdDSA", "typ": "JWT", "kid": "k1"}, hd)
    check("token claims", pl["iss"] == "harbor-accounts" and pl["sub"] == js["account"]["id"] and pl["email"] == "sam@example.com"
          and pl["name"] == "Sam Rig" and pl["ws"] == [sam_ws] and pl["dev"] == pc.fp and pl["kind"] == "pc"
          and abs(pl["exp"] - pl["iat"] - 7 * 86400) <= 1 and abs(pl["iat"] - now) < 60, pl)
    check("phone token kind/dev", verify_jwt(sam_phone, x)[1]["kind"] == "phone" and verify_jwt(sam_phone, x)[1]["dev"] == phone.fp)
    st, _, _, _ = http("GET", W + "/v1/directory", token=sam_pc[:-4] + "AAAA")
    check("tampered token refused", st == 401)

    # personal workspace idempotency, including a race for a brand-new account
    sj1, _ = sess_ok("sam@example.com", Device("phone", "again"))
    check("personal workspace: two sessions give the same id", sj1["workspaces"][0]["id"] == sam_ws)
    http("POST", CLERK + "/test/users", {"email": "race@example.com", "first_name": "Race"})
    rct = login("race@example.com")[0]
    out = []
    ths = [threading.Thread(target=lambda: out.append(session(rct, Device("phone", "r")))) for _ in range(3)]
    [t.start() for t in ths]
    [t.join() for t in ths]
    _, st_all, _, _ = http("GET", CLERK + "/test/state")
    ruid = [u for u in st_all["users"].values() if u["first_name"] == "Race"][0]["id"]
    personal = [o for o in st_all["orgs"].values() if o["public_metadata"].get("harbor_personal") == ruid]
    ids = {o[1]["workspaces"][0]["id"] for o in out if o[0] == 200}
    check("concurrent first sessions: one personal workspace, same id everywhere",
          len(personal) == 1 and len(ids) == 1 and all(o[0] == 200 for o in out), (len(personal), ids, [o[0] for o in out]))

    # pcs and directory
    st, js, _, _ = http("POST", W + "/v1/pcs", {"ws": sam_ws, "id": "fp:abcd", "name": "desk", "addrs": ["10.0.0.5:47930"], "version": "0.80.0"},
                        token=sam_pc)
    check("pcs: register", st == 200 and js == {"ok": True}, js)
    st, js, _, _ = http("POST", W + "/v1/pcs", {"ws": sam_ws, "name": "p", "addrs": []}, token=sam_phone)
    check("pcs: phone token refused", st == 403)
    st, js, _, _ = http("POST", W + "/v1/pcs", {"ws": "org_nope", "name": "p", "addrs": []}, token=sam_pc)
    check("pcs: foreign workspace refused", st == 403)
    st, js, _, _ = http("POST", W + "/v1/pcs", {"ws": sam_ws, "id": "i" * 81, "name": "p", "addrs": []}, token=sam_pc)
    check("pcs: id over 80 chars refused", st == 400)
    st, js, _, _ = http("POST", W + "/v1/pcs", {"ws": sam_ws, "name": "p", "addrs": ["a"] * 17}, token=sam_pc)
    check("pcs: more than 16 addrs refused", st == 400)
    st, js, _, _ = http("GET", W + "/v1/directory", token=sam_pc)
    w0 = js["workspaces"][0] if st == 200 else {}
    check("directory: members, pcs", st == 200 and len(js["workspaces"]) == 1 and w0["members"][0]["email"] == "sam@example.com"
          and w0["members"][0]["role"] == "owner" and w0["pcs"][0]["fp"] == pc.fp and w0["pcs"][0]["addrs"] == ["10.0.0.5:47930"]
          and w0["pcs"][0]["id"] == "fp:abcd" and w0["pcs"][0]["owner_name"] == "Sam Rig" and w0["pcs"][0]["version"] == "0.80.0" and w0["personal"], js)
    check("directory: devices of members", {pc.fp, phone.fp} <= set(w0.get("devices", [])), w0.get("devices"))
    check("directory: invites list for owner (empty)", w0.get("invites") == [])
    st, js, _, _ = session(ct, pc)
    check("session reports pc workspace for a registered fp",
          js.get("pc") == {"ws": sam_ws, "ws_name": "Sam's workspace", "owner": "Sam Rig", "member": True}, js.get("pc"))

    # settings
    st, js, _, _ = http("GET", W + "/v1/settings", token=sam_pc)
    check("settings: empty at first", st == 200 and js["settings"] == {} and js["at"] == 0, js)
    st, js, _, _ = http("PUT", W + "/v1/settings", {"set": {"theme": {"v": "dark", "at": 1000}, "gone": {"v": None, "at": 5}}}, token=sam_pc)
    check("settings: put", st == 200 and js["settings"]["theme"] == {"v": "dark", "at": 1000} and js["settings"]["gone"]["v"] is None, js)
    st, js, _, _ = http("PUT", W + "/v1/settings", {"set": {"theme": {"v": "old", "at": 999}, "n": {"v": "1", "at": 7}}}, token=sam_phone)
    check("settings: older at loses, new key added", js["settings"]["theme"]["v"] == "dark" and js["settings"]["n"]["v"] == "1", js)
    st, js, _, _ = http("PUT", W + "/v1/settings", {"set": {"theme": {"v": "tie", "at": 1000}}}, token=sam_phone)
    check("settings: tie keeps stored", js["settings"]["theme"]["v"] == "dark")
    st, js, _, _ = http("PUT", W + "/v1/settings", {"set": {"theme": {"v": "light", "at": 2000}}}, token=sam_phone)
    st2, g, _, _ = http("GET", W + "/v1/settings", token=sam_pc)
    check("settings: newer wins, visible to other device", g["settings"]["theme"] == {"v": "light", "at": 2000} and g["at"] > 0, g)
    st, js, _, _ = http("PUT", W + "/v1/settings", {"set": {"k" * 65: {"v": "x", "at": 1}}}, token=sam_pc)
    check("settings: key over 64 chars refused", st == 400)
    st, js, _, _ = http("PUT", W + "/v1/settings", {"set": {"big": {"v": "x" * (16 * 1024 + 1), "at": 1}}}, token=sam_pc)
    check("settings: value over 16 KB gives 413", st == 413)
    st, js, _, _ = http("PUT", W + "/v1/settings", {"set": {"ok16": {"v": "x" * (16 * 1024), "at": 1}}}, token=sam_pc)
    check("settings: value of exactly 16 KB ok", st == 200)
    st = 200
    for i in range(9):
        st, js, _, _ = http("PUT", W + "/v1/settings", {"set": {f"f{i}": {"v": "y" * (16 * 1024), "at": 1}}}, token=sam_pc)
        if st != 200:
            break
    check("settings: whole object over 128 KB gives 413", st == 413, st)
    st, js, _, _ = http("PUT", W + "/v1/settings", raw=b"[1]", token=sam_pc)
    check("settings: malformed body is 400", st == 400)

    # invites
    alice, _ = sess_ok("alice@example.com", Device("phone", "a-phone"))
    alice_t = alice["token"]
    st, js, _, _ = http("POST", W + f"/v1/workspaces/{sam_ws}/invites", {"email": "pat@example.com"}, token=alice_t)
    check("invite: non-member refused", st == 403, js)
    st, js, _, _ = http("POST", W + f"/v1/workspaces/{sam_ws}/invites", {"email": "not-an-email"}, token=sam_pc)
    check("invite: bad email refused", st == 400)
    st, js, _, _ = http("POST", W + f"/v1/workspaces/{sam_ws}/invites", {"email": "  Pat@Example.com "}, token=sam_pc)
    inv = js.get("invite", {})
    check("invite: owner ok, email normalised", st == 200 and inv.get("email") == "pat@example.com" and inv["id"].startswith("inv_"), js)
    _, emails, _, _ = http("GET", CLERK + "/test/emails")
    check("invite: fake clerk saw the invitation email", any(e["to"] == "pat@example.com" and e["org"] == sam_ws for e in emails), emails)
    st, js, _, _ = http("POST", W + f"/v1/workspaces/{sam_ws}/invites", {"email": "pat@example.com"}, token=sam_pc)
    check("invite: duplicate pending refused (409)", st == 409)
    st, js, _, _ = http("POST", W + f"/v1/workspaces/{sam_ws}/invites", {"email": "sam@example.com"}, token=sam_pc)
    check("invite: existing member refused (409)", st == 409, js)
    _, d, _, _ = http("GET", W + "/v1/directory", token=sam_pc)
    check("directory: owner sees the pending invite", [i["email"] for i in d["workspaces"][0]["invites"]] == ["pat@example.com"], d)
    st, js, _, _ = http("POST", W + f"/v1/workspaces/{sam_ws}/invites", {"email": "gone@example.com"}, token=sam_pc)
    st2, js2, _, _ = http("DELETE", W + f"/v1/workspaces/{sam_ws}/invites/{js['invite']['id']}", token=alice_t)
    check("invite delete: non-owner refused", st2 == 403)
    st2, js2, _, _ = http("DELETE", W + f"/v1/workspaces/{sam_ws}/invites/{js['invite']['id']}", token=sam_pc)
    check("invite delete: owner ok", st2 == 200 and js2 == {"ok": True})

    pat_dev = Device("phone", "pat-phone")
    pj, _ = sess_ok("pat@example.com", pat_dev)
    check("invitee's first session auto-joins (joined)",
          pj["joined"] == [{"id": sam_ws, "name": "Sam's workspace"}] and len(pj["workspaces"]) == 2, pj["joined"])
    sam_role = [w for w in pj["workspaces"] if w["id"] == sam_ws][0]
    check("invitee is a plain member of the joined workspace", sam_role["role"] == "member" and not sam_role["personal"])
    pat_t = pj["token"]
    _, d, _, _ = http("GET", W + "/v1/directory", token=pat_t)
    sw = [w for w in d["workspaces"] if w["id"] == sam_ws][0]
    check("directory shows both workspaces; member sees no invites",
          len(d["workspaces"]) == 2 and sw["invites"] == [] and {m["email"] for m in sw["members"]} == {"sam@example.com", "pat@example.com"}
          and pat_dev.fp in sw["devices"], d)
    pj2, _ = sess_ok("pat@example.com", Device("phone", "pat-2"))
    check("second session: no longer 'joined'", pj2["joined"] == [])
    _, d, _, _ = http("GET", W + "/v1/directory", token=sam_pc)
    check("owner's invite list is empty after joining", d["workspaces"][0]["invites"] == [])

    # Option A
    eve_j, _ = sess_ok("eve@example.com", pc)
    eve_pc = eve_j["token"]
    eve_ws = eve_j["workspaces"][0]["id"]
    check("session: pc of another workspace reports it with member:false",
          eve_j.get("pc") == {"ws": sam_ws, "ws_name": "Sam's workspace", "owner": "Sam Rig", "member": False}, eve_j.get("pc"))
    st, js, _, _ = http("POST", W + "/v1/pcs", {"ws": eve_ws, "name": "stolen", "addrs": []}, token=eve_pc)
    check("Option A: third account is refused with 403 and the workspace name",
          st == 403 and js.get("ws") == sam_ws and js.get("ws_name") == "Sam's workspace" and js.get("owner") == "Sam Rig"
          and "Sam's workspace" in js.get("error", ""), js)
    _, d, _, _ = http("GET", W + "/v1/directory", token=sam_pc)
    check("Option A: refused PC stays where it was", d["workspaces"][0]["pcs"][0]["name"] == "desk")
    pat_pc_j, _ = sess_ok("pat@example.com", pc)
    pat_pc = pat_pc_j["token"]
    pat_personal = [w for w in pat_pc_j["workspaces"] if w["personal"]][0]["id"]
    st, js, _, _ = http("POST", W + "/v1/pcs", {"ws": pat_personal, "name": "moved", "addrs": ["h:1"]}, token=pat_pc)
    check("Option A: a member may move the PC", st == 200, js)
    _, d, _, _ = http("GET", W + "/v1/directory", token=pat_pc)
    check("moved PC is listed in the new workspace only",
          [w["pcs"] for w in d["workspaces"] if w["id"] == pat_personal][0][0]["name"] == "moved"
          and [w["pcs"] for w in d["workspaces"] if w["id"] == sam_ws][0] == [])
    st, js, _, _ = http("POST", W + "/v1/pcs", {"ws": sam_ws, "name": "desk", "addrs": ["10.0.0.5:47930"]}, token=pat_pc)
    check("member moves the PC back", st == 200)
    st, js, _, _ = http("DELETE", W + f"/v1/pcs/{pc.fp}", token=eve_pc)
    check("pcs delete: non-member refused", st == 403)
    st, js, _, _ = http("DELETE", W + "/v1/pcs/" + "0" * 64, token=sam_pc)
    check("pcs delete: unknown fp is 404", st == 404)

    # members
    st, js, _, _ = http("DELETE", W + f"/v1/workspaces/{sam_ws}/members/{pj['account']['id']}", token=pat_t)
    check("members: leave not blocked for self (pat can leave) ", st == 200, js)
    pj3, _ = sess_ok("pat@example.com", Device("phone", "pat-3"))
    check("left workspace is gone from the session (and invite not re-applied)", [w["id"] for w in pj3["workspaces"]].count(sam_ws) == 0, pj3["workspaces"])
    st, js, _, _ = http("POST", W + f"/v1/workspaces/{sam_ws}/invites", {"email": "pat@example.com"}, token=sam_pc)
    pj4, _ = sess_ok("pat@example.com", Device("phone", "pat-4"))
    pat_t = pj4["token"]
    pat_uid = pj4["account"]["id"]
    st, js, _, _ = http("DELETE", W + f"/v1/workspaces/{sam_ws}/members/{sam_ws}", token=pat_t)
    check("members: non-owner cannot remove another member", st == 403, js)
    st, js, _, _ = http("DELETE", W + f"/v1/workspaces/{sam_ws}/members/{pat_uid}", token=sam_pc)
    check("members: owner removes a member", st == 200 and js == {"ok": True}, js)
    _, d, _, _ = http("GET", W + "/v1/directory", token=pat_t)
    check("removed member's directory no longer lists that workspace", all(w["id"] != sam_ws for w in d["workspaces"]))
    http("POST", W + f"/v1/workspaces/{sam_ws}/invites", {"email": "alice@example.com"}, token=sam_pc)
    aj, _ = sess_ok("alice@example.com", Device("phone", "a2"))
    check("second invitee joins", [j["id"] for j in aj["joined"]] == [sam_ws])
    alice_personal = [w for w in aj["workspaces"] if w["personal"]][0]["id"]
    alice_uid = aj["account"]["id"]
    st, js, _, _ = http("DELETE", W + f"/v1/workspaces/{sam_ws}/members/{alice_uid}", token=aj["token"])
    check("members: leaving (self) ok", st == 200, js)
    st, js, _, _ = http("DELETE", W + f"/v1/workspaces/{alice_personal}/members/{alice_uid}", token=aj["token"])
    check("members: cannot leave own personal workspace (409)", st == 409, js)

    # device removal
    ext = Device("phone", "lost")
    sess_ok("alice@example.com", ext)
    st, js, _, _ = http("DELETE", W + f"/v1/devices/{ext.fp}", token=sam_pc)
    check("devices delete: owner of an unrelated user's device refused", st == 403, js)
    st, js, _, _ = http("DELETE", W + "/v1/devices/" + "1" * 64, token=sam_pc)
    check("devices delete: unknown is 404", st == 404)
    http("POST", W + f"/v1/workspaces/{sam_ws}/invites", {"email": "pat@example.com"}, token=sam_pc)
    pdev = Device("phone", "pat-lost")
    pj5, _ = sess_ok("pat@example.com", pdev)
    _, d, _, _ = http("GET", W + "/v1/directory", token=sam_pc)
    check("directory lists the member's device", pdev.fp in d["workspaces"][0]["devices"])
    st, js, _, _ = http("DELETE", W + f"/v1/devices/{pdev.fp}", token=eve_pc)
    check("devices delete: stranger refused", st == 403)
    st, js, _, _ = http("DELETE", W + f"/v1/devices/{pdev.fp}", token=sam_pc)
    check("devices delete: workspace owner may remove a member's device", st == 200 and js == {"ok": True}, js)
    _, d, _, _ = http("GET", W + "/v1/directory", token=sam_pc)
    check("directory no longer lists the removed device", pdev.fp not in d["workspaces"][0]["devices"])
    st, js, _, _ = http("DELETE", W + f"/v1/devices/{ext.fp}", token=alice_t)
    check("devices delete: own device ok", st == 200)

    # cleanup of PC, then Clerk-side expiry
    st, js, _, _ = http("DELETE", W + f"/v1/pcs/{pc.fp}", token=sam_pc)
    check("pcs delete: member ok", st == 200 and js == {"ok": True})
    http("POST", CLERK + "/test/expire", {"email": "sam@example.com"})
    st, js, _, _ = session(ct, pc)
    check("expired Clerk session: /v1/session is 401 with signin:true", st == 401 and js.get("signin") is True, js)
    st, js, _, _ = http("POST", CLERK + "/oauth/token", form=dict(grant_type="refresh_token", refresh_token="nope", client_id="harbor-test-client"))
    check("fake clerk: bad refresh token is invalid_grant", st == 400 and js["error"] == "invalid_grant")


def run():
    try:
        main()
    except BaseException as e:
        import traceback
        traceback.print_exc()
        results.append(("runner completed without exceptions", False))
    finally:
        stop_all()
        try:
            os.remove(os.path.join(WORKER, ".dev.vars"))
        except OSError:
            pass
    bad = [n for n, ok in results if not ok]
    print(f"\n{len(results) - len(bad)}/{len(results)} passed")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    run()
