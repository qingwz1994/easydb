import { describe, it, expect, beforeEach } from 'vitest'
import { useCommandStore } from '../commandStore'

describe('useCommandStore', () => {
  beforeEach(() => {
    useCommandStore.setState({ commands: [], isOpen: false })
  })

  it('registers a command correctly', () => {
    const store = useCommandStore.getState()
    store.registerCommand({ id: 'test-1', title: 'Test 1', category: 'General', action: () => {} })
    expect(useCommandStore.getState().commands).toHaveLength(1)
    expect(useCommandStore.getState().commands[0].id).toBe('test-1')
  })

  it('deregisters a command correctly', () => {
    const store = useCommandStore.getState()
    store.registerCommand({ id: 'test-2', title: 'Test 2', category: 'General', action: () => {} })
    store.unregisterCommand('test-2')
    expect(useCommandStore.getState().commands).toHaveLength(0)
  })

  it('toggles palette open state', () => {
    const store = useCommandStore.getState()
    store.setOpen(true)
    expect(useCommandStore.getState().isOpen).toBe(true)
    store.toggleOpen()
    expect(useCommandStore.getState().isOpen).toBe(false)
  })
})
