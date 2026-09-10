#!/usr/bin/env bash
# Exercise the actual exact-PR resolver with local Git and stub forge CLIs; no network/agents.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
python3 - "$root/examples/agent-bin/review-loop.sh" <<'PY'
import json, os, shutil, subprocess, sys, tempfile
from pathlib import Path
source=Path(sys.argv[1]).read_text()
start=source.index('resolve_review_pr() {')
resolver=source[start:source.index('\n}\n',start)+3]
real_git=shutil.which('git')
with tempfile.TemporaryDirectory(prefix='review-pr-scope-') as temp:
    root=Path(temp); repo=root/'repo'; repo.mkdir(); bindir=root/'bin'; bindir.mkdir()
    env=dict(os.environ, GIT_CONFIG_NOSYSTEM='1',GIT_CONFIG_GLOBAL='/dev/null')
    def git(*args):
        return subprocess.check_output([real_git,'-C',str(repo),*args],env=env,stderr=subprocess.DEVNULL,text=True).strip()
    git('init','-b','feature');git('config','user.name','Test');git('config','user.email','test@example.invalid')
    (repo/'file').write_text('base\n');git('add','file');git('commit','-m','base');base=git('rev-parse','HEAD')
    (repo/'file').write_text('feature\n');git('commit','-am','feature');head=git('rev-parse','HEAD')
    git('update-ref','refs/remotes/origin/main',head) # Misleading local default must not narrow the review.
    api=root/'api.json';calls=root/'calls';driver=root/'driver.sh'
    driver.write_text('''set -euo pipefail
prog=review-loop
dir="$TEST_REPO"
base="${TEST_BASE:-}"
target="${TEST_TARGET:-auto}"
review_pr="$TEST_URL"
MR_CTX_DONE=0; MR_TARGET_BRANCH=wrong; MR_PR_NUMBER=999
_tmo() { shift; "$@"; }
die() { echo "$*" >&2; exit 2; }
die_usage() { die "$@"; }
'''+resolver+'''\nresolve_review_pr
printf 'RESULT:%s|%s|%s|%s|%s\\n' "$base" "$target" "$MR_CTX_DONE" "$MR_TARGET_BRANCH" "$MR_PR_NUMBER"
''')
    forge='''#!/usr/bin/env python3
import json,os,sys
from pathlib import Path
with open(os.environ['TEST_CALLS'],'a') as f:f.write(json.dumps([Path(sys.argv[0]).name,*sys.argv[1:]])+'\\n')
if os.environ.get('TEST_API_ERROR'):sys.exit(1)
print(Path(os.environ['TEST_API']).read_text())
'''
    for name in ['gh','glab']:
        p=bindir/name;p.write_text(forge);p.chmod(0o700)
    p=bindir/'curl'
    p.write_text('''#!/usr/bin/env python3
import json,os,sys
from pathlib import Path
with open(os.environ['TEST_CALLS'],'a') as f:f.write(json.dumps(['curl',*sys.argv[1:]])+'\\n')
if not os.environ.get('TEST_PUBLIC'):sys.exit(1)
print(Path(os.environ['TEST_API']).read_text())
''');p.chmod(0o700)
    p=bindir/'git'
    p.write_text('''#!/usr/bin/env python3
import json,os,sys
args=sys.argv[1:]
if 'fetch' in args:
    with open(os.environ['TEST_CALLS'],'a') as f:f.write(json.dumps(['git',*args])+'\\n')
    sys.exit(1) # Deliberately refuse all network access, including invalid metadata cases.
os.execv(os.environ['TEST_REAL_GIT'],[os.environ['TEST_REAL_GIT'],*args])
''');p.chmod(0o700)
    env.update(PATH=f"{bindir}:{env['PATH']}",TEST_REPO=str(repo),TEST_API=str(api),TEST_CALLS=str(calls),TEST_REAL_GIT=real_git)
    gh_url='https://github.com/owner/repo/pull/123'
    gh={'html_url':gh_url,'number':123,'state':'open','merged':False,'base':{'sha':base},'head':{'sha':head}}
    gl_url='https://gitlab.example/group/sub/repo/-/merge_requests/456'
    gl={'web_url':gl_url,'iid':456,'state':'opened','sha':head,'diff_refs':{'base_sha':base,'head_sha':head}}
    count=0
    def run(name,data=gh,url=gh_url,ok=False,**settings):
        global count
        api.write_text(data if isinstance(data,str) else json.dumps(data));calls.write_text('')
        e=dict(env,TEST_URL=url,**settings)
        result=subprocess.run(['bash',str(driver)],env=e,text=True,capture_output=True,timeout=10)
        assert (result.returncode==0)==ok,(name,result.returncode,result.stdout,result.stderr)
        if ok:assert f'RESULT:{base}|none|1||' in result.stdout,(name,result.stdout)
        count+=1;print('PASS',name)
        return [json.loads(line) for line in calls.read_text().splitlines()]
    got=run('GitHub exact PR overrides misleading local default and clears alternate PR selection',ok=True)
    assert got==[['gh','api','--hostname','github.com','repos/owner/repo/pulls/123']],got
    got=run('GitLab nested project and exact MR base',data=gl,url=gl_url,ok=True)
    assert got==[['glab','api','--hostname','gitlab.example','projects/group%2Fsub%2Frepo/merge_requests/456']],got
    run('reject different PR URL',data={**gh,'html_url':gh_url.replace('123','999')})
    run('reject different PR number',data={**gh,'number':999})
    run('reject closed PR',data={**gh,'state':'closed'})
    run('reject merged PR',data={**gh,'merged':True})
    run('reject missing base',data={**gh,'base':{}})
    run('reject invalid commit syntax',data={**gh,'base':{'sha':'--all'}})
    run('reject unrelated head',data={**gh,'head':{'sha':'1'*40}})
    run('reject forked GitLab metadata head',data={**gl,'sha':base},url=gl_url)
    got=run('unavailable valid base fetches only exact repository then fails closed',data={**gh,'base':{'sha':'f'*40}})
    assert got[-1]==['git','-C',str(repo),'fetch','--no-tags','--','https://github.com/owner/repo.git','f'*40],got
    run('reject CLI failure',TEST_API_ERROR='1')
    got=run('public GitHub lookup works without a new CLI login',ok=True,TEST_API_ERROR='1',TEST_PUBLIC='1')
    assert got[-1][-1]=='https://api.github.com/repos/owner/repo/pulls/123',got
    run('reject malformed metadata',data='not JSON')
    run('reject explicit base override',TEST_BASE=base)
    run('reject explicit target override',TEST_TARGET='main')
    got=run('reject URL credentials before invoking forge',url='https://token@github.com/owner/repo/pull/123')
    assert not got,got
    got=run('reject URL query before invoking forge',url=gh_url+'?other=999')
    assert not got,got
    print(f'{count} exact-PR scope cases passed; no network or review agent invoked.')
PY
