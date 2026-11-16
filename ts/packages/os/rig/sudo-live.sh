#!/bin/bash
# Harbor's passwordless sudo on a real Linux, on a throwaway boat sandbox ONLY (it adds a user, a polkit rule and
# sudoers files): `scripts/boat/windows sh 'bash ts/packages/os/rig/sudo-live.sh'` (the Linux side of that session).
# Never on anyone's PC: it refuses to run unless the machine looks like a boat sandbox (/home/user/src).
set -u
[ -d /home/user/src ] && [ "$(id -un)" = user ] || { echo "sudo-live.sh: only on a boat sandbox"; exit 99; }
src=/home/user/src/ts
t=harbortest
pw='harbor-Test-pw-1'
ok=0 bad=0
check() { if eval "$2"; then echo "PASS $1"; ok=$((ok + 1)); else echo "FAIL $1"; bad=$((bad + 1)); fi; }
as_t() { sudo -u "$t" -H env HOME=/home/$t XDG_STATE_HOME=/home/$t/.local/state "$@"; }
bun=$(command -v bun)
sudo install -m 0755 "$bun" /usr/local/bin/bun
sudo apt-get install -y -q policykit-1 >/dev/null 2>&1 || sudo apt-get install -y -q polkitd pkexec >/dev/null 2>&1 || true
echo "--- $(. /etc/os-release; echo "$PRETTY_NAME"); sudo $(sudo -V | head -1); pkexec: $(command -v pkexec || echo none)"
grep -E 'includedir' /etc/sudoers

sudo userdel -r "$t" >/dev/null 2>&1 || true
sudo rm -f /etc/sudoers.d/harbor-$t /etc/polkit-1/rules.d/49-harbortest.rules
sudo useradd -m -s /bin/bash "$t"
echo "$t:$pw" | sudo chpasswd
sudo usermod -aG sudo "$t" 2>/dev/null || sudo usermod -aG wheel "$t"
sudo cp -r "$src" /home/$t/ts && sudo chown -R "$t" /home/$t/ts
run() { as_t /usr/local/bin/bun /home/$t/ts/packages/os/rig/sudo-live.ts "$@"; }

echo "=== 1. a user whose sudo asks for a password"
check "sudo -n true fails before" "! as_t sudo -n true 2>/dev/null"
run state

echo "=== 2. no polkit agent: pkexec can't ask (Harbor says so and points to the terminal)"
out=$(run auto 0.188.0); echo "$out"
check "auto: no prompt possible, nothing written" "echo \"\$out\" | grep -q 'harbor admin on' && ! sudo test -e /etc/sudoers.d/harbor-$t"
check "the decline is remembered for 0.188" "as_t cat /home/$t/.local/state/harbor/admin-choice.json | grep -q '\"declined\":\"0.188\"'"
out=$(run auto 0.188.5); echo "$out"
check "same minor version: not asked again" "[ \"\$(echo \"\$out\" | tail -1)\" = null ]"

echo "=== 3. a polkit agent that says yes (a test rule standing in for the person typing the password)"
if [ -d /etc/polkit-1/rules.d ] && command -v pkexec >/dev/null && pgrep -x polkitd >/dev/null; then
  echo "polkit.addRule(function(a, s) { if (a.id == 'org.freedesktop.policykit.exec' && s.user == '$t') return polkit.Result.YES; });" | sudo tee /etc/polkit-1/rules.d/49-harbortest.rules >/dev/null
  sleep 2
  out=$(run auto 0.189.0); echo "$out"
  check "auto in the next minor version: asked through pkexec, rule written" "sudo test -f /etc/sudoers.d/harbor-$t && as_t sudo -n true"
  sudo rm -f /etc/polkit-1/rules.d/49-harbortest.rules
  run off >/dev/null
else
  echo "SKIP 3: no polkit daemon running here (pkexec can't authorize anything without it: section 2 is what Harbor does then)"
fi

