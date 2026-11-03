#!/usr/bin/env python3
"""Synthetic tar path/type rejection tests for the off-host recovery procedure."""
import io
import pathlib
import tarfile
import tempfile
import time


def validate(archive_path, max_members=100_000, max_bytes=20 * 1024**3, max_compressed=2 * 1024**3, max_seconds=60):
    if pathlib.Path(archive_path).stat().st_size > max_compressed:
        raise ValueError("compressed archive exceeds size limit")
    started = time.monotonic()
    with tarfile.open(archive_path, "r|gz") as archive:
        seen = set()
        count = total = 0
        for member in archive:
            if time.monotonic() - started > max_seconds:
                raise ValueError("archive validation exceeded time limit")
            count += 1
            total += member.size
            path = pathlib.PurePosixPath(member.name)
            normalized = str(path)
            if (count > max_members or total > max_bytes or member.size < 0
                    or path.is_absolute() or ".." in path.parts or normalized in seen
                    or not (member.isfile() or member.isdir())):
                raise ValueError("unsafe or oversized archive refused")
            seen.add(normalized)


def make_archive(path, members):
    with tarfile.open(path, "w:gz") as archive:
        for member in members:
            archive.addfile(member, io.BytesIO(b"safe-test"))


def info(name, kind=tarfile.REGTYPE):
    item = tarfile.TarInfo(name)
    item.type = kind
    item.size = 9 if kind == tarfile.REGTYPE else 0
    return item


with tempfile.TemporaryDirectory(prefix="layerfs-tar-safety-") as tmp:
    root = pathlib.Path(tmp)
    good = root / "good.tar.gz"
    make_archive(good, [info("./manifest.json"), info("./store/" , tarfile.DIRTYPE), info("./store/data")])
    validate(good)
    print("PASS ordinary relative files/directories")
    cases = {
        "traversal": [info("../../escape")],
        "absolute": [info("/tmp/escape")],
        "symlink": [info("link", tarfile.SYMTYPE)],
        "hardlink": [info("link", tarfile.LNKTYPE)],
        "fifo": [info("pipe", tarfile.FIFOTYPE)],
        "duplicate": [info("same"), info("same")],
    }
    for name, members in cases.items():
        archive = root / (name + ".tar.gz")
        make_archive(archive, members)
        try:
            validate(archive)
        except ValueError:
            print("PASS reject " + name)
        else:
            raise SystemExit("FAIL accepted " + name)
    resource = root / "resource-limit.tar.gz"
    make_archive(resource, [info("one"), info("two")])
    for label, limits in [("member-count", {"max_members": 1}), ("expanded-bytes", {"max_bytes": 8}), ("compressed-size", {"max_compressed": 1}), ("time-budget", {"max_seconds": 0})]:
        try:
            validate(resource, **limits)
        except ValueError:
            print("PASS reject " + label)
        else:
            raise SystemExit("FAIL accepted " + label)
print("LayerFS archive safety: 11 checks passed")
