#!/bin/bash
set -u
ip link set lo up
[ "$(ip -o link show | wc -l)" = 1 ] || { echo "refusing to run outside unshare -Urn (a network interface is visible)" >&2; exit 99; }
B=${HARBOR_REF:?a Rust harbor 0.108.0 binary}
BUN=${BUN:-$(command -v bun)}; TS=$(cd "$(dirname "$0")/../../.." && pwd); RIG=$TS/packages/store/rig
T=${RIG_TMP:?a scratch folder}; [ -n "${SKIP_RUN:-}" ] || { rm -rf $T; mkdir -p $T/{home,data/harbor,state,cfg,cache,run}; chmod 700 $T/run; }
export HOME=$T/home XDG_DATA_HOME=$T/data XDG_STATE_HOME=$T/state XDG_CONFIG_HOME=$T/cfg XDG_CACHE_HOME=$T/cache XDG_RUNTIME_DIR=$T/run HARBOR_SOCK=$T/run/h.sock
export HARBOR_PROFILE_RULES=1 HARBOR_TEST_NO_SIGNIN=1 HARBOR_NO_TRAY=1 HARBOR_LISTEN=127.0.0.1 TZ=UTC PATH=$RIG/fakeclaude:/usr/bin:/bin:$(dirname "$BUN")
unset WAYLAND_DISPLAY DISPLAY
DB=$T/data/harbor/harbor.db; TOK=0123456789abcdef0123456789abcdef0123456789abcdef; fail=0
[ -n "${SKIP_RUN:-}" ] || mkdir -p $T/home/elsewhere && echo hi > $T/home/elsewhere/README.md; mkdir -p $T/home/proj/src $T/home/proj/.claude/commands $T/home/.claude $T/home/.claude2
[ -n "${SKIP_RUN:-}" ] || { echo '{}' > $T/home/.claude/.credentials.json; touch $T/home/proj/README.md $T/home/proj/src/app.ts $T/home/proj/src/util.ts; printf -- '---\ndescription: Say hi\n---\nHello $ARGUMENTS\n' > $T/home/proj/.claude/commands/hi.md; (cd $T/home/proj && git init -q -b main && git add -A && git -c user.name=t -c user.email=t@example.com commit -q -m one && git branch feature); cp -a $T/home/proj $T/proj-pristine; }
echo '{"oauthAccount":{"emailAddress":"two@example.com","displayName":"Two"}}' > $T/home/.claude2/.claude.json
if [ -n "${SKIP_RUN:-}" ]; then IDS=$(cat $T/ids.txt); else IDS=$(cd $TS && "$BUN" $RIG/chatstate.ts make $T/home/proj "Sam Lee"); echo "$IDS" > $T/ids.txt; cp $DB $T/fixture.db; fi
id() { echo "$IDS" | sed -E "s/.*\"$1\":([0-9]+).*/\1/"; }
LIM1=$(id lim1); LIM2=$(id lim2); NOF=$(id nof); FAR=$(id far); NEAR=$(id near)
PLAIN=$(id plain); FAILING=$(id failing); LEAD=$(id lead); SUB=$(id sub); OTHER=$(id other)
ok() { echo "PASS $*"; }
bad() { echo "FAIL $*"; fail=1; }
get() { curl -s --max-time 30 -H "Authorization: Bearer $TOK" "http://127.0.0.1:47930$1" > "$2"; }
post() { curl -s --max-time 30 -H "Authorization: Bearer $TOK" -X POST -d "$2" "http://127.0.0.1:47930$1" > /dev/null; }
up() { for i in $(seq 60); do curl -s -o /dev/null http://127.0.0.1:47930/ && { get /v1/state /dev/null; sleep 2; return 0; }; sleep 0.2; done; return 1; }
statuses() {
  for n in lead:$LEAD sub:$SUB lim1:$LIM1 lim2:$LIM2 nof:$NOF far:$FAR near:$NEAR; do
    get "/v1/chats/${n#*:}/items?since=0" $T/$1-$2-${n%%:*}.full.json; "$BUN" $RIG/chatstate.ts status $T/$1-$2-${n%%:*}.full.json > $T/$1-$2-${n%%:*}.st.json
  done
}
sample() { get /v1/state $T/$1-$2.full.json; "$BUN" $RIG/chatstate.ts pick $T/$1-$2.full.json > $T/$1-$2.json; }
field() { python3 -c "import json,sys; r={c['id']:c for c in json.load(open('$1'))}; print(r[$2]['$3'])"; }
scenario() {
  tag=$1
  rm -f $DB $DB-wal $DB-shm; cp $T/fixture.db $DB
  rm -rf $T/data/harbor/worktrees $T/home/proj; cp -a $T/proj-pristine $T/home/proj
  if [ $tag = rust ]; then "$B" --background > $T/$tag.log 2>&1 & APP=$!; else (cd $TS && exec "$BUN" harbor.ts --background > $T/$tag.log 2>&1) & APP=$!; fi
  up || bad "$tag did not start"
  sample $tag 0; statuses $tag s0
  post /v1/chats/$PLAIN/send '{"text":"hello"}'; post /v1/chats/$FAILING/send '{"text":"boom"}'; post /v1/chats/$OTHER/send '{"text":"hello"}'
  sleep 5; sample $tag 1
  get "/v1/chats/$FAILING/items?since=0" /dev/null; sample $tag 2
  post /v1/chats/$SUB/send '{"text":"hold on"}'
  sleep 1; post /v1/chats/$SUB/send '{"text":"later","mode":"queue"}'; sleep 1; sample $tag 3; statuses $tag s3
  post /v1/chats/$LEAD/send '{"text":"hold lead"}'; sleep 1; sample $tag 3b; statuses $tag s3b
  sleep 10; sample $tag 4; statuses $tag s4
  get /v1/usage /dev/null; sleep 2
  for r in app hubs snooze usage people tags slash voice versions inbox apps/discord chats/$LEAD/team chats/$PLAIN/move_targets chats/$PLAIN/slash chats/$PLAIN/tags chats/$PLAIN/mention; do
    get "/v1/$r" $T/$tag-route-$(echo $r | tr / _).json
  done
  act() { n=$1; m=$2; u=$3; b=${4:-}; curl -s --max-time 30 -H "Authorization: Bearer $TOK" -X $m -d "$b" "http://127.0.0.1:47930$u" | sed -E 's/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/<gid>/g' > $T/$tag-act-$n.json; }
  act snooze_get GET "/v1/snooze?text=18:00&off=0&chat=$PLAIN"
  act snooze_bad POST /v1/chats/$PLAIN/snooze '{"text":"soon"}'
  act snooze_set POST /v1/chats/$PLAIN/snooze '{"text":"18:00","off":0}'
  act snooze_get2 GET "/v1/snooze?chat=$PLAIN&off=0"
  get /v1/state $T/$tag-act-state-snoozed.full.json
  act snooze_del DELETE /v1/chats/$PLAIN/snooze
  act main_sub POST /v1/chats/$SUB/main
  act main_lead POST /v1/chats/$LEAD/main
  act fork_bad POST /v1/chats/$PLAIN/fork '{}'
  act fork_early POST /v1/chats/$PLAIN/fork '{"seq":0}'
  act fork POST /v1/chats/$PLAIN/fork '{"seq":1}'
  act continue_on_bad POST /v1/chats/$LIM1/continue_on '{"account":"zzz"}'
  act cancel_limit POST /v1/chats/$LIM2/cancel_limit
  act stop_all POST /v1/chats/$LEAD/stop_all '{}'
  act retire_lead POST /v1/chats/$LEAD/retire
  act retire_sub POST /v1/chats/$SUB/retire
  act gmail_info GET /v1/apps/gmail
  act move_targets_sub GET /v1/chats/$SUB/move_targets
  act commit_bad GET /v1/chats/$PLAIN/commit/zzzz
  act commit_none GET /v1/chats/$NOF/commit/abcdef1
  act gmail_bad POST /v1/apps/gmail/default '{"email":"nobody@example.com"}'
  act gmail_unknown POST /v1/apps/gmail/nope
  act discord_unknown POST /v1/apps/discord/nope
  act discord_signin POST /v1/apps/discord/signin
  act hub_auto_bad POST /v1/hub/auto
  act hub_auto POST /v1/hub/auto '{"on":false}'
  act hub_check POST /v1/hub/check
  act voice_cleanup POST /v1/voice/cleanup '{"text":"hello there my friend"}'
  act voice_settings PUT /v1/voice/settings '{"cleanup":false,"keep_loaded_min":7,"commands":false}'
  act mention_get GET "/v1/chats/$PLAIN/mention?seq=0"
  act mention_bad GET "/v1/chats/$PLAIN/mention?seq=99"
  act mention_post POST /v1/chats/$PLAIN/mention '{"seq":0,"text":"hel"}'
  act mention_all POST /v1/chats/$PLAIN/mention '{"seq":0,"text":"hello"}'
  act mention_empty POST /v1/chats/$PLAIN/mention '{"seq":0,"text":"  "}'
  act team_sub GET /v1/chats/$SUB/team
  act slash_plan POST /v1/chats/$PLAIN/slash '{"command":"plan"}'
  act slash_default POST /v1/chats/$PLAIN/slash '{"command":"default"}'
  act slash_model POST /v1/chats/$PLAIN/slash '{"command":"model"}'
  act slash_nope POST /v1/chats/$PLAIN/slash '{"command":"x"}'
  act slash_clear POST /v1/chats/$PLAIN/slash '{"command":"clear-queue"}'
  act slash_fork POST /v1/chats/$OTHER/slash '{"command":"fork"}'
  act slash_settle POST /v1/chats/$OTHER/slash '{"command":"settle"}'
  act slash_chat GET /v1/chats/$PLAIN/slash
  act slash_draft GET "/v1/slash?account=claude&access=plan&project=$(echo $IDS | sed -E 's/.*/1/')"
  act tags_chats GET "/v1/tags?trigger=\$&q="
  act tags_chats_q GET "/v1/chats/$PLAIN/tags?trigger=\$&q=lim"
  act tags_files_first GET "/v1/chats/$PLAIN/tags?trigger=@&q="
  sleep 2
  act tags_files GET "/v1/chats/$PLAIN/tags?trigger=@&q=app"
  act tags_files_all GET "/v1/tags?trigger=@&project=1&q="
  act tags_refs GET "/v1/chats/$PLAIN/tags?trigger=%23&q="
  act palette_q GET "/v1/palette?q=lim&chat=$PLAIN"
  act palette_run_bad POST /v1/palette/run '{"id":"nope"}'
  act palette_run_page POST /v1/palette/run '{"id":"page:prs"}'
  act palette_run_fast POST /v1/palette/run '{"id":"act:fast:on"}'
  act palette_run_settle POST /v1/palette/run "{\"id\":\"act:settle:$PLAIN\",\"chat\":$PLAIN}"
  act palette_run_fork POST /v1/palette/run "{\"id\":\"act:fork:$OTHER\",\"chat\":$OTHER}"
  act palette_after GET "/v1/palette?q=settled&chat=$PLAIN"
  act people_detect PATCH /v1/people '{"op":"detect"}'
  sleep 3
  act people_detected GET /v1/people
  act people_set PATCH /v1/people '{"owner":"Sam Lee","github":"samlee","send_context":false,"share_github":false,"share":{"pc":"pc:far","level":"read"}}'
  act people_confirm PATCH /v1/people '{"op":"confirm"}'
  act patch_title PATCH /v1/chats/$PLAIN '{"title":"  A new title  "}'
  act patch_empty PATCH /v1/chats/$PLAIN '{"title":"   "}'
  act patch_settled PATCH /v1/chats/$OTHER '{"settled":false}'
  act patch_run PATCH /v1/chats/$FAILING '{"access":"plan"}'
  act patch_bad PATCH /v1/chats/$FAILING '{"access":"root"}'
  act create_ok POST /v1/chats '{"project_id":1,"title":"  Made by phone  "}'
  act create_main POST /v1/chats '{"project_id":1,"main":true}'
  act create_bad_project POST /v1/chats '{"project_id":999}'
  act create_bad_path POST /v1/chats '{"project_id":"/nope"}'
  act create_bad_account POST /v1/chats '{"account":"nope"}'
  act create_codex POST /v1/chats '{"account":"codex"}'
  act create_bad_effort POST /v1/chats '{"effort":"turbo"}'
  act create_bad_access POST /v1/chats '{"access":"root"}'
  act create_bad_upload POST /v1/chats '{"text":"x","files":["nope"]}'
  act create_opened POST /v1/chats '{"project_id":1,"title":"Opened","opened_from":{"gid":"11111111-2222-4333-8444-555555555555","title":"Parent"}}'
  act create_project POST /v1/chats "{\"project\":{\"path\":\"$T/home/proj\",\"name\":\"proj\",\"remote\":\"\"}}"
  act create_project_unknown POST /v1/chats '{"project":{"path":"/x/y","name":"zzz","remote":""}}'
  act create_project_remote POST /v1/chats '{"project":{"path":"/x/yy","name":"zzz","remote":"git@github.com:o/zzz.git"}}'
  act create_fast POST /v1/chats '{"fast":true}'
  act create_device POST /v1/chats '{"device":"pc:far","title":"On far"}'
  act move_none POST /v1/chats/$PLAIN/move '{"repo":null}'
  act move_path POST /v1/chats/$PLAIN/move "{\"repo\":\"$T/home/proj\"}"
  act move_bad POST /v1/chats/$PLAIN/move '{"repo":999}'
  act move_missing POST /v1/chats/$PLAIN/move '{}'
  act continue_on POST /v1/chats/$LIM1/continue_on '{"account":"claude"}'
  act ws_chat GET "/v1/workspace?chat=$PLAIN"
  act ws_draft GET "/v1/workspace?project=1&worktree=1&base=feature"
  act ws_none GET "/v1/workspace?chat=$NOF"
  act ws_bad GET "/v1/workspace?chat=99999"
  act br_list GET "/v1/branches?chat=$PLAIN"
  act br_q GET "/v1/branches?project=1&q=fea"
  act br_new GET "/v1/branches?project=1&q=brand-new"
  act br_bad GET "/v1/branches?chat=$NOF"
  act br_none POST /v1/branches '{}'
  act br_create POST /v1/branches "{\"chat\":$PLAIN,\"create\":\"topic\"}"
  act br_switch POST /v1/branches "{\"chat\":$PLAIN,\"switch\":\"main\"}"
  act br_switch_bad POST /v1/branches "{\"chat\":$PLAIN,\"switch\":\"nope\"}"
  act wt_move POST /v1/chats/$PLAIN/worktree
  act wt_again POST /v1/chats/$PLAIN/worktree
  act ws_after GET "/v1/workspace?chat=$PLAIN"
  act wt_rename_branch POST /v1/chats/$PLAIN/worktree/rename '{"branch":"harbor/renamed-one","remote":false}'
  act ws_after_rename GET "/v1/workspace?chat=$PLAIN"
  act wt_rename_folder POST /v1/chats/$PLAIN/worktree/rename '{"folder":"my-folder"}'
  act wt_rename_bad POST /v1/chats/$PLAIN/worktree/rename '{"folder":"a/b"}'
  act wt_rename_none POST /v1/chats/$PLAIN/worktree/rename '{}'
  act ws_after_folder GET "/v1/workspace?chat=$PLAIN"
  act create_wt POST /v1/chats '{"project_id":1,"worktree":true,"title":"Fix the login bug"}'
  act create_wt_nogit POST /v1/chats '{"worktree":true,"title":"No project"}'
  act clone_bad POST /v1/chats/$NOF/clone '{"path":"x"}'
  act clone_here POST /v1/chats/$PLAIN/clone '{"path":"/tmp/x"}'
  act clone_fail POST /v1/chats/$NOF/clone "{\"path\":\"$T/home/nothing\"}"
  sleep 2
  act clone_status GET "/v1/chats/$NOF/items?since=0"
  act clone_ok POST /v1/chats/$NOF/clone "{\"path\":\"$T/home/elsewhere\"}"
  sleep 2
  act clone_status2 GET "/v1/chats/$NOF/items?since=0"
  act run_on_off POST /v1/chats/$NEAR/run_on
  act run_on_none POST /v1/chats/$PLAIN/run_on
  sleep 3
  for c in 2 14 15 16 17 18 19 20; do act items_$c GET "/v1/chats/$c/items?since=0"; done
  get /v1/state $T/$tag-act-state-end.full.json
  kill $APP 2>/dev/null; wait $APP 2>/dev/null
}
[ -n "${SKIP_RUN:-}" ] || { scenario rust; scenario ts; }
for n in 0 1 2 3 3b 4; do
  if cmp -s $T/rust-$n.json $T/ts-$n.json; then ok "sample $n: Rust and TS give the same pr, unread, failed, working and running for all 5 chats"; else bad "sample $n differs"; diff <(python3 -m json.tool $T/rust-$n.json) <(python3 -m json.tool $T/ts-$n.json) | head -20; fi
done
for n in 0 3b 4; do
  d=$("$BUN" $RIG/dbswap.ts statediff $T/rust-$n.full.json $T/ts-$n.full.json | tail -1)
  case "$d" in *" 0 kinds"*) ok "/v1/state at sample $n: no difference between Rust and TS";; *) bad "/v1/state at sample $n: $d"; "$BUN" $RIG/dbswap.ts statediff $T/rust-$n.full.json $T/ts-$n.full.json | head;; esac
