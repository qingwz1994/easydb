import React from 'react'
import { Modal, Typography, Table, theme } from 'antd'
import { formatHotkey } from '@/utils/osUtils'

const { Text } = Typography

export interface ShortcutsModalProps {
  open: boolean
  onCancel: () => void
}

export const ShortcutsModal: React.FC<ShortcutsModalProps> = ({ open, onCancel }) => {
  const { token } = theme.useToken()

  const shortcutsData = [
    { key: '1', action: '全局搜索 / 命令面板', shortcut: ['Cmd', 'K'], scope: '全局' },
    { key: '2', action: '执行高亮/选中的 SQL', shortcut: ['Cmd', 'Enter'], scope: 'SQL 编辑器' },
    { key: '3', action: '打开/关闭侧边栏', shortcut: ['Cmd', 'B'], scope: '全局' },
    { key: '10', action: '编辑单元格', shortcut: ['Space', '或 双击'], scope: '数据表格' },
    { key: '11', action: '保存单元格修改', shortcut: ['Enter'], scope: '数据表格' },
    { key: '12', action: '取消单元格修改', shortcut: ['Esc'], scope: '数据表格' },
    { key: '13', action: '在单元格间导航', shortcut: ['↑', '↓', '←', '→'], scope: '数据表格' },
  ]

  const columns = [
    { title: '作用域', dataIndex: 'scope', key: 'scope', width: 100,
      render: (text: string) => <Text type="secondary">{text}</Text>
    },
    { title: '操作', dataIndex: 'action', key: 'action' },
    { title: '快捷键', dataIndex: 'shortcut', key: 'shortcut', align: 'right' as const,
      render: (keys: string[]) => (
        <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          {keys.map((k, i) => {
            if (k === '或 双击') {
              return <span key={i} style={{ color: token.colorTextSecondary, fontSize: 12, alignSelf: 'center' }}>{k}</span>
            }
            return (
              <kbd 
                key={i}
                style={{
                  background: token.colorBgLayout,
                  border: `1px solid ${token.colorBorder}`,
                  borderRadius: 4,
                  padding: '2px 6px',
                  fontSize: 12,
                  fontFamily: 'SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace',
                  boxShadow: `0 1px 0 ${token.colorBorder}`
                }}
              >
                {/* 针对特殊字符或箭头不做转换，直接渲染；常见的修饰键进行转换 */}
                {['↑', '↓', '←', '→'].includes(k) ? k : formatHotkey([k])}
              </kbd>
            )
          })}
        </div>
      )
    },
  ]

  return (
    <Modal
      title="⌨️ 键盘快捷键大全 (Cheat Sheet)"
      open={open}
      onCancel={onCancel}
      footer={null}
      width={600}
    >
      <div style={{ marginTop: 16 }}>
        <Table 
          dataSource={shortcutsData} 
          columns={columns} 
          pagination={false} 
          size="middle" 
          bordered={false}
        />
      </div>
    </Modal>
  )
}
