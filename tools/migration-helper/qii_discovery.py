"""Identify installed Qii managers from explicit browser roots, never by display name alone."""
from pathlib import Path
from qii_archive import discover_profiles, _profile_settings, _source_directory, _read_json, _assert_real_path

def find_managers(roots):
    found = {}
    for profile in discover_profiles(roots):
        try:
            settings = _profile_settings(profile)
        except (OSError, ValueError, TypeError, AttributeError):
            continue
        for identifier, entry in settings.items():
            if entry.get('state') != 1:
                continue
            try:
                source = _source_directory(profile, {'id': identifier, 'installType': 'development' if entry.get('location') == 4 else 'normal'}, settings)
                marker = source / 'qii-manager.json'
                _assert_real_path(marker)
                if _read_json(marker, 4096) != {'app': 'qii-extension-manager', 'discoveryVersion': 1}:
                    continue
                manifest = _read_json(source / 'manifest.json', 1024 * 1024)
                if manifest.get('name') != '栖 · 扩展管理器' or manifest.get('background', {}).get('service_worker') != 'background.js':
                    continue
                if not {'management', 'storage'}.issubset(manifest.get('permissions', [])) or 'nativeMessaging' not in manifest.get('optional_permissions', []):
                    continue
                found.setdefault(identifier, {'id': identifier, 'browser': profile.browser, 'profile': profile.name})
            except (OSError, ValueError, TypeError, AttributeError):
                continue
    return list(found.values())
