"""Deterministic installation ZIP. Standard library only; never glob user files."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import zipfile

ROOT = Path(__file__).resolve().parents[1]
FILES = json.loads((ROOT / 'scripts/package-files.json').read_text('utf-8'))


def content(name):
    rel = PurePosixPath(name)
    if rel.is_absolute() or '..' in rel.parts or '\\' in name:
        raise ValueError('Unsafe package path: ' + name)
    source = ROOT / name
    if source.is_symlink() or not source.resolve().is_relative_to(ROOT):
        raise ValueError('Package source must stay in repository: ' + name)
    data = source.read_bytes()
    # Canonical UTF-8/LF makes Windows and Linux checkouts produce identical ZIPs.
    return data if name.endswith('.png') else data.decode('utf-8').replace('\r\n', '\n').encode('utf-8')


def build(output):
    output.mkdir(parents=True, exist_ok=True)
    version = json.loads(content('manifest.json'))['version']
    target = output / f'baidu-netdisk-transcript-exporter-v{version}.zip'
    with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_STORED) as archive:
        for name in sorted(FILES):
            entry = zipfile.ZipInfo(name, (2020, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = 0o100644 << 16
            archive.writestr(entry, content(name))
    digest = hashlib.sha256(target.read_bytes()).hexdigest()
    (output / 'SHA256SUMS.txt').write_text(f'{digest}  {target.name}\n', encoding='utf-8', newline='\n')
    return target


def verify(target):
    with zipfile.ZipFile(target) as archive:
        if archive.testzip() is not None or sorted(archive.namelist()) != sorted(FILES):
            raise ValueError('CRC or package file list mismatch')
        for name in FILES:
            if archive.read(name) != content(name):
                raise ValueError('Package differs from source: ' + name)
        if json.loads(archive.read('manifest.json'))['version'] != json.loads((ROOT / 'package.json').read_text('utf-8'))['version']:
            raise ValueError('Version mismatch')
    expected = f'{hashlib.sha256(target.read_bytes()).hexdigest()}  {target.name}\n'
    if (target.parent / 'SHA256SUMS.txt').read_text('utf-8') != expected:
        raise ValueError('Checksum file mismatch')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'dist')
    parser.add_argument('--verify', action='store_true')
    args = parser.parse_args()
    version = json.loads(content('manifest.json'))['version']
    target = args.output / f'baidu-netdisk-transcript-exporter-v{version}.zip' if args.verify else build(args.output)
    verify(target)
    print('Verified ' + str(target))
