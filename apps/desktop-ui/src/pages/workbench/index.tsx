import React, { useEffect, useState, useCallback } from 'react'
import {
  Layout, Tree, Tabs, Table, Typography, Input, Space, Button, Tag, Tooltip, Select,
  theme, Card, Statistic, Row, Col,
} from 'antd'
import {
  DatabaseOutlined, TableOutlined, EyeOutlined,
  SearchOutlined, CodeOutlined, ThunderboltOutlined, ReloadOutlined,
  ApiOutlined, CloseOutlined, PlusOutlined,
} from '@ant-design/icons'
import type { DataNode } from 'antd/es/tree'
import type { DatabaseInfo, TableInfo, ColumnInfo, IndexInfo, ConnectionConfig } from '@/types'
import { useWorkbenchStore } from '@/stores/workbenchStore'
import { useConnectionStore } from '@/stores/connectionStore'
import { useSqlEditorStore } from '@/stores/sqlEditorStore'
import { metadataApi, connectionApi } from '@/services/api'
import { handleApiError, toast } from '@/utils/notification'
import { EmptyState } from '@/components/EmptyState'
import { EditableDataTable } from '@/components/EditableDataTable'
import { useNavigate } from 'react-router-dom'

const { Sider, Content } = Layout
const { Text } = Typography

