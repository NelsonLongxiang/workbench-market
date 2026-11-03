#!/usr/bin/env python3
"""Exercise backup quiescence and checkpoint gates with disposable Docker stubs."""
import gzip, os, pathlib, subprocess, tempfile
ROOT=pathlib.Path(__file__).resolve().parents[1]
SCRIPT=ROOT/'deploy/ygl-trees/backup-sqlite.sh'
with tempfile.TemporaryDirectory(prefix='ygl-backup-test-') as td:
    root=pathlib.Path(td); bindir=root/'bin'; bindir.mkdir(); logs=root/'docker.log'; gz=root/'fixture.tar.gz'
    with gzip.open(gz,'wb') as f:f.write(b'disposable archive fixture')
    docker=bindir/'docker'
    docker.write_text('''#!/bin/sh
printf '%s\n' "$*" >> "$DOCKER_LOG"
case "$1" in
  ps) [ "$DOCKER_RUNNING" = 1 ] && echo deadbeef ; exit 0 ;;
  run) case "$*" in *ygl-checkpoint-sqlite*) [ "$DOCKER_CHECKPOINT_FAIL" != 1 ];; *) cat "$DOCKER_TAR_FIXTURE";; esac ;;
  *) exit 9;;
esac
''')
    docker.chmod(0o755)
    def run(label,extra,expected,archive_name):
        archive=root/archive_name
        env=os.environ.copy();env.update({'PATH':str(bindir)+os.pathsep+env['PATH'],'DOCKER_LOG':str(logs),'DOCKER_TAR_FIXTURE':str(gz),'COMPOSE_PROJECT_NAME':'candidate-test','YGL_HOME_VOLUME':'candidate-test_home','DOCKER_RUNNING':'0','DOCKER_CHECKPOINT_FAIL':'0'})
        env.update(extra);logs.write_text('')
        p=subprocess.run([str(SCRIPT),str(archive)],env=env,capture_output=True,text=True)
        if (p.returncode==0)!=expected:raise SystemExit(f'{label}: unexpected rc={p.returncode}: {p.stderr}')
        return p,logs.read_text()
    p,log=run('running volume',{'DOCKER_RUNNING':'1'},False,'running.tar.gz')
    assert p.returncode==3 and 'run ' not in log and not (root/'running.tar.gz').exists()
    print('PASS refuses running container before checkpoint or archive')
    p,log=run('checkpoint failure',{'DOCKER_CHECKPOINT_FAIL':'1'},False,'checkpoint-fail.tar.gz')
    assert p.returncode!=0 and 'ygl-checkpoint-sqlite' in log and 'dst=/data,readonly' not in log and not (root/'checkpoint-fail.tar.gz').exists()
    print('PASS checkpoint failure prevents read-only archive and publication')
    p,log=run('clean stopped volume',{},True,'clean.tar.gz')
    assert (root/'clean.tar.gz').is_file() and pathlib.Path(str(root/'clean.tar.gz')+'.sha256').is_file()
    assert log.index('ygl-checkpoint-sqlite')<log.index('dst=/data,readonly')
    print('PASS offline checkpoint precedes read-only archive publication')
print('SQLite backup gate: 3 disposable cases passed')
