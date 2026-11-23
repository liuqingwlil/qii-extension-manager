import json
import tempfile
import unittest
from pathlib import Path
from qii_discovery import find_managers

class DiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.code = self.root / 'qii-dist'
        self.code.mkdir()
        self.profile = self.root / 'User Data' / 'Default'
        self.profile.mkdir(parents=True)
        self.identifier = 'a' * 32
        manifest = {'name':'栖 · 扩展管理器','version':'1.4.1','background':{'service_worker':'background.js'},'permissions':['management','storage'],'optional_permissions':['nativeMessaging']}
        (self.code/'manifest.json').write_text(json.dumps(manifest),encoding='utf-8')
        (self.code/'qii-manager.json').write_text(json.dumps({'app':'qii-extension-manager','discoveryVersion':1}),encoding='utf-8')
        self.prefs = {'extensions':{'settings':{self.identifier:{'path':str(self.code),'state':1,'location':4}}}}
        self.save()
    def save(self):
        (self.profile/'Preferences').write_text(json.dumps(self.prefs),encoding='utf-8')
    def tearDown(self):
        self.temp.cleanup()
    def discover(self):
        return find_managers({'Edge': self.profile.parent})
    def test_finds_manager_without_manual_id(self):
        self.assertEqual(self.discover()[0]['id'],self.identifier)
    def test_name_alone_does_not_authorize_discovery(self):
        (self.code/'qii-manager.json').unlink()
        self.assertEqual(self.discover(),[])
    def test_disabled_manager_not_auto_connected(self):
        self.prefs['extensions']['settings'][self.identifier]['state']=0
        self.save();self.assertEqual(self.discover(),[])
    def test_deduplicates_same_id_in_multiple_profiles(self):
        other=self.profile.parent/'Profile 1';other.mkdir()
        (other/'Preferences').write_text(json.dumps(self.prefs),encoding='utf-8')
        self.assertEqual(len(self.discover()),1)
    def test_multiple_unique_candidates_remain_distinct(self):
        self.prefs['extensions']['settings']['b'*32]=dict(self.prefs['extensions']['settings'][self.identifier])
        self.save();self.assertEqual(len(self.discover()),2)

if __name__=='__main__':unittest.main()
