import React, { useEffect, useState, useRef } from 'react'
import { Modal, Input } from 'antd'
import { SearchOutlined, CodeOutlined } from '@ant-design/icons'
import { useCommandStore } from '@/stores/commandStore'
import { useThemeStore } from '@/stores/themeStore'

export const CommandPalette: React.FC = () => {
  const { isOpen, toggleOpen, setOpen, commands, executeCommand } = useCommandStore()
  const [search, setSearch] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const isDark = useThemeStore((s) => s.effectiveTheme) === 'dark'

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd+K (Mac) or Ctrl+K (Windows/Linux)
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        toggleOpen()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [toggleOpen])

  useEffect(() => {
    if (isOpen) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSearch('')
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelectedIndex(0)
    }
  }, [isOpen])

  const filteredCommands = commands.filter((c) =>
    c.title.toLowerCase().includes(search.toLowerCase()) || 
    c.category.toLowerCase().includes(search.toLowerCase())
  )

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex((prev) => Math.min(prev + 1, filteredCommands.length - 1))
      // Scroll into view logic could be added here
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex((prev) => Math.max(prev - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (filteredCommands[selectedIndex]) {
        executeCommand(filteredCommands[selectedIndex].id)
      }
    }
  }

  return (
    <Modal
      open={isOpen}
      onCancel={() => setOpen(false)}
      footer={null}
      closable={false}
      width={600}
      styles={{
        body: { padding: 0 },
        mask: { backdropFilter: 'blur(4px)' }
      }}
      modalRender={(node) => (
        <div style={{
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.25)',
          borderRadius: 12,
          overflow: 'hidden',
          border: `1px solid ${isDark ? '#334155' : '#E2E8F0'}`,
        }}>
          {node}
        </div>
      )}
    >
      <div style={{ padding: '16px 20px', borderBottom: `1px solid ${isDark ? '#334155' : '#E2E8F0'}` }}>
        <Input
          autoFocus
          placeholder="搜索命令或操作..."
          value={search}
          onChange={(e) => {
            setSearch(e.target.value)
            setSelectedIndex(0)
          }}
          onKeyDown={handleKeyDown}
          bordered={false}
          prefix={<SearchOutlined style={{ color: '#94A3B8', fontSize: 18, marginRight: 8 }} />}
          style={{ fontSize: 16, padding: 0, boxShadow: 'none' }}
        />
      </div>
      
      <div 
        ref={listRef}
        style={{ 
          maxHeight: 350, 
          overflowY: 'auto', 
          padding: '8px 0',
          background: isDark ? '#1E293B' : '#FFFFFF' 
        }}
      >
        {filteredCommands.length === 0 ? (
          <div style={{ padding: '32px 0', textAlign: 'center', color: '#94A3B8' }}>
            找不到匹配的命令
          </div>
        ) : (
          filteredCommands.map((cmd, index) => {
            const isSelected = index === selectedIndex
            return (
              <div
                key={cmd.id}
                onClick={() => executeCommand(cmd.id)}
                onMouseEnter={() => setSelectedIndex(index)}
                style={{
                  padding: '10px 20px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  cursor: 'pointer',
                  background: isSelected 
                    ? (isDark ? '#334155' : '#F1F5F9') 
                    : 'transparent',
                  transition: 'background 0.1s ease',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ 
                    color: isSelected ? '#22C55E' : '#64748B',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center'
                  }}>
                    {cmd.icon || <CodeOutlined />}
                  </div>
                  <div>
                    <div style={{ 
                      fontSize: 14, 
                      fontWeight: 500,
                      color: isDark ? '#F8FAFC' : '#0F172A'
                    }}>
                      {cmd.title}
                    </div>
                    {cmd.category && (
                      <div style={{ 
                        fontSize: 12, 
                        color: '#94A3B8',
                        marginTop: 2
                      }}>
                        {cmd.category}
                      </div>
                    )}
                  </div>
                </div>
                {cmd.shortcut && (
                  <div style={{ display: 'flex', gap: 4 }}>
                    {cmd.shortcut.map(key => (
                      <kbd 
                        key={key}
                        style={{
                          background: isDark ? '#0F172A' : '#E2E8F0',
                          border: `1px solid ${isDark ? '#475569' : '#CBD5E1'}`,
                          borderRadius: 4,
                          padding: '2px 6px',
                          fontSize: 11,
                          color: isDark ? '#94A3B8' : '#64748B',
                          fontFamily: 'monospace'
                        }}
                      >
                        {key}
                      </kbd>
                    ))}
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>
    </Modal>
  )
}
