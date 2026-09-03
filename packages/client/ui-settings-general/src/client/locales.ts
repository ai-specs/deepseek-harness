/** Shell chrome and General-nav dictionaries; feature rows own their copy. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'trigger': '设置',
  'title': '设置',
  'close': '关闭',
  'openDocument': '打开配置文件',
  'openDocument.error': '无法打开配置文件',
  'general.nav': '通用设置',
  'user.nav': '我的',
  'user.identity': '当前用户',
  'user.logout': '退出登录',
  'user.logoutHint': '退出将清除本机会话并结束统一身份（IdP）登录',
  'user.loading': '读取身份…',
  'user.signedOut': '未登录',
  'connection.error': '连接异常',
  'connection.retry': '立即重连',
  'connection.connecting': '连接中',
  'connection.connected': '连接成功',
  'connection.reconnect': '连接异常，点击立即重连',
  'connection.restart': '连接中，点击立即重连',
} satisfies Record<string, string>

/** The settings namespace key union. */
export type SettingsKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'trigger': 'Settings',
  'title': 'Settings',
  'close': 'Close',
  'openDocument': 'Open configuration file',
  'openDocument.error': 'Could not open configuration file',
  'general.nav': 'General',
  'user.nav': 'Me',
  'user.identity': 'Signed in as',
  'user.logout': 'Sign out',
  'user.logoutHint': 'Signs out of this app and ends the IdP session',
  'user.loading': 'Loading identity…',
  'user.signedOut': 'Not signed in',
  'connection.error': 'Disconnected',
  'connection.retry': 'Reconnect now',
  'connection.connecting': 'Connecting',
  'connection.connected': 'Connected',
  'connection.reconnect': 'Disconnected, reconnect now',
  'connection.restart': 'Connecting, restart now',
} satisfies Record<SettingsKey, string>
