import json, os, random, sqlite3, string, shutil, uuid
T=os.path.expanduser('~/.cache/hts/tmp')
src=f'{T}/harbor-copy.db'; dst=f'{T}/stripped.db'
shutil.copy(src,dst); os.chmod(dst,0o600)
db=sqlite3.connect(dst)
random.seed(7)
low=string.ascii_lowercase; up=string.ascii_uppercase
tbl={}
def sc(s):
    out=[]
    for c in s:
        if c in low: out.append(random.choice(low))
        elif c in up: out.append(random.choice(up))
        elif c in string.digits: out.append(random.choice(string.digits))
        elif ord(c)>127 and c.isalpha(): out.append(random.choice(low))
        else: out.append(c)
    return ''.join(out)
KEEP={'kind','is_error','icon'}
def walk(v,k=None):
    if isinstance(v,str): return v if k in KEEP else sc(v)
    if isinstance(v,list): return [walk(x) for x in v]
    if isinstance(v,dict): return {a:walk(b,a) for a,b in v.items()}
    return v
n=0
for cid,seq,body in db.execute('select chat_id,seq,body from items').fetchall():
    db.execute('update items set body=? where chat_id=? and seq=?',(json.dumps(walk(json.loads(body)),ensure_ascii=False),cid,seq)); n+=1
for (cid,title,name) in db.execute('select id,title,name from chats').fetchall():
    db.execute("update chats set title=?,name=?,session_id=?,gid=?,started=0,device='',home='',home_id=0,account='claude',model='claude-haiku-5-5',settled=1 where id=?",(sc(title),sc(name),str(uuid.uuid4()),uuid.uuid4().hex,cid))
for i,(rid,) in enumerate(db.execute('select id from repos').fetchall()):
    db.execute("update repos set name=?,path=?,remote='',local='' where id=?",(f'project{i}',f'/tmp/hts-project{i}-{rid}',rid))
for t in ('kv','timers','webhooks','procs'): db.execute(f'delete from {t}')
top=[r[0] for r in db.execute("select id from chats where parent is null and role!='sub' order by updated desc limit 21").fetchall()]
db.execute(f"update chats set settled=0,repo_id=(select min(id) from repos) where id in ({','.join(map(str,top))})")
db.commit()
db.execute('vacuum'); db.close()
db=sqlite3.connect(dst)
print('items',n,'open chats',len(top))
print('items in the 20 newest',db.execute(f"select count(*),sum(length(body)) from items where chat_id in ({','.join(map(str,top[:20]))})").fetchone())
print([r[0] for r in db.execute(f"select count(*) from items where chat_id in ({','.join(map(str,top))}) group by chat_id")])