done
for f in $(cd $T && ls rust-route-*.json); do
  d=$("$BUN" $RIG/dbswap.ts statediff $T/$f $T/ts-${f#rust-} | tail -1)
  case "$d" in *" 0 kinds"*) ok "${f#rust-route-}: same";; *) bad "${f#rust-route-}: $d"; "$BUN" $RIG/dbswap.ts statediff $T/$f $T/ts-${f#rust-} | head -8;; esac
done
for f in $(cd $T && ls rust-act-*.json | grep -v "\.full\.json"); do
  n=${f#rust-act-}
  d=$("$BUN" $RIG/dbswap.ts statediff $T/$f $T/ts-act-$n sort | tail -1)
  case "$d" in *" 0 kinds"*) ok "action ${n%.json}: $(head -c 90 $T/$f)";; *) bad "action ${n%.json} differs"; "$BUN" $RIG/dbswap.ts statediff $T/$f $T/ts-act-$n sort | head -10;; esac
done
for n in snoozed end; do
  d=$("$BUN" $RIG/dbswap.ts statediff $T/rust-act-state-$n.full.json $T/ts-act-state-$n.full.json byid,sort | tail -1)
  case "$d" in *" 0 kinds"*) ok "/v1/state after the actions ($n): no difference";; *) bad "/v1/state after the actions ($n): $d"; "$BUN" $RIG/dbswap.ts statediff $T/rust-act-state-$n.full.json $T/ts-act-state-$n.full.json byid,sort | head;; esac
