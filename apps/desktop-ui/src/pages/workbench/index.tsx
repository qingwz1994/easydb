import React, { useEffect, useState, useCallback } from 'react'
import {
  Layout, Tree, Tabs, Table, Typography, Input, Space, Button, Tag, Tooltip,
  theme, Spin, Card, Statistic, Row, Col,
} from 'antd'
import {
  DatabaseOutlined, TableOutlined, EyeOutlined,
  SearchOutlined, CodeOutlined, ThunderboltOutlined, ReloadOutlined,
} from '@ant-design/icons'
import type { DataNode } from 'antd/es/tree'
import type { DatabaseInfo, TableInfo, ColumnInfo, IndexInfo } from '@/types'
import { useWorkbenchStore } from '@/stores/workbenchStore'
import { useSqlEditorStore } from '@/stores/sqlEditorStore'
import { metadataApi } from '@/services/api'
import { handleApiError } from '@/utils/notification'
import { EmptyState } from '@/components/EmptyState'
import { EditableDataTable } from '@/components/EditableDataTable'
import { useNavigate } from 'react-router-dom'

const { Sider, Content } = Layout
const { Text } = Typography

export const WorkbenchPage: React.FC = () => {
  const { token } = theme.useToken()
  const navigate = useNavigate()

  const activeConnectionId = useWorkbenchStore((s) => s.activeConnectionId)
  const activeConnectionName = useWorkbenchStore((s) => s.activeConnectionName)
  const activeDatabase = useWorkbenchStore((s) => s.activeDatabase)
  const activeTable = useWorkbenchStore((s) => s.activeTable)
  const setActiveDatabase = useWorkbenchStore((s) => s.setActiveDatabase)
  const setActiveTable = useWorkbenchStore((s) => s.setActiveTable)

  const [databases, setDatabases] = useState<DatabaseInfo[]>([])
  const [objectsMap, setObjectsMap] = useState<Record<string, TableInfo[]>>({})
  const [columns, setColumns] = useState<ColumnInfo[]>([])
  const [indexes, setIndexes] = useState<IndexInfo[]>([])
  const [ddl, setDdl] = useState('')
  const [previewRows, setPreviewRows] = useState<Record<string, unknown>[]>([])
  const [loading, setLoading] = useState(false)
  const [searchText, setSearchText] = useState('')

  const [expandedKeys, setExpandedKeys] = useState<React.Key[]>([])

  const setPendingSql = useSqlEditorStore((s) => s.setPendingSql)

  // 打开 SQL 编辑器并带入当前上下文
  const openSqlEditor = useCallback(() => {
    setPendingSql('', activeConnectionId ?? undefined, activeDatabase ?? undefined)
    navigate('/sql-editor')
  }, [activeConnectionId, activeDatabase, navigate, setPendingSql])

  // 加载数据库列表
  const loadDatabases = useCallback(async () => {
    if (!activeConnectionId) return
    setLoading(true)
    try {
      const dbs = await metadataApi.databases(activeConnectionId) as DatabaseInfo[]
      setDatabases(dbs)
    } catch (e) {
      handleApiError(e, '加载数据库列表失败')
    } finally {
      setLoading(false)
    }
  }, [activeConnectionId])

  useEffect(() => { loadDatabases() }, [loadDatabases])

  // 选中数据库时加载对象
  const loadTables = useCallback(async (dbName: string) => {
    if (!activeConnectionId) return
    try {
      const tbls = await metadataApi.objects(activeConnectionId, dbName) as TableInfo[]
      setObjectsMap((prev) => ({ ...prev, [dbName]: tbls }))
    } catch (e) {
      handleApiError(e, '加载对象列表失败')
    }
  }, [activeConnectionId])

  // 选中表时加载详情
  const loadTableDetail = useCallback(async (dbName: string, tableName: string) => {
    if (!activeConnectionId) return
    try {
      const [def, idxs, rows, ddlStr] = await Promise.all([
        metadataApi.tableDefinition(activeConnectionId, dbName, tableName) as Promise<{ columns: ColumnInfo[] }>,
        metadataApi.indexes(activeConnectionId, dbName, tableName) as Promise<IndexInfo[]>,
        metadataApi.previewRows(activeConnectionId, dbName, tableName) as Promise<Record<string, unknown>[]>,
        metadataApi.ddl(activeConnectionId, dbName, tableName) as Promise<string>,
      ])
      setColumns(def.columns || [])
      setIndexes(idxs)
      setPreviewRows(rows)
      setDdl(ddlStr)
    } catch (e) {
      handleApiError(e, '加载表详情失败')
    }
  }, [activeConnectionId])

  // 对象类型分类配置
  const objectCategories: { key: string; label: string; types: string[]; icon: React.ReactNode }[] = [
    { key: 'tables', label: '表', types: ['table'], icon: <TableOutlined /> },
    { key: 'views', label: '视图', types: ['view'], icon: <EyeOutlined /> },
    { key: 'triggers', label: '触发器', types: ['trigger'], icon: <ThunderboltOutlined /> },
  ]

  const treeData: DataNode[] = databases
    .map((db) => {
      // 从 objectsMap 中获取该数据库的对象列表
      const dbObjects = objectsMap[db.name] || []

      const categoryChildren: DataNode[] = objectCategories
        .map((cat) => {
          const items = dbObjects.filter(
            (t) => cat.types.includes(t.type)
              && (!searchText || t.name.toLowerCase().includes(searchText.toLowerCase()))
          )
          return {
            key: `${db.name}::${cat.key}`,
            title: `${cat.label} (${items.length})`,
            icon: cat.icon,
            selectable: false,
            children: items.map((t) => ({
              key: `${db.name}.${t.name}`,
              title: (
                <Tooltip title={t.name} mouseEnterDelay={0.5}>
                  <span>{t.name}</span>
                </Tooltip>
              ),
              icon: t.type === 'view' ? <EyeOutlined /> : t.type === 'trigger' ? <ThunderboltOutlined /> : <TableOutlined />,
              isLeaf: true,
            })),
          } as DataNode
        })
        .filter((cat) => {
          // 搜索时只保留有匹配对象的分类
          return !searchText || (cat.children && cat.children.length > 0)
        })

      return {
        key: db.name,
        title: db.name,
        icon: <DatabaseOutlined />,
        children: categoryChildren,
      }
    })
    .filter((db) => {
      const dbMatch = db.key.toString().toLowerCase().includes(searchText.toLowerCase())
      const hasMatchingChild = db.children.some((cat: DataNode) => cat.children && cat.children.length > 0)
      return !searchText || dbMatch || hasMatchingChild
    })

  const handleTreeSelect = (_: React.Key[], info: { node: DataNode }) => {
    const key = info.node.key as string
    // 分类节点（如 dbName::tables）不做选中操作
    if (key.includes('::')) return
    if (key.includes('.')) {
      // 选中具体对象
      const [db, objName] = key.split('.')
      setActiveDatabase(db)
      setActiveTable(objName)
      loadTableDetail(db, objName)
    } else {
      // 选中数据库
      setActiveDatabase(key)
      setActiveTable(null)
      loadTables(key)
      // 选中时自动展开
      if (!expandedKeys.includes(key)) {
        setExpandedKeys((prev) => [...prev, key])
      }
    }
  }

  // 表结构列定义
  const columnTableColumns = [
    { title: '字段名', dataIndex: 'name', key: 'name', width: 160 },
    { title: '类型', dataIndex: 'type', key: 'type', width: 140 },
    {
      title: '可空',
      dataIndex: 'nullable',
      key: 'nullable',
      width: 60,
      render: (v: boolean) => v ? '是' : '否',
    },
    { title: '默认值', dataIndex: 'defaultValue', key: 'defaultValue', width: 120 },
    {
      title: '主键',
      dataIndex: 'isPrimaryKey',
      key: 'isPrimaryKey',
      width: 60,
      render: (v: boolean) => v ? <Tag color="gold">PK</Tag> : null,
    },
    { title: '备注', dataIndex: 'comment', key: 'comment' },
  ]

  // 索引列定义
  const indexTableColumns = [
    { title: '索引名', dataIndex: 'name', key: 'name', width: 200 },
    {
      title: '字段',
      dataIndex: 'columns',
      key: 'columns',
      render: (cols: string[]) => cols.join(', '),
    },
    {
      title: '唯一',
      dataIndex: 'isUnique',
      key: 'isUnique',
      width: 60,
      render: (v: boolean) => v ? '是' : '否',
    },
    {
      title: '主键',
      dataIndex: 'isPrimary',
      key: 'isPrimary',
      width: 60,
      render: (v: boolean) => v ? <Tag color="gold">PK</Tag> : null,
    },
  ]

  if (!activeConnectionId) {
    return (
      <EmptyState
        description="请先在「连接管理」中打开一个连接"
        actionText="前往连接管理"
        onAction={() => navigate('/connection')}
      />
    )
  }


  return (
    <Layout style={{ height: '100%' }}>
      {/* 左侧对象树 */}
      <Sider
        width={260}
        style={{
          background: token.colorBgContainer,
          borderRight: `1px solid ${token.colorBorderSecondary}`,
          overflow: 'auto',
        }}
      >
        <style>{`
          .workbench-object-tree .ant-tree-node-content-wrapper.ant-tree-node-selected {
            background: ${token.colorPrimaryBg};
            color: ${token.colorPrimary};
          }
          .workbench-object-tree .ant-tree-title {
            display: inline-block;
            vertical-align: middle;
            max-width: calc(100% - 24px); /* 减去图标的宽度 */
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
          }
          .workbench-object-tree .ant-tree-node-content-wrapper {
            display: inline-flex;
            align-items: center;
            width: 100%;
            overflow: hidden;
          }
        `}</style>
        <div style={{ padding: '12px 12px 8px' }}>
          <Space style={{ marginBottom: 8, width: '100%' }} direction="vertical" size={8}>
            <Text strong style={{ fontSize: 13 }}>
              <DatabaseOutlined style={{ marginRight: 4 }} />
              {activeConnectionName ?? '对象浏览'}
            </Text>
            <Input
              placeholder="搜索数据库或对象..."
              prefix={<SearchOutlined />}
              size="small"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              allowClear
            />

          </Space>
        </div>
        <Spin spinning={loading}>
          <Tree
            className="workbench-object-tree"
            treeData={treeData}
            showIcon
            blockNode
            onSelect={handleTreeSelect}
            selectedKeys={activeTable && activeDatabase ? [`${activeDatabase}.${activeTable}`] : activeDatabase ? [activeDatabase] : []}
            expandedKeys={expandedKeys}
            onExpand={(keys, { node, expanded }) => {
              setExpandedKeys(keys)
              // 新展开数据库节点时预加载表
              if (expanded && !String(node.key).includes('.')) {
                loadTables(String(node.key))
              }
            }}
          />
        </Spin>
      </Sider>

      {/* 右侧详情区 */}
      <Content style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', background: token.colorBgLayout }}>
        {activeTable && activeDatabase ? (
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
            <style>{`
              .workbench-detail-tabs.ant-tabs {
                height: 100%;
                min-height: 0;
              }
              .workbench-detail-tabs .ant-tabs-content-holder {
                flex: 1;
                min-height: 0;
                overflow: hidden;
              }
              .workbench-detail-tabs .ant-tabs-content {
                height: 100%;
                min-height: 0;
              }
              .workbench-detail-tabs .ant-tabs-tabpane,
              .workbench-detail-tabs .ant-tabs-tabpane-active {
                height: 100%;
                min-height: 0;
                overflow: hidden;
              }
            `}</style>
            {/* 固定头部：表名 + 按钮 */}
            <div style={{ padding: '12px 16px 0 16px', flexShrink: 0 }}>
              <Space style={{ marginBottom: 8 }}>
                <Text strong>
                  <TableOutlined style={{ marginRight: 4 }} />
                  {activeDatabase}.{activeTable}
                </Text>
                <Button
                  size="small"
                  icon={<CodeOutlined />}
                  onClick={() => openSqlEditor()}
                >
                  打开 SQL 编辑器
                </Button>
              </Space>
            </div>

            {/* Tabs：导航固定，内容区填充剩余空间 */}
            <Tabs
              className="workbench-detail-tabs"
              size="small"
              defaultActiveKey="preview"
              style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: '0 16px' }}
              tabBarStyle={{ flexShrink: 0, marginBottom: 0 }}
              items={[
                {
                  key: 'preview',
                  label: `数据预览${previewRows.length > 0 ? ` (${previewRows.length})` : ''}`,
                  children: (
                    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, overflow: 'hidden' }}>
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 12,
                          marginBottom: 8,
                          padding: '0 2px',
                          flexShrink: 0,
                        }}
                      >
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          {columns.length > 0 && columns.some((c) => c.isPrimaryKey)
                            ? `可编辑 · 主键：${columns.filter((c) => c.isPrimaryKey).map((c) => c.name).join(', ')}`
                            : '当前表无主键，数据编辑功能不可用'}
                        </Text>
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          {previewRows.length > 0 ? `共 ${previewRows.length} 行` : ''}
                        </Text>
                      </div>
                      {activeConnectionId && activeDatabase && activeTable ? (
                        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
                          <EditableDataTable
                            connectionId={activeConnectionId}
                            database={activeDatabase}
                            tableName={activeTable}
                            columns={columns}
                            dataSource={previewRows}
                            onRefresh={() => loadTableDetail(activeDatabase, activeTable)}
                          />
                        </div>
                      ) : (
                        <EmptyState description="选择一个表以查看数据" />
                      )}
                    </div>
                  ),
                },
                {
                  key: 'columns',
                  label: '字段结构',
                  children: (
                    <div style={{ overflow: 'auto', height: '100%', minHeight: 0 }}>
                      <Table
                        columns={columnTableColumns}
                        dataSource={columns}
                        rowKey="name"
                        pagination={false}
                        size="small"
                      />
                    </div>
                  ),
                },
                {
                  key: 'indexes',
                  label: '索引',
                  children: (
                    <div style={{ overflow: 'auto', height: '100%', minHeight: 0 }}>
                      <Table
                        columns={indexTableColumns}
                        dataSource={indexes}
                        rowKey="name"
                        pagination={false}
                        size="small"
                      />
                    </div>
                  ),
                },
                {
                  key: 'ddl',
                  label: 'DDL',
                  children: (
                    <pre style={{
                      background: '#1e1e1e',
                      color: '#d4d4d4',
                      padding: 16,
                      borderRadius: token.borderRadius,
                      fontSize: 12,
                      fontFamily: 'Menlo, Monaco, monospace',
                      overflow: 'auto',
                      height: '100%',
                    }}>
                      {ddl || '无 DDL 数据'}
                    </pre>
                  ),
                },
              ]}
            />
          </div>
        ) : activeDatabase ? (
          /* 数据库级概览 */
          <div style={{ padding: 24 }}>
            <Space direction="vertical" size={16} style={{ width: '100%' }}>
              <Space>
                <Text strong style={{ fontSize: 16 }}>
                  <DatabaseOutlined style={{ marginRight: 6 }} />
                  {activeDatabase}
                </Text>
                <Button
                  size="small"
                  icon={<CodeOutlined />}
                  onClick={() => openSqlEditor()}
                >
                  打开 SQL 编辑器
                </Button>
              </Space>

              <Row gutter={16}>
                <Col span={6}>
                  <Card size="small">
                    <Statistic
                      title="表"
                      value={(objectsMap[activeDatabase] || []).filter((t) => t.type === 'table').length}
                      valueStyle={{ color: token.colorPrimary }}
                      prefix={<TableOutlined />}
                    />
                  </Card>
                </Col>
                <Col span={6}>
                  <Card size="small">
                    <Statistic
                      title="视图"
                      value={(objectsMap[activeDatabase] || []).filter((t) => t.type === 'view').length}
                      valueStyle={{ color: token.colorInfo }}
                      prefix={<EyeOutlined />}
                    />
                  </Card>
                </Col>
                <Col span={6}>
                  <Card size="small">
                    <Statistic
                      title="触发器"
                      value={(objectsMap[activeDatabase] || []).filter((t) => t.type === 'trigger').length}
                      valueStyle={{ color: token.colorWarning }}
                      prefix={<ThunderboltOutlined />}
                    />
                  </Card>
                </Col>
                <Col span={6}>
                  <Card size="small">
                    <Statistic
                      title="对象总数"
                      value={(objectsMap[activeDatabase] || []).length}
                    />
                  </Card>
                </Col>
              </Row>

              {(objectsMap[activeDatabase] || []).length === 0 ? (
                <EmptyState description="当前数据库下无对象" />
              ) : (
                <Card size="small" title="快捷操作">
                  <Space>
                    <Button
                      icon={<CodeOutlined />}
                      onClick={() => openSqlEditor()}
                    >
                      打开 SQL 编辑器
                    </Button>
                    <Button icon={<ReloadOutlined />} onClick={() => loadTables(activeDatabase)}>
                      刷新对象列表
                    </Button>
                  </Space>
                </Card>
              )}
            </Space>
          </div>
        ) : (
          <EmptyState description="选择左侧对象树中的数据库或表以查看详情" />
        )}
      </Content>
    </Layout>
  )
}
