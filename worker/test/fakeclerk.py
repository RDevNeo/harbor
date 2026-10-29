#!/usr/bin/env python3
"""Fake Clerk for testing the Harbor accounts Worker: OAuth frontend + Backend API subset.

usage: fakeclerk.py [PORT] [--state FILE] [--redirect URL ...]
"""
import argparse, base64, hashlib, json, os, secrets, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, urlencode

CLIENT_ID = "harbor-test-client"
SECRET = "sk_test_fake"
LOCK = threading.RLock()
S = {"users": {}, "orgs": {}, "members": [], "invitations": [], "emails": [],
     "codes": {}, "access": {}, "refresh": {}, "next_login": None, "n": 0}
ARGS = None


def rid(prefix):
    return f"{prefix}_{secrets.token_hex(8)}"


def save():
    if ARGS.state:
        with open(ARGS.state, "w") as f:
            json.dump(S, f)


def load():
    if ARGS.state and os.path.exists(ARGS.state):
        with open(ARGS.state) as f:
            S.update(json.load(f))


def user_by_email(email):
    email = (email or "").lower()
    for u in S["users"].values():
        if any(e["email_address"].lower() == email for e in u["email_addresses"]):
            return u


def make_user(email, first="", last=""):
    u = user_by_email(email)
    if u:
        return u
    eid = rid("idn")
    uid = rid("user")
    first = first or email.split("@")[0].capitalize()
    u = {"id": uid, "first_name": first, "last_name": last, "image_url": "https://img.example/" + uid,
         "primary_email_address_id": eid,
         "email_addresses": [{"id": eid, "email_address": email, "verification": {"status": "verified"}}]}
    S["users"][uid] = u
    return u


def uemail(u):
    return u["email_addresses"][0]["email_address"]


def err(code, message, status=422):
    return status, {"errors": [{"code": code, "message": message, "long_message": message}]}


def member_json(m):
    u = S["users"][m["user_id"]]
    o = S["orgs"][m["org"]]
    return {"id": m["id"], "role": m["role"],
            "organization": {"id": o["id"], "name": o["name"], "public_metadata": o["public_metadata"]},
            "public_user_data": {"user_id": u["id"], "first_name": u["first_name"], "last_name": u["last_name"],
                                 "identifier": uemail(u), "image_url": u["image_url"]}}


def add_member(org, uid, role):
    m = {"id": rid("orgmem"), "org": org, "user_id": uid, "role": role}
    S["members"].append(m)
    return m


QUERY = {}


