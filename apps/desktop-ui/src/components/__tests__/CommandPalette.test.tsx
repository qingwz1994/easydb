import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { CommandPalette } from '../CommandPalette'
import { useCommandStore } from '../../stores/commandStore'


// Mock matchMedia for ant design modal
window.matchMedia = window.matchMedia || function() {
    return {
        matches: false,
        addListener: function() {},
        removeListener: function() {}
    };
};

describe('CommandPalette', () => {
  beforeEach(() => {
    useCommandStore.setState({ commands: [], isOpen: false })
  })

  it('renders nothing when closed', () => {
    render(<CommandPalette />)
    expect(screen.queryByPlaceholderText('搜索命令或操作...')).not.toBeInTheDocument()
  })

  it('renders input when open', async () => {
    useCommandStore.getState().setOpen(true)
    render(<CommandPalette />)
    
    await waitFor(() => {
      const input = screen.getByPlaceholderText('搜索命令或操作...')
      expect(input).toBeInTheDocument()
    })
  })

  it('filters commands based on search text', async () => {
    const action1 = vi.fn()
    const action2 = vi.fn()
    
    useCommandStore.setState({
      isOpen: true,
      commands: [
        { id: '1', title: 'Open Settings', category: 'Nav', action: action1 },
        { id: '2', title: 'Export Data', category: 'Action', action: action2 }
      ]
    })

    render(<CommandPalette />)
    
    await waitFor(() => {
      expect(screen.getByText('Open Settings')).toBeInTheDocument()
      expect(screen.getByText('Export Data')).toBeInTheDocument()
    })

    // Type to search
    const input = screen.getByPlaceholderText('搜索命令或操作...')
    fireEvent.change(input, { target: { value: 'Setting' } })

    await waitFor(() => {
      expect(screen.getByText('Open Settings')).toBeInTheDocument()
      expect(screen.queryByText('Export Data')).not.toBeInTheDocument()
    })
  })

  it('triggers action on click and closes it', async () => {
    const actionSpy = vi.fn()
    useCommandStore.setState({
      isOpen: true,
      commands: [
        { id: '1', title: 'Open Test', category: 'Test', action: actionSpy }
      ]
    })

    render(<CommandPalette />)
    
    await waitFor(() => {
      const item = screen.getByText('Open Test')
      fireEvent.click(item)
    })
    
    expect(actionSpy).toHaveBeenCalled()
    expect(useCommandStore.getState().isOpen).toBe(false)
  })
})