echo "=== 4. harbor admin on from a terminal: sudo asks there (the password on stdin here, as a person types it)"
script=$(as_t /usr/local/bin/bun -e 'console.log((await import("/home/'$t'/ts/packages/os/src/sudo.ts")).ROOT_SCRIPT)')
echo "$pw" | as_t sudo -S -p '' /bin/sh -c "$script" sh on /etc/sudoers.d harbor-$t $t
check "the root script through sudo: rule in, sudo -n works" "as_t sudo -n true"
check "the rule is root's, 0440, and reads as Harbor's" "[ \"\$(sudo stat -c '%U %a' /etc/sudoers.d/harbor-$t)\" = 'root 440' ] && sudo grep -qx '$t ALL=(ALL) NOPASSWD: ALL' /etc/sudoers.d/harbor-$t"
check "visudo -c is happy with the whole configuration" "sudo visudo -c >/dev/null"
check "no temporary file left in sudoers.d" "[ -z \"\$(sudo find /etc/sudoers.d -name '.harbor.*')\" ]"
as_t mkdir -p /home/$t/.local/state/harbor
echo '{"exe":"/etc/sudoers.d/harbor-'$t'","login":false,"since":1}' | as_t tee /home/$t/.local/state/harbor/run-as-admin.json >/dev/null
run status

echo "=== 5. harbor admin off: no password needed while the rule is there"
out=$(run off terminal < /dev/null); echo "$out"
check "off removed the rule with sudo -n (no password)" "! sudo test -e /etc/sudoers.d/harbor-$t && ! as_t sudo -n true 2>/dev/null"
check "off is remembered" "as_t cat /home/$t/.local/state/harbor/admin-choice.json | grep -q '\"off\":true'"
out=$(run auto 0.190.0); echo "$out"
check "after off, a later version doesn't ask" "[ \"\$(echo \"\$out\" | tail -1)\" = null ]"

echo "=== 6. a broken rule never goes in"
check "visudo refuses a rule that doesn't parse, nothing written, sudo intact" "! echo '$pw' | as_t sudo -S -p '' /bin/sh -c \"\$script\" sh on /etc/sudoers.d harbor-$t 'bad user' >/dev/null 2>&1 && ! sudo test -e /etc/sudoers.d/harbor-$t && sudo visudo -c >/dev/null"

echo "=== 7. a user with passwordless sudo already: nothing asked, nothing written"
out=$(XDG_STATE_HOME=$(mktemp -d) bun "$src/packages/os/rig/sudo-live.ts" auto 0.188.0); echo "$out"
check "user (NOPASSWD already): auto does nothing" "[ \"\$(echo \"\$out\" | tail -1)\" = null ] && ! sudo test -e /etc/sudoers.d/harbor-user"
out=$(XDG_STATE_HOME=$(mktemp -d) bun "$src/packages/os/rig/sudo-live.ts" status); echo "$out"
check "status says the rule isn't Harbor's" "echo \"\$out\" | grep -q \"isn't Harbor's\""

echo "=== 8. install.sh --uninstall removes Harbor's rule"
echo "$pw" | as_t sudo -S -p '' /bin/sh -c "$script" sh on /etc/sudoers.d harbor-$t $t
as_t mkdir -p /home/$t/.local/state/harbor
echo '{"exe":"/etc/sudoers.d/harbor-'$t'","login":false,"since":1}' | as_t tee /home/$t/.local/state/harbor/run-as-admin.json >/dev/null
sudo install -m 0644 /home/user/src/packaging/install.sh /home/$t/install.sh
as_t sh /home/$t/install.sh --uninstall
check "uninstall: rule gone, marker gone" "! sudo test -e /etc/sudoers.d/harbor-$t && ! as_t test -e /home/$t/.local/state/harbor/run-as-admin.json"

sudo userdel -r "$t" >/dev/null 2>&1 || true
echo "=== $ok passed, $bad failed"
[ "$bad" = 0 ]