def api(method, parts, body):
    """Backend API under /v1; parts excludes the leading v1."""
    if parts == ["users"] and method == "GET":
        # Like Clerk: a plain array of the users with that email address.
        want = (QUERY.get("email_address") or "").lower()
        return 200, [u for u in S["users"].values() if any(e["email_address"].lower() == want for e in u["email_addresses"])]
    if parts[:1] == ["users"] and len(parts) == 2 and method == "GET":
        u = S["users"].get(parts[1])
        return (200, u) if u else err("resource_not_found", "User not found.", 404)
    if parts[:1] == ["users"] and len(parts) == 3 and parts[2] == "organization_memberships" and method == "GET":
        ms = [member_json(m) for m in S["members"] if m["user_id"] == parts[1]]
        return 200, {"data": ms, "total_count": len(ms)}
    if parts == ["organizations"] and method == "POST":
        if body.get("created_by") not in S["users"]:
            return err("resource_not_found", "Creator not found.", 404)
        oid = rid("org")
        name = body.get("name") or "Workspace"
        S["orgs"][oid] = {"id": oid, "name": name, "slug": name.lower().replace(" ", "-") + "-" + oid[-4:],
                          "public_metadata": body.get("public_metadata") or {},
                          "max_allowed_memberships": body.get("max_allowed_memberships", 5),
                          "created_by": body["created_by"]}
        add_member(oid, body["created_by"], "org:admin")
        return 200, S["orgs"][oid]
    if parts[:1] == ["organizations"] and len(parts) >= 2:
        o = S["orgs"].get(parts[1])
        if not o:
            return err("resource_not_found", "Organization not found.", 404)
        if len(parts) == 2:
            if method == "GET":
                return 200, o
            if method == "DELETE":
                del S["orgs"][parts[1]]
                S["members"] = [m for m in S["members"] if m["org"] != parts[1]]
                return 200, {"id": parts[1], "deleted": True}
        if parts[2:] == ["memberships"]:
            if method == "GET":
                ms = [member_json(m) for m in S["members"] if m["org"] == parts[1]]
                return 200, {"data": ms, "total_count": len(ms)}
            if method == "POST":
                uid = body.get("user_id")
                if uid not in S["users"]:
                    return err("resource_not_found", "User not found.", 404)
                if any(m["org"] == parts[1] and m["user_id"] == uid for m in S["members"]):
                    return err("already_a_member_in_organization", "The user is already a member of the organization.")
                if sum(1 for m in S["members"] if m["org"] == parts[1]) >= o["max_allowed_memberships"]:
                    return err("organization_membership_quota_exceeded", "The organization has reached its member limit.")
                return 200, member_json(add_member(parts[1], uid, body.get("role", "org:member")))
        if len(parts) == 4 and parts[2] == "memberships" and method == "DELETE":
            before = len(S["members"])
            S["members"] = [m for m in S["members"] if not (m["org"] == parts[1] and m["user_id"] == parts[3])]
            if len(S["members"]) == before:
                return err("resource_not_found", "Membership not found.", 404)
            return 200, {"deleted": True}
        if parts[2:] == ["invitations"] and method == "POST":
            # Like a real Google-only instance (no email addresses): POST /test/invitations {"on": false}.
            if S.get("no_invitations"):
                return err("invitations_not_supported", "Invitations are only supported on instances that accept email addresses.")
            email = (body.get("email_address") or "").lower()
            if not email:
                return err("form_param_missing", "email_address is required.")
            inv = {"id": rid("orginv"), "org": parts[1], "email_address": email, "status": "pending",
                   "inviter_user_id": body.get("inviter_user_id"), "role": body.get("role"),
                   "redirect_url": body.get("redirect_url")}
            S["invitations"].append(inv)
            S["emails"].append({"to": email, "org": parts[1], "org_name": o["name"], "invitation": inv["id"],
                                "at": int(time.time())})
            return 200, {"id": inv["id"], "email_address": email, "status": "pending"}
        if len(parts) == 5 and parts[2] == "invitations" and parts[4] == "revoke" and method == "POST":
            for inv in S["invitations"]:
                if inv["id"] == parts[3] and inv["org"] == parts[1]:
                    inv["status"] = "revoked"
                    return 200, {"id": inv["id"], "status": "revoked"}
            return err("resource_not_found", "Invitation not found.", 404)
    return err("resource_not_found", "Not found.", 404)


