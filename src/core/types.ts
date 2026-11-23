export type ExtensionItem = chrome.management.ExtensionInfo & {
  demoColor?: string;
  demoGlyph?: string;
};

export interface Group {
  id: string;
  name: string;
}
export interface Scene {
  id: string;
  name: string;
  description: string;
  enabledIds: string[];
  scopeIds: string[];
  createdAt: number;
}
export interface ExtensionMeta {
  favorite?: boolean;
  groupId?: string;
  note?: string;
}
export interface Settings {
  theme: 'light' | 'dark' | 'system';
  view: 'grid' | 'list';
  sort: 'name' | 'enabled' | 'group';
  confirmBulk: boolean;
  popupView?: 'grid' | 'list';
  popupDensity?: 'comfortable' | 'compact';
  skin?: 'forest' | 'elysia';
}
export interface Activity {
  id: string;
  at: number;
  text: string;
}
export interface AppData {
  schemaVersion: 1;
  groups: Group[];
  scenes: Scene[];
  meta: Record<string, ExtensionMeta>;
  settings: Settings;
  activity: Activity[];
}
export interface BatchResult {
  succeeded: string[];
  failed: { id: string; error: string }[];
  skipped: string[];
}
export interface BackupInventoryItem {
  id: string;
  name: string;
  enabled: boolean;
}
export interface Backup {
  app: 'qii-extension-manager';
  version: 1;
  exportedAt: string;
  data: AppData;
  inventory: BackupInventoryItem[];
}

export interface FullBackupInventoryItem extends BackupInventoryItem {
  version?: string;
  type?: ExtensionItem['type'];
  installType?: ExtensionItem['installType'];
  homepageUrl?: string;
  updateUrl?: string;
  installUrl?: string;
}
export interface BackupSource {
  browser: string;
  managerId: string;
  appVersion?: string;
}
export interface BackupV2 {
  app: 'qii-extension-manager';
  version: 2;
  kind: 'extensions';
  exportedAt: string;
  source?: BackupSource;
  data: AppData;
  inventory: FullBackupInventoryItem[];
}
export interface ParsedBackup {
  version: 1 | 2;
  kind?: 'extensions';
  exportedAt: string;
  source?: BackupSource;
  data: AppData;
  inventory: FullBackupInventoryItem[];
}
export type RestorePlanStatus =
  'enable' | 'disable' | 'unchanged' | 'missing' | 'protected' | 'requires-permission';
export type RestoreStatus =
  | 'applied'
  | 'unchanged'
  | 'missing'
  | 'protected'
  | 'requires-permission'
  | 'failed'
  | 'not-applied';
export interface RestorePlanRow {
  id: string;
  name: string;
  version?: string;
  type?: ExtensionItem['type'];
  installType?: ExtensionItem['installType'];
  targetEnabled: boolean;
  beforeEnabled?: boolean;
  installUrl?: string;
  status: RestorePlanStatus;
  message?: string;
}
export interface RestoreRow extends Omit<RestorePlanRow, 'status'> {
  status: RestoreStatus;
  actualEnabled?: boolean;
  error?: string;
}
export interface RestorePlan {
  rows: RestorePlanRow[];
  counts: {
    enable: number;
    disable: number;
    unchanged: number;
    missing: number;
    protected: number;
    requiresPermission: number;
  };
  mergedData: AppData;
}
export interface RestoreResult {
  at: string;
  mode: 'config-only' | 'apply-states';
  rows: RestoreRow[];
  counts: {
    applied: number;
    unchanged: number;
    missing: number;
    protected: number;
    requiresPermission: number;
    failed: number;
    notApplied: number;
  };
  configSaved: boolean;
  configError?: string;
  verificationError?: string;
  reportSaved: boolean;
  reportError?: string;
  complete: boolean;
}