export const WorkbenchPage: React.FC = () => {
  const { token } = theme.useToken()
  const navigate = useNavigate()

  // --- Store（持久化状态，路由切换不丢失） ---
  const openConnections = useWorkbenchStore((s) => s.openConnections)
  const addOpenConnection = useWorkbenchStore((s) => s.addOpenConnection)
  const removeOpenConnection = useWorkbenchStore((s) => s.removeOpenConnection)
  const setActiveConnection = useWorkbenchStore((s) => s.setActiveConnection)
  const setActiveDatabase = useWorkbenchStore((s) => s.setActiveDatabase)
  const setActiveTable = useWorkbenchStore((s) => s.setActiveTable)
  const databasesMap = useWorkbenchStore((s) => s.databasesMap)
  const setDatabasesMap = useWorkbenchStore((s) => s.setDatabasesMap)
  const objectsMap = useWorkbenchStore((s) => s.objectsMap)
  const setObjectsMap = useWorkbenchStore((s) => s.setObjectsMap)
  const expandedKeys = useWorkbenchStore((s) => s.treeExpandedKeys)
  const setExpandedKeys = useWorkbenchStore((s) => s.setTreeExpandedKeys)
  const selectedCtx = useWorkbenchStore((s) => s.selectedCtx)
  const setSelectedCtx = useWorkbenchStore((s) => s.setSelectedCtx)

  const connections = useConnectionStore((s) => s.connections)
  const setConnections = useConnectionStore((s) => s.setConnections)
  const updateConnection = useConnectionStore((s) => s.updateConnection)

  // --- Local state（页面级临时状态）---
  const [columns, setColumns] = useState<ColumnInfo[]>([])
  const [indexes, setIndexes] = useState<IndexInfo[]>([])
  const [ddl, setDdl] = useState('')
  const [previewRows, setPreviewRows] = useState<Record<string, unknown>[]>([])
  const [loadingConns, setLoadingConns] = useState<Set<string>>(new Set())
  const [searchText, setSearchText] = useState('')

  const setPendingSql = useSqlEditorStore((s) => s.setPendingSql)

  // --- 自动加载连接列表 ---
  useEffect(() => {
    if (connections.length === 0) {
      connectionApi.list().then((list) => {
        setConnections(list as ConnectionConfig[])
      }).catch(() => {})
    }
  }, [connections.length, setConnections])

  // --- 加载某个连接的数据库列表 ---
  const loadDatabases = useCallback(async (connId: string) => {
    setLoadingConns((prev) => new Set(prev).add(connId))
    try {
      const dbs = await metadataApi.databases(connId) as DatabaseInfo[]
      setDatabasesMap((prev) => ({ ...prev, [connId]: dbs }))
    } catch (e) {
      handleApiError(e, '加载数据库列表失败')
    } finally {
      setLoadingConns((prev) => {
        const next = new Set(prev)
        next.delete(connId)
        return next
      })
    }
  }, [setDatabasesMap])

  // 当 openConnections 变化时，自动加载新增连接的数据库列表
  useEffect(() => {
    for (const conn of openConnections) {
      if (!databasesMap[conn.id]) {
        loadDatabases(conn.id)
      }
    }
  }, [openConnections, databasesMap, loadDatabases])

  // --- 加载某库下的对象列表 ---
  const loadTables = useCallback(async (connId: string, dbName: string) => {
    const key = `${connId}::${dbName}`
    try {
      const tbls = await metadataApi.objects(connId, dbName) as TableInfo[]
      setObjectsMap((prev) => ({ ...prev, [key]: tbls }))
    } catch (e) {
      handleApiError(e, '加载对象列表失败')
    }
  }, [setObjectsMap])

  // --- 加载表详情 ---
  const loadTableDetail = useCallback(async (connId: string, dbName: string, tableName: string) => {
    try {
      const [def, idxs, rows, ddlStr] = await Promise.all([
        metadataApi.tableDefinition(connId, dbName, tableName) as Promise<{ columns: ColumnInfo[] }>,
        metadataApi.indexes(connId, dbName, tableName) as Promise<IndexInfo[]>,
        metadataApi.previewRows(connId, dbName, tableName) as Promise<Record<string, unknown>[]>,
        metadataApi.ddl(connId, dbName, tableName) as Promise<string>,
      ])
      setColumns(def.columns || [])
      setIndexes(idxs)
      setPreviewRows(rows)
      setDdl(ddlStr)
    } catch (e) {
      handleApiError(e, '加载表详情失败')
    }
  }, [])

  // --- 添加连接到工作台 ---
  const handleAddConnection = useCallback(async (connId: string) => {
    const conn = connections.find((c) => c.id === connId)
    if (!conn) return

    // 未连接的自动连接
    if (conn.status !== 'connected') {
      try {
        await connectionApi.open(conn.id)
        updateConnection(conn.id, { status: 'connected' })
        toast.success(`已连接到「${conn.name}」`)
      } catch (e) {
        handleApiError(e, '连接失败')
        return
      }
    }
    addOpenConnection(conn.id, conn.name)
  }, [connections, updateConnection, addOpenConnection])

  // --- 从工作台移除连接 ---
  const handleRemoveConnection = useCallback((connId: string) => {
    // store 的 removeOpenConnection 会自动清理 databasesMap、objectsMap、expandedKeys、selectedCtx
    const wasCurrent = selectedCtx?.connectionId === connId
    removeOpenConnection(connId)
    if (wasCurrent) {
      setColumns([])
      setIndexes([])
      setDdl('')
      setPreviewRows([])
    }
  }, [removeOpenConnection, selectedCtx])

  // --- 打开 SQL 编辑器 ---
  const openSqlEditor = useCallback(() => {
    const connId = selectedCtx?.connectionId ?? undefined
    const db = selectedCtx?.database ?? undefined
    setPendingSql('', connId, db)
    navigate('/sql-editor')
  }, [selectedCtx, navigate, setPendingSql])

  // --- 对象分类 ---
  const objectCategories: { key: string; label: string; types: string[]; icon: React.ReactNode }[] = [
    { key: 'tables', label: '表', types: ['table'], icon: <TableOutlined /> },
    { key: 'views', label: '视图', types: ['view'], icon: <EyeOutlined /> },
    { key: 'triggers', label: '触发器', types: ['trigger'], icon: <ThunderboltOutlined /> },
  ]

  // --- 构建多连接对象树 ---
  // key 编码规则：
  //   连接节点: "conn:{connId}"
  //   数据库节点: "db:{connId}:{dbName}"
  //   分类节点: "cat:{connId}:{dbName}:{catKey}"
  //   对象节点: "obj:{connId}:{dbName}:{objName}"

  const treeData: DataNode[] = openConnections.map((conn) => {
    const connDbs = databasesMap[conn.id] || []
    const isLoading = loadingConns.has(conn.id)

    const dbChildren: DataNode[] = connDbs
      .filter((db) => !searchText || db.name.toLowerCase().includes(searchText.toLowerCase()))
      .map((db) => {
        const objKey = `${conn.id}::${db.name}`
        const dbObjects = objectsMap[objKey] || []

        const categoryChildren: DataNode[] = objectCategories
          .map((cat) => {
            const items = dbObjects.filter(
              (t) => cat.types.includes(t.type)
                && (!searchText || t.name.toLowerCase().includes(searchText.toLowerCase()))
            )
            return {
              key: `cat:${conn.id}:${db.name}:${cat.key}`,
              title: `${cat.label} (${items.length})`,
              icon: cat.icon,
              selectable: false,
              children: items.map((t) => ({
                key: `obj:${conn.id}:${db.name}:${t.name}`,
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
          .filter((cat) => !searchText || (cat.children && cat.children.length > 0))

        return {
          key: `db:${conn.id}:${db.name}`,
          title: db.name,
          icon: <DatabaseOutlined />,
          children: categoryChildren,
        } as DataNode
      })

    return {
      key: `conn:${conn.id}`,
      title: (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', paddingRight: 4 }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
            {conn.name}
          </span>
          <Tooltip title="从工作台移除">
            <CloseOutlined
              style={{ fontSize: 11, color: token.colorTextQuaternary, flexShrink: 0, marginLeft: 4 }}
              onClick={(e) => {
                e.stopPropagation()
                handleRemoveConnection(conn.id)
              }}
            />
          </Tooltip>
        </div>
      ),
      icon: <ApiOutlined style={{ color: token.colorPrimary }} />,
      children: isLoading ? [{ key: `loading:${conn.id}`, title: '加载中...', isLeaf: true, selectable: false }] : dbChildren,
    } as DataNode
  })

  // --- 树节点选中 ---
  const handleTreeSelect = (_: React.Key[], info: { node: DataNode }) => {
    const key = String(info.node.key)

    if (key.startsWith('conn:')) {
      // 选中连接节点
      const connId = key.slice(5)
      const conn = openConnections.find((c) => c.id === connId)
      setSelectedCtx({ connectionId: connId })
      setActiveConnection(connId, conn?.name ?? null)
      setColumns([])
      setIndexes([])
      setDdl('')
      setPreviewRows([])
    } else if (key.startsWith('db:')) {
      // 选中数据库节点: "db:{connId}:{dbName}"
      const parts = key.slice(3).split(':')
      const connId = parts[0]
      const dbName = parts.slice(1).join(':')
      const conn = openConnections.find((c) => c.id === connId)
      setSelectedCtx({ connectionId: connId, database: dbName })
      setActiveConnection(connId, conn?.name ?? null)
      setActiveDatabase(dbName)
      loadTables(connId, dbName)
      setColumns([])
      setIndexes([])
      setDdl('')
      setPreviewRows([])
    } else if (key.startsWith('obj:')) {
      // 选中对象节点: "obj:{connId}:{dbName}:{objName}"
      const parts = key.slice(4).split(':')
      const connId = parts[0]
      const dbName = parts[1]
      const objName = parts.slice(2).join(':')
      const conn = openConnections.find((c) => c.id === connId)
      setSelectedCtx({ connectionId: connId, database: dbName, table: objName })
      setActiveConnection(connId, conn?.name ?? null)
      setActiveDatabase(dbName)
      setActiveTable(objName)
      loadTableDetail(connId, dbName, objName)
    }
    // cat: 分类节点不做选中
  }

  // --- 树节点展开 ---
  const handleTreeExpand = (keys: React.Key[], info: { node: DataNode; expanded: boolean }) => {
    setExpandedKeys(keys)
    const key = String(info.node.key)
    if (info.expanded) {
      if (key.startsWith('conn:')) {
        // 展开连接节点时加载数据库列表
        const connId = key.slice(5)
        if (!databasesMap[connId]) {
          loadDatabases(connId)
        }
      } else if (key.startsWith('db:')) {
        // 展开数据库节点时加载表列表
        const parts = key.slice(3).split(':')
        const connId = parts[0]
        const dbName = parts.slice(1).join(':')
        const objKey = `${connId}::${dbName}`
        if (!objectsMap[objKey]) {
          loadTables(connId, dbName)
        }
      }
    }
  }

  // 可添加的连接列表（排除已在工作台中的）
  const availableConnections = connections.filter(
    (c) => !openConnections.some((o) => o.id === c.id)
  )

  // --- 表结构列定义 ---
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

  // 当前选中节点的 tree key
  const selectedTreeKeys: React.Key[] = selectedCtx
    ? (selectedCtx.table && selectedCtx.database
      ? [`obj:${selectedCtx.connectionId}:${selectedCtx.database}:${selectedCtx.table}`]
      : selectedCtx.database
        ? [`db:${selectedCtx.connectionId}:${selectedCtx.database}`]
        : [`conn:${selectedCtx.connectionId}`]
    )
    : []

  return (
    <Layout style={{ height: '100%' }}>
      {/* 左侧对象树 */}
      <Sider
        width={280}
        style={{
          background: token.colorBgContainer,
          borderRight: `1px solid ${token.colorBorderSecondary}`,
          overflow: 'auto',
          display: 'flex',
          flexDirection: 'column',
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
            max-width: calc(100% - 24px);
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
            <div style={{ display: 'flex', gap: 6 }}>
              <Select
                size="small"
                style={{ flex: 1 }}
                placeholder="添加连接..."
                value={undefined}
                onChange={handleAddConnection}
                options={availableConnections.map((c) => ({
                  label: (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                      {c.status !== 'connected' && (
                        <span style={{ fontSize: 11, color: token.colorTextQuaternary, marginLeft: 4, flexShrink: 0 }}>未连接</span>
                      )}
                    </div>
                  ),
                  value: c.id,
                }))}
                listHeight={320}
                suffixIcon={<PlusOutlined />}
                notFoundContent={<Text type="secondary" style={{ fontSize: 12 }}>所有连接已添加</Text>}
              />
            </div>
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
        <div style={{ flex: 1, overflow: 'auto' }}>
          {openConnections.length === 0 ? (
            <div style={{ padding: '24px 12px', textAlign: 'center' }}>
              <Text type="secondary" style={{ fontSize: 13 }}>
                从上方下拉框添加连接
              </Text>
            </div>
          ) : (
            <Tree
              className="workbench-object-tree"
              treeData={treeData}
              showIcon
              blockNode
              onSelect={handleTreeSelect}
              selectedKeys={selectedTreeKeys}
              expandedKeys={expandedKeys}
              onExpand={handleTreeExpand}
            />
          )}
        </div>
      </Sider>

      {/* 右侧详情区 */}
      <Content style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', background: token.colorBgLayout }}>
        {selectedCtx?.table && selectedCtx?.database ? (
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
                  {selectedCtx.database}.{selectedCtx.table}
                </Text>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  ({openConnections.find((c) => c.id === selectedCtx.connectionId)?.name})
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

            {/* Tabs */}
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
                      {selectedCtx.connectionId && selectedCtx.database && selectedCtx.table ? (
                        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
                          <EditableDataTable
                            connectionId={selectedCtx.connectionId}
                            database={selectedCtx.database}
                            tableName={selectedCtx.table}
                            columns={columns}
                            dataSource={previewRows}
                            onRefresh={() => loadTableDetail(selectedCtx.connectionId, selectedCtx.database!, selectedCtx.table!)}
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
        ) : selectedCtx?.database ? (
          /* 数据库级概览 */
          <div style={{ padding: 24 }}>
            <Space direction="vertical" size={16} style={{ width: '100%' }}>
              <Space>
                <Text strong style={{ fontSize: 16 }}>
                  <DatabaseOutlined style={{ marginRight: 6 }} />
                  {selectedCtx.database}
                </Text>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  ({openConnections.find((c) => c.id === selectedCtx.connectionId)?.name})
                </Text>
                <Button
                  size="small"
                  icon={<CodeOutlined />}
                  onClick={() => openSqlEditor()}
                >
                  打开 SQL 编辑器
                </Button>
              </Space>

              {(() => {
                const objKey = `${selectedCtx.connectionId}::${selectedCtx.database}`
                const dbObjects = objectsMap[objKey] || []
                return (
                  <>
                    <Row gutter={16}>
                      <Col span={6}>
                        <Card size="small">
                          <Statistic
                            title="表"
                            value={dbObjects.filter((t) => t.type === 'table').length}
                            valueStyle={{ color: token.colorPrimary }}
                            prefix={<TableOutlined />}
                          />
                        </Card>
                      </Col>
                      <Col span={6}>
                        <Card size="small">
                          <Statistic
                            title="视图"
                            value={dbObjects.filter((t) => t.type === 'view').length}
                            valueStyle={{ color: token.colorInfo }}
                            prefix={<EyeOutlined />}
                          />
                        </Card>
                      </Col>
                      <Col span={6}>
                        <Card size="small">
                          <Statistic
                            title="触发器"
                            value={dbObjects.filter((t) => t.type === 'trigger').length}
                            valueStyle={{ color: token.colorWarning }}
                            prefix={<ThunderboltOutlined />}
                          />
                        </Card>
                      </Col>
                      <Col span={6}>
                        <Card size="small">
                          <Statistic
                            title="对象总数"
                            value={dbObjects.length}
                          />
                        </Card>
                      </Col>
                    </Row>

                    {dbObjects.length === 0 ? (
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
                          <Button icon={<ReloadOutlined />} onClick={() => loadTables(selectedCtx.connectionId, selectedCtx.database!)}>
                            刷新对象列表
                          </Button>
                        </Space>
                      </Card>
                    )}
                  </>
                )
              })()}
            </Space>
          </div>
        ) : (
          <EmptyState description={openConnections.length === 0 ? '从左侧添加连接开始浏览' : '选择左侧对象树中的数据库或表以查看详情'} />
        )}
      </Content>
    </Layout>
  )
}
