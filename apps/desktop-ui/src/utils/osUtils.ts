export const getOS = (): 'mac' | 'windows' | 'linux' | 'other' => {
  if (typeof window === 'undefined') return 'other'
  
  // 现代浏览器推荐使用 userAgentData，降级使用 platform 和 userAgent
  const platform = (window.navigator as any).userAgentData?.platform?.toLowerCase() 
    || window.navigator.platform.toLowerCase()
  const userAgent = window.navigator.userAgent.toLowerCase()

  if (platform.includes('mac') || userAgent.includes('mac')) return 'mac'
  if (platform.includes('win') || userAgent.includes('win')) return 'windows'
  if (platform.includes('linux') || userAgent.includes('linux')) return 'linux'
  
  return 'other'
}

export const isAppleDevice = () => {
  return getOS() === 'mac'
}

export const getHotkeySymbol = (key: string): string => {
  const mac = isAppleDevice()
  switch (key.toLowerCase()) {
    case 'cmd':
    case 'ctrl':
    case 'meta':
      return mac ? '⌘' : 'Ctrl'
    case 'alt':
    case 'option':
      return mac ? '⌥' : 'Alt'
    case 'shift':
      return mac ? '⇧' : 'Shift'
    case 'enter':
    case 'return':
      return mac ? '↵' : 'Enter'
    case 'esc':
    case 'escape':
      return mac ? '⎋' : 'Esc'
    case 'space':
      return mac ? '␣' : 'Space'
    default:
      // Return uppercase for single letters
      return key.length === 1 ? key.toUpperCase() : key
  }
}

export const formatHotkey = (keys: string[]): string => {
  const mac = isAppleDevice()
  const separator = mac ? ' ' : ' + '
  return keys.map(getHotkeySymbol).join(separator)
}
