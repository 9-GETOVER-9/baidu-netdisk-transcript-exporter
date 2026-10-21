from pathlib import Path
import json
import sys
import zipfile

with zipfile.ZipFile(sys.argv[1]) as archive:
    assert archive.testzip() is None
    Path(sys.argv[2]).write_bytes(archive.read('_提取报告/总览.html'))
    assert '回归课程/第一章/预览文稿.md' in archive.namelist()
    assert '回归课程/第一章/字幕备用.md' in archive.namelist()
    assert '回归课程/第一章/关闭中断.md' not in archive.namelist()
    manifest = json.loads(archive.read('_提取报告/全部文件清单.json'))
    assert manifest['resultSummary']['obtained'] == 2
    assert manifest['resultSummary']['missing'] == 1
    assert manifest['resultSummary']['manuscript'] == 1
    assert manifest['resultSummary']['subtitle'] == 1
    missing = archive.read('_提取报告/未提取清单.md').decode('utf-8')
    assert '/回归课程/第一章/关闭中断.mp4' in missing
    assert '失败' in missing
print('Real browser download: directory, Markdown sources, missing path and ZIP CRC passed.')
