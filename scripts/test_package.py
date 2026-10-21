"""Independent archive reading and negative tests for the release boundary."""
import tempfile
from pathlib import Path
import zipfile
import package

with tempfile.TemporaryDirectory(prefix='pd-package-') as temp:
    first = package.build(Path(temp) / 'first')
    second = package.build(Path(temp) / 'second')
    assert first.read_bytes() == second.read_bytes(), 'Non-reproducible package'
    package.verify(first)
    with zipfile.ZipFile(first) as archive:
        assert 'manifest.json' in archive.namelist()
        assert not any(n.startswith(('tests/', 'node_modules/', 'Data/', '.git/')) for n in archive.namelist())
    for unsafe in ['../README.md', '/README.md']:
        try:
            package.content(unsafe)
        except ValueError:
            pass
        else:
            raise AssertionError('Unsafe path accepted')
    with zipfile.ZipFile(second, 'a') as archive:
        archive.writestr('unexpected-private-data.txt', 'synthetic')
    try:
        package.verify(second)
    except ValueError:
        pass
    else:
        raise AssertionError('Unexpected file was accepted')
print('Package reproducibility, CRC, allowlist and tampering checks passed.')
