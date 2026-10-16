"""仅在独立 Rootless 命名空间、合成临时目录运行的 ACL 对照实验。"""
from pathlib import Path
import os
import stat
import subprocess
import sys


def run(*args):
    return subprocess.run(args, capture_output=True, text=True, check=True, timeout=20)


def actor(uid, gid, code, path):
    return subprocess.run(
        ["setpriv", f"--reuid={uid}", f"--regid={gid}", "--clear-groups",
         "--no-new-privs", "python3", "-c", code, str(path)],
        capture_output=True, text=True, timeout=20,
    )


def expect(uid, gid, code, path, allowed):
    result = actor(uid, gid, code, path)
    if (result.returncode == 0) != allowed:
        raise AssertionError(f"权限结果不符 uid={uid} allowed={allowed} rc={result.returncode}")


def acl(path, value):
    run("setfacl", "-m", value, str(path))


def _verify_permissions(original, patched, baseline):
    acl(original, "u:65532:rwx,u:65530:r-x,g:333:rwx,o::---")
    # 新建文件才会验证目录的写权限，覆盖已有文件只检查文件自身权限。
    write = (
        "import pathlib,sys,tempfile; p=pathlib.Path(sys.argv[1]); "
        "f=tempfile.NamedTemporaryFile(dir=p); f.close(); (p/'probe').write_text('synthetic')"
    )
    read = "import pathlib,sys; assert pathlib.Path(sys.argv[1], 'probe').read_text() == 'synthetic'"
    for path in (original, patched):
        expect(65532, 65532, write, path, True)
        expect(65531, 65531, write, path, False)
        expect(65530, 65530, read, path, True)
        expect(65530, 65530, write, path, False)
    expect(65532, 65532, write, baseline, False)
    print("通过：旧版行为复现、授权用户可写、未授权用户拒绝、只读 ACL")

    group_write = "import pathlib,sys; pathlib.Path(sys.argv[1], 'group-probe').write_text('group')"
    for path in (original, patched):
        expect(65529, 333, group_write, path, True)
    print("通过：命名组 ACL")

    acl(original, "m::r-x")
    for path in (original, patched):
        expect(65532, 65532, write, path, False)
    acl(original, "m::rwx")
    for path in (original, patched):
        expect(65532, 65532, write, path, True)
    print("通过：ACL mask 限制与恢复")

    # 保持 mask 不变，避免仅因 mode 变化而掩盖 ACL 缓存过期问题。
    run("setfacl", "-n", "-x", "u:65532", str(original))
    for path in (original, patched):
        expect(65532, 65532, write, path, False)
    acl(original, "u:65532:rwx")
    expect(65532, 65532, write, patched, True)
    print("通过：来源目录外部撤销及重新授权")

    own_file = patched / "probe"
    change_acl = (
        "import subprocess,sys; subprocess.run(['setfacl','-m','u:65530:r--',sys.argv[1]],check=True)"
    )
    expect(65532, 65532, change_acl, own_file, True)
    assert run("getfacl", "-cpn", str(original / "probe")).stdout == run(
        "getfacl", "-cpn", str(own_file)).stdout
    # 必须实际提升权限；写入完全相同的 ACL 可能被工具判为无需修改。
    escalate_acl = change_acl.replace("u:65530:r--", "u:65530:rw-")
    for path in (original / "probe", own_file):
        expect(65530, 65530, escalate_acl, path, False)
    print("通过：属主通过转接更新 ACL，非属主修改被拒绝")

    return read, write


def _verify_creation(source, patched_root):
    for label, view in (("direct", source), ("fuse", patched_root)):
        plain_source = source / f"plain-{label}"
        plain_source.mkdir(mode=0o750)
        acl(plain_source, "u:65532:rwx")
        target = view / plain_source.name
        code = (
            "import os,pathlib,sys; os.umask(0o077); p=pathlib.Path(sys.argv[1]); "
            "(p/'private').touch(); (p/'private-dir').mkdir(); os.mkfifo(p/'private-fifo',0o666)"
        )
        expect(65532, 65532, code, target, True)
        assert stat.S_IMODE((plain_source / "private").stat().st_mode) == 0o600
        assert stat.S_IMODE((plain_source / "private-dir").stat().st_mode) == 0o700
        assert stat.S_IMODE((plain_source / "private-fifo").stat().st_mode) == 0o600
        assert (plain_source / "private").stat().st_uid == 65532
    print("通过：无默认 ACL 时 umask 与文件属主保真")

    inherited = []
    for label, view in (("direct", source), ("fuse", patched_root)):
        parent = source / f"inherit-{label}"
        parent.mkdir(mode=0o750)
        acl(parent, "u:65532:rwx,u:65530:r-x,d:u::rwx,d:u:65530:r-x,d:g::---,d:m::r-x,d:o::---")
        target = view / parent.name
        create = (
            "import os,pathlib,sys; os.umask(0o077); p=pathlib.Path(sys.argv[1]); "
            "(p/'child').write_text('synthetic'); (p/'child-dir').mkdir(); os.mkfifo(p/'child-fifo',0o666)"
        )
        expect(65532, 65532, create, target, True)
        inherited.append(tuple(run("getfacl", "-cpn", str(parent / name)).stdout
                               for name in ("child", "child-dir", "child-fifo")))
        expect(65530, 65530, "import pathlib,sys; assert pathlib.Path(sys.argv[1]).read_text() == 'synthetic'",
               target / "child", True)
    assert inherited[0] == inherited[1], "默认 ACL 继承与直接文件系统不一致"
    print("通过：文件与目录默认 ACL 继承、只读用户可读")


def main():
    root = Path(sys.argv[1]).resolve(strict=True)
    if not root.name.startswith("gugu-acl-lab.") or root.parent != Path("/tmp"):
        raise SystemExit("拒绝非合成实验目录")
    for name in ("source", "baseline", "patched", "readonly"):
        path = root / name
        if not path.is_dir() or path.is_symlink() or path.resolve().parent != root:
            raise SystemExit("拒绝缺失或越界的实验视图")
    mappings = Path("/proc/self/uid_map").read_text().splitlines()
    if os.getuid() != 0 or not any(
        int(parts[0]) == 0 and int(parts[1]) > 0
        for parts in (line.split() for line in mappings)
    ):
        raise SystemExit("拒绝在宿主 root 命名空间运行")
    source = root / "source"
    original = source / "contract"
    original.mkdir(mode=0o750)
    patched = root / "patched" / "contract"
    baseline = root / "baseline" / "contract"
    read, write = _verify_permissions(original, patched, baseline)
    _verify_creation(source, root / "patched")

    readonly = root / "readonly" / "contract"
    expect(65532, 65532, read, readonly, True)
    expect(65532, 65532, write, readonly, False)
    print("通过：只读挂载不可写")
    print("全部 ACL 合约对照通过")


if __name__ == "__main__":
    main()