done
for n in s0 s3 s3b s4; do for w in lead sub lim1 lim2 nof far near; do
  if cmp -s $T/rust-$n-$w.st.json $T/ts-$n-$w.st.json; then ok "status $n of $w: Rust and TS say the same"; else bad "status $n of $w differs"; diff <(python3 -m json.tool $T/rust-$n-$w.st.json) <(python3 -m json.tool $T/ts-$n-$w.st.json) | head -20; fi
done; done
st() { python3 -c "import json; v=json.load(open('$T/rust-$1-$2.st.json'))
for k in '$3'.split('.'): v=v[int(k)] if k.isdigit() else (v or {}).get(k)
print(json.dumps(v) if not isinstance(v,str) else v)"; }
stchk() { r=$(st $1 $2 $3); case "$r" in *"$4"*) ok "Rust $1 $2 $3 has $4";; *) bad "Rust $1 $2 $3 is $r, expected $4";; esac; }
stchk s0 lim1 limit.text "Usage limit · resets"; stchk s0 lim1 limit.can_cancel false; stchk s0 lim1 limit.targets.0.id claude
stchk s0 lim2 limit.can_cancel true; stchk s0 lim2 limit.text "continuing at"
stchk s0 nof folder.text "gone's folder"; stchk s0 nof folder.action "Use a folder here"; stchk s0 lead folder null; stchk s0 near folder.text "it's on"; stchk s0 near folder.owner.id pc:far; stchk s0 near folder.action "Use a folder here"
stchk s3 lead waiting.agents.0.name worker; stchk s3 lead agents.title "1 agent working"; stchk s3 lead working null; stchk s3 sub working.subagents 0
stchk s3b lead working.subagents 1; stchk s3b lead working.text "1 sub-agent running"; stchk s3b lead waiting null; stchk s3b lead agents.rows.0.task Sub
echo "== the fixture is not at its defaults (Rust's own answers)"
chk() { [ "$(field $T/rust-$1.json $2 $3)" = "$4" ] && ok "Rust sample $1: chat $2 $3 = $4" || bad "Rust sample $1: chat $2 $3 is $(field $T/rust-$1.json $2 $3), expected $4"; }
chk 0 $OTHER pr "{'label': 'PR #3 · Merged', 'number': 3, 'state': 'merged', 'title': 'Old', 'url': 'https://github.com/o/r/pull/3'}"
chk 0 $PLAIN pr None
chk 1 $PLAIN unread True; chk 1 $PLAIN failed False
chk 1 $FAILING unread True; chk 1 $FAILING failed True
chk 2 $FAILING unread False; chk 2 $FAILING failed False; chk 2 $PLAIN unread True
chk 3 $SUB running True; chk 3b $LEAD running True; chk 3 $LEAD running False; chk 3 $SUB queued 1; chk 3 $LEAD queued 0; chk 4 $SUB queued 0; chk 3 $LEAD working True; chk 3 $PLAIN working False
chk 4 $LEAD working False
echo; [ $fail = 0 ] && echo "ALL PASS" || echo "SOME FAILED"; exit $fail
