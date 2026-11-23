/** Keep only a count in the worker. All management mutations stay in user gestures. */
async function updateBadge() {
  try {
    const items = await chrome.management.getAll();
    const count = items.filter(
      (item) => item.id !== chrome.runtime.id && item.enabled && item.type === 'extension',
    ).length;
    await chrome.action.setBadgeBackgroundColor({ color: '#315e46' });
    await chrome.action.setBadgeText({ text: count ? String(count) : '' });
    await chrome.action.setTitle({ title: `栖 · 扩展管理 · ${count} 个扩展已启用` });
  } catch {
    await chrome.action.setBadgeText({ text: '' }).catch(() => undefined);
  }
}

chrome.management.onInstalled.addListener(() => {
  void updateBadge();
});
chrome.management.onUninstalled.addListener(() => {
  void updateBadge();
});
chrome.management.onEnabled.addListener(() => {
  void updateBadge();
});
chrome.management.onDisabled.addListener(() => {
  void updateBadge();
});
chrome.runtime.onInstalled.addListener(() => {
  void updateBadge();
});
chrome.runtime.onStartup.addListener(() => {
  void updateBadge();
});
chrome.commands.onCommand.addListener((command) => {
  if (command === 'open-manager') void chrome.runtime.openOptionsPage();
});
void updateBadge();

export {};