def b64u(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def issue(uid, client):
    S["n"] += 1
    a, r = "at_" + secrets.token_urlsafe(24), "rt_" + secrets.token_urlsafe(24)
    S["access"][a] = {"user": uid, "exp": time.time() + 86400}
    S["refresh"][r] = {"user": uid, "client": client}
    return {"access_token": a, "refresh_token": r, "id_token": "id." + secrets.token_hex(8) + ".x",
            "expires_in": 86400, "token_type": "Bearer"}


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def send(self, status, data=None, headers=None):
        raw = json.dumps(data).encode() if data is not None else b""
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(raw)

    def read_body(self):
        n = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(n).decode() if n else ""
        if "json" in (self.headers.get("content-type") or "") or raw.startswith("{"):
            try:
                return json.loads(raw or "{}")
            except ValueError:
                return {}
        return {k: v[0] for k, v in parse_qs(raw).items()}

    def handle_any(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        parts = [p for p in u.path.split("/") if p]
        m = self.command
        body = self.read_body() if m in ("POST", "PUT", "PATCH", "DELETE") else {}
        with LOCK:
            try:
                status, data, hdr = self.dispatch(m, u.path, parts, q, body)
            except Exception as e:  # keep the server alive for the test run
                status, data, hdr = 500, {"errors": [{"code": "fake_error", "message": repr(e)}]}, {}
            save()
        self.send(status, data, hdr)

    do_GET = do_POST = do_PUT = do_DELETE = do_PATCH = handle_any

    def bearer(self):
        a = self.headers.get("authorization") or ""
        return a[7:] if a.lower().startswith("bearer ") else ""

    def dispatch(self, m, path, parts, q, body):
        if path == "/google/certs" and m == "GET":
            return 200, {"keys": S.get("google_jwks", [])}, {}
        if parts[:1] == ["v1"]:
            QUERY.clear()
            QUERY.update(q)
            if self.bearer() != SECRET:
                return (*err("authorization_invalid", "Invalid secret key.", 401), {})
            return (*api(m, parts[1:], body), {})
        if parts[:1] == ["test"]:
            return (*self.test(m, parts, body), {})
        if path == "/oauth/authorize" and m == "GET":
            return self.authorize(q)
        if path == "/oauth/token" and m == "POST":
            return (*self.token(body), {})
        if path == "/oauth/userinfo" and m == "GET":
            a = S["access"].get(self.bearer())
            if not a or a["exp"] < time.time():
                return 401, {"error": "invalid_token"}, {}
            u = S["users"][a["user"]]
            return 200, {"sub": u["id"], "email": uemail(u), "email_verified": True,
                         "name": (u["first_name"] + " " + u["last_name"]).strip(), "given_name": u["first_name"],
                         "family_name": u["last_name"], "picture": u["image_url"]}, {}
        return 404, {"error": "not found"}, {}

    def authorize(self, q):
        redir = q.get("redirect_uri", "")
        if q.get("client_id") != CLIENT_ID:
            return 400, {"error": "invalid_client"}, {}
        if q.get("response_type") != "code" or q.get("code_challenge_method") != "S256" or not q.get("code_challenge"):
            return 400, {"error": "invalid_request"}, {}
        if not (redir.startswith("http://127.0.0.1:") or redir in ARGS.redirect):
            return 400, {"error": "invalid_redirect_uri"}, {}
        u = user_by_email(q["login_hint"]) if q.get("login_hint") else None
        if not u and S["next_login"]:
            u = user_by_email(S["next_login"])
        if not u and S["users"]:
            u = next(iter(S["users"].values()))
        if not u:
            return 400, {"error": "no_users"}, {}
        code = "code_" + secrets.token_urlsafe(16)
        S["codes"][code] = {"user": u["id"], "challenge": q["code_challenge"], "redirect": redir, "client": CLIENT_ID}
        out = {"code": code}
        if q.get("state"):
            out["state"] = q["state"]
        sep = "&" if "?" in redir else "?"
        return 302, None, {"location": redir + sep + urlencode(out)}

    def token(self, b):
        g = b.get("grant_type")
        if b.get("client_id") != CLIENT_ID:
            return 400, {"error": "invalid_client"}
        if g == "authorization_code":
            c = S["codes"].pop(b.get("code"), None)
            if not c or c["redirect"] != b.get("redirect_uri"):
                return 400, {"error": "invalid_grant"}
            v = b.get("code_verifier") or ""
            if b64u(hashlib.sha256(v.encode()).digest()) != c["challenge"]:
                return 400, {"error": "invalid_grant", "error_description": "PKCE check failed"}
            return 200, issue(c["user"], c["client"])
        if g == "refresh_token":
            r = S["refresh"].pop(b.get("refresh_token"), None)
            if not r:
                return 400, {"error": "invalid_grant"}
            return 200, issue(r["user"], r["client"])
        return 400, {"error": "unsupported_grant_type"}

    def test(self, m, parts, b):
        what = parts[1] if len(parts) > 1 else ""
        if what == "users" and m == "POST":
            if not b.get("email"):
                return 400, {"error": "email required"}
            return 200, make_user(b["email"], b.get("first_name", ""), b.get("last_name", ""))
        if what == "google-jwks" and m == "POST":
            S["google_jwks"] = b.get("keys", [])
            return 200, {"ok": True}
        if what == "invitations" and m == "POST":
            S["no_invitations"] = not b.get("on", True)
            return 200, {"ok": True}
        if what == "login" and m == "POST":
            S["next_login"] = b.get("email")
            return 200, {"ok": True}
        if what == "expire" and m == "POST":
            u = user_by_email(b.get("email"))
            if not u:
                return 404, {"error": "no such user"}
            S["access"] = {k: v for k, v in S["access"].items() if v["user"] != u["id"]}
            S["refresh"] = {k: v for k, v in S["refresh"].items() if v["user"] != u["id"]}
            return 200, {"ok": True}
        if what == "emails" and m == "GET":
            return 200, S["emails"]
        if what == "state" and m == "GET":
            return 200, S
        return 404, {"error": "unknown test route"}


def main():
    global ARGS
    p = argparse.ArgumentParser()
    p.add_argument("port", nargs="?", type=int, default=47995)
    p.add_argument("--state")
    p.add_argument("--redirect", action="append", default=[])
    ARGS = p.parse_args()
    load()
    srv = ThreadingHTTPServer(("127.0.0.1", ARGS.port), H)
    srv.daemon_threads = True
    print(f"fakeclerk on 127.0.0.1:{ARGS.port}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
