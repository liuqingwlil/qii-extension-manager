# Build from this directory: python -m PyInstaller --clean --noconfirm QiiMigration.spec
from pathlib import Path

source = Path(SPECPATH)
a = Analysis([str(source / "qii_migration.py")], pathex=[str(source)], binaries=[], datas=[], hiddenimports=[], hookspath=[], hooksconfig={}, runtime_hooks=[], excludes=[], noarchive=False)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, a.binaries, a.datas, [], name="QiiMigration", debug=False, bootloader_ignore_signals=False, strip=False, upx=False, console=True, hide_console="hide-early", disable_windowed_traceback=False)
